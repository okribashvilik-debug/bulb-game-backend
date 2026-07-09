/**
 * One independent, continuously-running game session for a single
 * bulb-count mode (5, 7, or 10). Owns a real BulbGameEngine — the exact
 * same server-authoritative state machine built earlier in this project,
 * running here with the real wall-clock `defaultClock`, not a UI-driven
 * one. This is the entire point of requirement 1/2: cycle generation,
 * timing, and outcome determination happen ONLY here, and keep running
 * whether or not any client is currently connected — a session is
 * created once at server boot and never torn down until the process
 * exits (see sessionManager.ts / index.ts).
 *
 * Every connected client for this mode gets the exact same broadcasts at
 * the exact same time (see broadcastEvent/broadcastSnapshot) — there is
 * no per-client polling or per-client timer driving game logic.
 */
import type { WebSocket } from 'ws';
import { BulbGameEngine, type BulbCount, type BulbGameEvents, type CycleSnapshot, type Player } from '../../src/index';
import { placeBet as placeBetRpc, resolveBet, voidBet, InsufficientBalanceError } from '../db/betsRepo';
import { markBettingClosed, markCycleCancelled, markCycleComplete, insertCycle } from '../db/cyclesRepo';
import { insertLiveBetEvent } from '../db/liveBetsRepo';
import { getPlayerBalance } from '../db/playersRepo';
import { BotController } from './bots';

const AUTO_RESTART_DELAY_MS = 4_500;
/** An uncontested/cancelled cycle has nothing to linger on (no winner to
 *  show) — "immediately open a new betting window" gets a much shorter
 *  pause than a normal cycle_complete, just enough for refunds to land. */
const CANCELLED_RESTART_DELAY_MS = 500;

/** Events broadcast verbatim to clients as `{type:'event', event, payload}`.
 *  'stateChange' is handled separately, as a dedicated `snapshot` message —
 *  see broadcastSnapshot. */
const BROADCAST_EVENT_NAMES = [
  'betPlaced',
  'calculatingStarted',
  'cycleCancelled',
  'roundStarted',
  'bulbPopped',
  'decisionWindowStarted',
  'playerCashedOut',
  'playerContinued',
  'cycleComplete',
] as const satisfies ReadonlyArray<keyof BulbGameEvents>;

export type ActionResult = { ok: true } | { ok: false; error: string };

export class GameSession {
  readonly mode: BulbCount;
  private readonly engine: BulbGameEngine;
  private readonly subscribers = new Set<WebSocket>();
  /** Sockets grouped by player id (a player can have more than one tab
   *  open) — used only for targeted `balance` pushes, which must go to
   *  that specific player, never broadcast to everyone watching this mode. */
  private readonly socketsByPlayerId = new Map<string, Set<WebSocket>>();

  private currentCycleDbId: string | null = null;
  /** False in the brief window between engine.startCycle() (synchronous,
   *  opens betting immediately) and the cycles-table insert resolving.
   *  placeBet() checks this so a bet can never be attributed to the wrong
   *  cycle id — see the class-level note in startNewCycle(). */
  private cycleReady = false;
  private betDbIdByPlayerId = new Map<string, string>();
  private displayNameByPlayerId = new Map<string, string>();
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly bots: BotController;

  constructor(mode: BulbCount) {
    this.mode = mode;
    this.engine = new BulbGameEngine();
    this.bots = new BotController(this.engine);

    this.engine.on('stateChange', ({ snapshot }) => this.broadcastSnapshot(snapshot));
    for (const eventName of BROADCAST_EVENT_NAMES) {
      this.engine.on(eventName, (payload) => this.broadcastEvent(eventName, payload));
    }

    // 'calculatingStarted' fires exactly once, the instant betting closes —
    // stakes are locked from this point, so this is the moment to persist
    // that the window is shut (replaces the old round===1 inference, which
    // no longer holds now that 'calculating' sits between betting and the
    // first round).
    this.engine.on('calculatingStarted', () => void this.handleBettingClosed());
    this.engine.on('cycleCancelled', (payload) => void this.handleCycleCancelled(payload));
    this.engine.on('bulbPopped', (payload) => void this.handleBulbPopped(payload));
    this.engine.on('playerCashedOut', (payload) => void this.handlePlayerCashedOut(payload));
    this.engine.on('cycleComplete', (payload) => void this.handleCycleComplete(payload));
    // Bots skip placeBet() entirely (no real balance to debit) — this is
    // the only place their bet placement ever reaches the live_bets feed.
    this.engine.on('betPlaced', ({ player }) => {
      if (this.bots.isBot(player.id)) void this.handleBotBetPlaced(player);
    });
  }

  /** Boots this session's first cycle. Called once per mode, at server
   *  startup — see sessionManager.ts. */
  async start(): Promise<void> {
    await this.startNewCycle();
  }

  /** Stops the underlying engine's timer (no more transitions) without
   *  disconnecting clients — index.ts's SIGTERM handler closes the actual
   *  WebSocket connections separately, after giving them a chance to
   *  receive a shutdown notice. */
  shutdown(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.bots.dispose();
    this.engine.stop();
  }

  // -----------------------------------------------------------------
  // Subscriptions
  // -----------------------------------------------------------------

  subscribe(socket: WebSocket, playerId: string): void {
    this.subscribers.add(socket);
    const sockets = this.socketsByPlayerId.get(playerId) ?? new Set();
    sockets.add(socket);
    this.socketsByPlayerId.set(playerId, sockets);
  }

  unsubscribe(socket: WebSocket, playerId: string): void {
    this.subscribers.delete(socket);
    const sockets = this.socketsByPlayerId.get(playerId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.socketsByPlayerId.delete(playerId);
  }

  getSnapshot(): CycleSnapshot {
    return this.engine.getSnapshot();
  }

  /** The DB id of the caller's own bet in the CURRENT cycle, if any — for
   *  the `snapshot` message's `yourBetId`, so a reconnecting client can be
   *  told about an in-progress bet immediately (the snapshot's own
   *  `players` array already carries the same information keyed by this
   *  same id, since engine player ids ARE Supabase player ids here). */
  getBetDbId(playerId: string): string | undefined {
    return this.betDbIdByPlayerId.get(playerId);
  }

  // -----------------------------------------------------------------
  // Player actions — called from the WS connection handler
  // -----------------------------------------------------------------

  async placeBet(playerId: string, displayName: string, bulbId: string, stake: number): Promise<ActionResult> {
    if (!this.cycleReady || !this.currentCycleDbId) {
      return { ok: false, error: 'Session is still starting up — try again in a moment.' };
    }

    const snapshot = this.engine.getSnapshot();
    if (snapshot.state !== 'betting') return { ok: false, error: 'Betting window is closed.' };
    if (!Number.isFinite(stake) || stake <= 0) return { ok: false, error: 'Stake must be greater than 0.' };
    if (!snapshot.bulbs.some((b) => b.id === bulbId)) return { ok: false, error: 'Unknown bulb.' };
    if (snapshot.players.some((p) => p.id === playerId)) {
      return { ok: false, error: 'You already placed a bet this cycle.' };
    }

    let betRow;
    try {
      betRow = await placeBetRpc({
        playerId,
        cycleId: this.currentCycleDbId,
        mode: this.mode,
        bulbId,
        stake,
        round: 0,
      });
    } catch (err) {
      if (err instanceof InsufficientBalanceError) return { ok: false, error: 'Insufficient balance.' };
      this.logError('placeBet RPC', err);
      return { ok: false, error: 'Could not place bet — please try again.' };
    }

    try {
      this.engine.placeBet(playerId, bulbId, stake);
    } catch (err) {
      // Extremely rare race: the DB accepted the bet (balance already
      // debited) but the in-memory engine rejected it — most likely the
      // betting window closed in the round-trip to Supabase. Roll back so
      // balance/bets stay consistent with the actual, authoritative state.
      await voidBet(betRow.id).catch((voidErr) => this.logError('voidBet', voidErr));
      this.logError('engine.placeBet after DB accept', err);
      return { ok: false, error: 'Betting window closed just now — try the next cycle.' };
    }

    this.betDbIdByPlayerId.set(playerId, betRow.id);
    this.displayNameByPlayerId.set(playerId, displayName);

    insertLiveBetEvent({
      cycleId: this.currentCycleDbId,
      mode: this.mode,
      playerId,
      displayName,
      bulbId,
      stake,
      payout: null,
      eventType: 'bet_placed',
    }).catch((err) => this.logError('insertLiveBetEvent(bet_placed)', err));

    void this.sendBalanceUpdate(playerId);

    return { ok: true };
  }

  cashOut(playerId: string): ActionResult {
    try {
      this.engine.cashOut(playerId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not cash out.' };
    }
  }

  continuePlaying(playerId: string): ActionResult {
    try {
      this.engine.continuePlaying(playerId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not continue.' };
    }
  }

  // -----------------------------------------------------------------
  // Cycle lifecycle
  // -----------------------------------------------------------------

  private async startNewCycle(): Promise<void> {
    if (this.stopped) return;
    this.cycleReady = false;
    this.betDbIdByPlayerId = new Map();
    this.displayNameByPlayerId = new Map();

    // Synchronous: seals the winner + full elimination order and opens
    // betting immediately (see BulbGameEngine.startCycle). The
    // stateChange listener above has already broadcast the fresh
    // 'betting' snapshot to clients by the time this call returns.
    this.engine.startCycle(this.mode);

    const audit = this.engine.getAuditRecord();
    if (!audit) {
      this.logError('startNewCycle', new Error('getAuditRecord() returned undefined right after startCycle()'));
      return;
    }

    try {
      const cycleRow = await insertCycle(audit, this.mode - 1);
      this.currentCycleDbId = cycleRow.id;
      this.cycleReady = true;
    } catch (err) {
      this.logError('insertCycle', err);
      // Leave cycleReady=false — placeBet() will keep declining with a
      // "try again" error until this resolves or the cycle naturally
      // completes and the next one gets a fresh chance. The engine itself
      // is completely unaffected: rounds and pops keep happening on
      // schedule even if Supabase is unreachable.
    }
  }

  private async handleBettingClosed(): Promise<void> {
    if (!this.currentCycleDbId) return;
    try {
      await markBettingClosed(this.currentCycleDbId);
    } catch (err) {
      this.logError('markBettingClosed', err);
    }
  }

  /** A bot placed a bet — real pari-mutuel pool money as far as the engine
   *  is concerned, but no real player to debit, so this is the only write
   *  it ever gets: a feed row with a null player_id (the schema supports
   *  this — see live_bets in supabase/schema.sql) so the activity still
   *  shows up for anyone who joins or reloads after the fact. */
  private async handleBotBetPlaced(player: Player): Promise<void> {
    insertLiveBetEvent({
      cycleId: this.currentCycleDbId,
      mode: this.mode,
      playerId: null,
      displayName: player.id,
      bulbId: player.bulbId,
      stake: player.stake,
      payout: null,
      eventType: 'bet_placed',
    }).catch((err) => this.logError('insertLiveBetEvent(bot bet_placed)', err));
  }

  /** Uncontested round (fewer than 2 bulbs staked) — refund everyone in
   *  full, mark the cycle row cancelled, and start a fresh cycle almost
   *  immediately (see CANCELLED_RESTART_DELAY_MS). */
  private async handleCycleCancelled({ refundedPlayers }: BulbGameEvents['cycleCancelled']): Promise<void> {
    const cycleDbId = this.currentCycleDbId;
    const contestedBulbCount = this.engine.getAuditRecord()?.cancelled?.contestedBulbCount ?? 0;

    for (const player of refundedPlayers) {
      const betId = this.betDbIdByPlayerId.get(player.id);
      if (betId) {
        await voidBet(betId).catch((err) => this.logError('voidBet(cancelled)', err));
      }
      insertLiveBetEvent({
        cycleId: cycleDbId,
        mode: this.mode,
        playerId: this.bots.isBot(player.id) ? null : player.id,
        displayName: this.displayNameByPlayerId.get(player.id) ?? player.id,
        bulbId: player.bulbId,
        stake: player.stake,
        payout: player.stake, // full refund — shown the same as a payout in the feed
        eventType: 'cashed_out',
      }).catch((err) => this.logError('insertLiveBetEvent(cancelled)', err));

      await this.sendBalanceUpdate(player.id);
    }

    if (cycleDbId) {
      markCycleCancelled(cycleDbId, contestedBulbCount).catch((err) => this.logError('markCycleCancelled', err));
    }

    this.restartTimer = setTimeout(() => {
      if (this.stopped) return;
      if (this.engine.getState() === 'cycle_cancelled') void this.startNewCycle();
    }, CANCELLED_RESTART_DELAY_MS);
  }

  private async handleBulbPopped({ round, affectedPlayers }: BulbGameEvents['bulbPopped']): Promise<void> {
    for (const player of affectedPlayers) {
      const betId = this.betDbIdByPlayerId.get(player.id);
      if (betId) {
        resolveBet({ betId, outcome: 'popped', round, coefficient: null, payout: null }).catch((err) =>
          this.logError('resolveBet(popped)', err),
        );
      }
      insertLiveBetEvent({
        cycleId: this.currentCycleDbId,
        mode: this.mode,
        playerId: this.bots.isBot(player.id) ? null : player.id,
        displayName: this.displayNameByPlayerId.get(player.id) ?? player.id,
        bulbId: player.bulbId,
        stake: player.stake,
        payout: null,
        eventType: 'popped',
      }).catch((err) => this.logError('insertLiveBetEvent(popped)', err));
      // No balance change on a loss — stake was already debited at
      // placement time, nothing further to push.
    }
  }

  private async handlePlayerCashedOut({ player }: BulbGameEvents['playerCashedOut']): Promise<void> {
    const betId = this.betDbIdByPlayerId.get(player.id);
    const value = player.result?.value ?? 0;
    const round = player.result?.round ?? 0;
    const coefficient = player.stake > 0 ? value / player.stake : null;

    // Awaited (not fire-and-forget) — sendBalanceUpdate() below reads the
    // balance straight back from Postgres, and resolveBet() is what
    // credits it. Racing them was a real bug caught in testing: the
    // balance read could win the race and push the pre-credit value.
    if (betId) {
      try {
        await resolveBet({ betId, outcome: 'cashed_out', round, coefficient, payout: value });
      } catch (err) {
        this.logError('resolveBet(cashed_out)', err);
      }
    }
    insertLiveBetEvent({
      cycleId: this.currentCycleDbId,
      mode: this.mode,
      playerId: this.bots.isBot(player.id) ? null : player.id,
      displayName: this.displayNameByPlayerId.get(player.id) ?? player.id,
      bulbId: player.bulbId,
      stake: player.stake,
      payout: value,
      eventType: 'cashed_out',
    }).catch((err) => this.logError('insertLiveBetEvent(cashed_out)', err));

    await this.sendBalanceUpdate(player.id);
  }

  private async handleCycleComplete({ winners }: BulbGameEvents['cycleComplete']): Promise<void> {
    const cycleDbId = this.currentCycleDbId;
    const audit = this.engine.getAuditRecord();
    if (cycleDbId && audit) {
      markCycleComplete(cycleDbId, audit).catch((err) => this.logError('markCycleComplete', err));
    }

    const snapshot = this.engine.getSnapshot();
    for (const winner of winners) {
      const betId = this.betDbIdByPlayerId.get(winner.id);
      const value = winner.result?.value ?? 0;
      const round = winner.result?.round ?? 0;
      // Same live pari-mutuel coefficient the engine just paid the winner
      // with (see BulbGameEngine.endCycle) — no separate "fixed" formula.
      const coefficient = snapshot.liveCoefficients[winner.bulbId] ?? null;

      // Awaited, same reasoning as handlePlayerCashedOut: sendBalanceUpdate
      // must not run until the credit inside resolveBet has landed.
      if (betId) {
        try {
          await resolveBet({ betId, outcome: 'won', round, coefficient, payout: value });
        } catch (err) {
          this.logError('resolveBet(won)', err);
        }
      }
      insertLiveBetEvent({
        cycleId: cycleDbId,
        mode: this.mode,
        playerId: this.bots.isBot(winner.id) ? null : winner.id,
        displayName: this.displayNameByPlayerId.get(winner.id) ?? winner.id,
        bulbId: winner.bulbId,
        stake: winner.stake,
        payout: value,
        eventType: 'won',
      }).catch((err) => this.logError('insertLiveBetEvent(won)', err));

      await this.sendBalanceUpdate(winner.id);
    }

    this.restartTimer = setTimeout(() => {
      if (this.stopped) return;
      if (this.engine.getState() === 'cycle_complete') void this.startNewCycle();
    }, AUTO_RESTART_DELAY_MS);
  }

  // -----------------------------------------------------------------
  // Broadcast
  // -----------------------------------------------------------------

  private broadcastSnapshot(snapshot: CycleSnapshot): void {
    const message = JSON.stringify({
      type: 'snapshot',
      mode: this.mode,
      snapshot,
      serverTime: Date.now(),
    });
    this.sendToAll(message);
  }

  private broadcastEvent<K extends (typeof BROADCAST_EVENT_NAMES)[number]>(event: K, payload: BulbGameEvents[K]): void {
    const message = JSON.stringify({
      type: 'event',
      mode: this.mode,
      event,
      payload,
      serverTime: Date.now(),
    });
    this.sendToAll(message);
  }

  /** Pushes a fresh balance to every socket THIS specific player has open
   *  for this mode — never broadcast, balance is not public data. A
   *  no-op (besides the read) if the player isn't currently connected;
   *  they'll get the correct balance in their `welcome` message next time
   *  they join, since it's the source of truth in Postgres either way. */
  private async sendBalanceUpdate(playerId: string): Promise<void> {
    const sockets = this.socketsByPlayerId.get(playerId);
    if (!sockets || sockets.size === 0) return;

    let balance: number | null;
    try {
      balance = await getPlayerBalance(playerId);
    } catch (err) {
      this.logError('sendBalanceUpdate', err);
      return;
    }
    if (balance === null) return;

    const message = JSON.stringify({ type: 'balance', balance });
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(message);
    }
  }

  private sendToAll(message: string): void {
    for (const socket of this.subscribers) {
      if (socket.readyState === socket.OPEN) {
        socket.send(message);
      }
    }
  }

  private logError(context: string, err: unknown): void {
    console.error(`[GameSession mode=${this.mode}] ${context}:`, err);
  }
}
