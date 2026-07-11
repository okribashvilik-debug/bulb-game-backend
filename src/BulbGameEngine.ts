/**
 * BulbGameEngine — the game logic layer for "Bulb Game".
 *
 * This is an explicit state machine. Every state transition is a named
 * method (`closeBetting`, `finishCalculating`, `resolveRound`, ...) that
 * mutates state directly. Timers never touch state themselves — each timer
 * is a "safety cap" that simply calls the same transition method that an
 * explicit game event would call. A `generation` counter makes those safety
 * timers self-cancelling: if the phase has already advanced by the time a
 * stale timer fires, the call is a no-op.
 *
 * States (see GameState in ./types):
 *
 *   idle --startCycle--> betting --closeBetting--> calculating
 *     --finishCalculating (contested)--> round_active
 *     --resolveRound--> [round_active again]  (repeats bulbCount-1 times,
 *                        skipping straight to the next round unless the
 *                        alive count just hit a checkpoint — see
 *                        CHECKPOINTS_BY_BULB_COUNT below)
 *                     \-> decision_window --advanceToNextRound--> round_active
 *     --resolveRound (last alive bulb)--> cycle_complete --startCycle--> betting
 *
 *     --finishCalculating (uncontested, <2 bulbs staked)--> cycle_cancelled
 *       (refunded; the caller — GameSession — restarts a fresh cycle)
 *
 * No payout/odds math lives here — this class only talks to an
 * `OddsProvider` (see ./odds/PariMutuelEngine.ts), the swappable module that
 * owns the pari-mutuel model. `startCycle` asks it to decide the winner and
 * full elimination order up front (a fair, stake-independent shuffle —
 * nothing about the pool influences the outcome); every pop in
 * `resolveRound` just reveals the next step of that sealed order. Pricing
 * (who gets paid how much) is a completely separate concern, computed live
 * from real stakes only once betting has closed — see
 * `computeLiveCoefficients` below.
 *
 * Every phase duration is a fixed constant (BETTING_WINDOW_MS,
 * CALCULATING_WINDOW_MS, ROUND_DURATION_MS, CASHOUT_WINDOW_MS below) — no
 * randomized ranges. All randomness for a cycle's *outcome* (not its
 * pricing) lives in the odds provider (see startCycle).
 */

import { isCashOutCheckpoint } from './checkpoints';
import { defaultClock, type Clock, type TimerHandle } from './clock';
import { TinyEmitter, type BulbGameEvents } from './events';
import { computeEliminatedPool, computeHouseTake, totalStakeByBulbId } from './odds/parimutuel';
import { PariMutuelEngine, type OddsProvider } from './odds/PariMutuelEngine';
import type { CycleOutcomePlan } from './odds/outcomePlan';
import type {
  Bulb,
  BulbCount,
  CycleAuditRecord,
  CycleSnapshot,
  CycleTimings,
  GameState,
  HouseTakeBreakdown,
  Player,
  RoundPoolRecord,
} from './types';

const ALLOWED_BULB_COUNTS: BulbCount[] = [5, 7, 10];

/** Named, fixed pacing constants — retune the game's feel by editing these
 *  values only, never by touching state-machine logic. */
const BETTING_WINDOW_MS = 10_000;
/** Betting has closed and stakes are locked; odds are computed but not yet
 *  revealed — a fixed pause so "no coefficient can be shown before betting
 *  closes" (nothing to price yet) reads as a deliberate beat, not a glitch. */
const CALCULATING_WINDOW_MS = 3_000;
const ROUND_DURATION_MS = 5_000;
const CASHOUT_WINDOW_MS = 5_000;

const DEFAULT_TIMINGS: CycleTimings = {
  bettingWindowMs: BETTING_WINDOW_MS,
  roundDurationMs: ROUND_DURATION_MS,
  decisionWindowMs: CASHOUT_WINDOW_MS,
};

export interface BulbGameEngineOptions {
  clock?: Clock;
  timings?: Partial<CycleTimings>;
  /** Defaults to a PariMutuelEngine with default odds config. Injectable so
   *  the whole odds model can be swapped, or a scripted one used in tests. */
  oddsProvider?: OddsProvider;
}

let cycleCounter = 0;
function nextCycleId(): string {
  cycleCounter += 1;
  return `cycle_${Date.now().toString(36)}_${cycleCounter}`;
}

function mapToRecord(map: Map<string, number> | undefined): Record<string, number> {
  return map ? Object.fromEntries(map) : {};
}

export class BulbGameEngine extends TinyEmitter<BulbGameEvents> {
  private readonly clock: Clock;
  private readonly timings: CycleTimings;
  private readonly oddsProvider: OddsProvider;

  private state: GameState = 'idle';
  private cycleId = '';
  private bulbCount: BulbCount = 5;
  private bulbs: Bulb[] = [];
  private players: Player[] = [];
  private currentRound = 0;
  private totalRounds = 0;
  private winningBulbId: string | undefined;

  /** Winner + full elimination order, decided synchronously before betting
   *  even opens — see PariMutuelEngine.planOutcome(). resolveRound() only
   *  ever reveals the next elimination-order entry, never generates one. */
  private outcome: CycleOutcomePlan | undefined;

  /** Total stake per bulb, locked the instant betting closes (start of the
   *  'calculating' phase) — the audit-trail record of exactly what every
   *  round's pricing was computed from. Undefined until then. */
  private finalStakeByBulbId: Map<string, number> | undefined;
  /** One entry per round resolved so far this cycle — see RoundPoolRecord. */
  private roundPoolHistory: RoundPoolRecord[] = [];
  /** Set only when finishCalculating() finds the round uncontested. */
  private cancelledInfo: CycleAuditRecord['cancelled'];
  /** Set only once endCycle() runs with an actual winner — see
   *  computeHouseTake(). Undefined for a cancelled cycle (full refund). */
  private houseTake: HouseTakeBreakdown | undefined;

  /** Player ids that have made an explicit decision (cash out or continue)
   *  in the current decision window — lets that window end the instant
   *  everyone has decided, instead of always waiting out the full timer. */
  private decidedPlayerIds = new Set<string>();

  /** Bumped on every transition; scheduled safety timers capture the
   *  generation they were created in and no-op if it has since changed. */
  private generation = 0;
  private pendingTimer: TimerHandle | undefined;
  /** Wall-clock deadline/duration for the current timed phase, if any —
   *  set alongside pendingTimer, cleared alongside it. Exposed via
   *  getSnapshot() purely for UI countdowns; the engine itself only ever
   *  drives transitions off pendingTimer + generation, never off these. */
  private phaseDeadlineAt: number | undefined;
  private phaseDurationMs: number | undefined;

  constructor(options: BulbGameEngineOptions = {}) {
    super();
    this.clock = options.clock ?? defaultClock;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.oddsProvider = options.oddsProvider ?? new PariMutuelEngine();
  }

  // ---------------------------------------------------------------------
  // Public read API
  // ---------------------------------------------------------------------

  getState(): GameState {
    return this.state;
  }

  /** Cancels any pending safety timer and returns the engine to 'idle', so
   *  it's safe to startCycle() again afterward. Not part of normal
   *  gameplay — for host/UI teardown (unmount, React StrictMode's dev-mode
   *  double-mount) so a discarded engine instance doesn't keep ticking in
   *  the background. Deliberately does not emit 'stateChange' — this is
   *  out-of-band teardown, not a game transition any listener should react to. */
  stop(): void {
    this.clearSafetyTimer();
    this.generation += 1;
    this.state = 'idle';
  }

  getSnapshot(): CycleSnapshot {
    return {
      cycleId: this.cycleId,
      state: this.state,
      bulbCount: this.bulbCount,
      timings: this.timings,
      bulbs: this.bulbs.map((b) => ({ ...b })),
      players: this.players.map((p) => ({ ...p })),
      currentRound: this.currentRound,
      totalRounds: this.totalRounds,
      winningBulbId: this.winningBulbId,
      liveCoefficients: mapToRecord(this.computeLiveCoefficients()),
      phaseDeadlineAt: this.phaseDeadlineAt,
      phaseDurationMs: this.phaseDurationMs,
    };
  }

  /**
   * Full audit record for the current cycle, INCLUDING the elimination
   * order — deliberately absent from getSnapshot()/CycleSnapshot, since
   * broadcasting the future pop sequence to clients would break the
   * game's core integrity guarantee. This method exists for a server-side
   * caller to persist to an audit trail (e.g. Supabase); its distinct name
   * and return type are the boundary — never forward this value to a client.
   */
  getAuditRecord(): CycleAuditRecord | undefined {
    if (!this.outcome) return undefined;
    return {
      cycleId: this.cycleId,
      bulbCount: this.bulbCount,
      winningBulbId: this.outcome.winningBulbId,
      eliminationOrder: [...this.outcome.eliminationOrder],
      finalStakeByBulbId: mapToRecord(this.finalStakeByBulbId),
      houseCutRate: this.oddsProvider.houseCutRate,
      roundPoolHistory: this.roundPoolHistory.map((r) => ({ ...r })),
      cancelled: this.cancelledInfo,
      houseTake: this.houseTake ? { ...this.houseTake } : undefined,
    };
  }

  /** Live pari-mutuel coefficients for currently-alive, currently-staked
   *  bulbs — see odds/parimutuel.ts. Nothing can be priced until stakes
   *  are final, so this is empty before the 'calculating' phase finishes. */
  private computeLiveCoefficients(): Map<string, number> {
    if (this.state === 'idle' || this.state === 'betting' || this.state === 'calculating') {
      return new Map();
    }
    return this.oddsProvider.liveCoefficients(this.bulbs, this.players);
  }

  // ---------------------------------------------------------------------
  // Transition: idle | cycle_complete | cycle_cancelled -> betting
  // ---------------------------------------------------------------------

  startCycle(bulbCount: BulbCount): void {
    if (this.state !== 'idle' && this.state !== 'cycle_complete' && this.state !== 'cycle_cancelled') {
      throw new Error(`Cannot start a new cycle while state is "${this.state}"`);
    }
    if (!ALLOWED_BULB_COUNTS.includes(bulbCount)) {
      throw new Error(`bulbCount must be one of ${ALLOWED_BULB_COUNTS.join(', ')}, got ${bulbCount}`);
    }

    this.cycleId = nextCycleId();
    this.bulbCount = bulbCount;
    this.bulbs = Array.from({ length: bulbCount }, (_, i) => ({
      id: `bulb_${i + 1}`,
      status: 'alive' as const,
    }));
    this.players = [];
    this.currentRound = 0;
    this.totalRounds = bulbCount - 1;
    this.winningBulbId = undefined;
    this.finalStakeByBulbId = undefined;
    this.roundPoolHistory = [];
    this.cancelledInfo = undefined;
    this.houseTake = undefined;
    this.decidedPlayerIds.clear();

    // Integrity-critical: WHO wins and the full elimination order are
    // decided right now — before betting opens, let alone closes, and
    // before a single round runs. This is a fair, stake-independent
    // shuffle (see odds/outcomePlan.ts): pari-mutuel pricing must never be
    // able to steer the outcome, only price it. Everything from here on
    // just reveals this sealed order one pop at a time.
    const bulbIds = this.bulbs.map((b) => b.id);
    this.outcome = this.oddsProvider.planOutcome(bulbIds);

    this.transitionTo('betting');
    this.scheduleSafetyTimer(this.timings.bettingWindowMs, () => this.closeBetting());
    this.emitStateChange();
  }

  // ---------------------------------------------------------------------
  // Betting window actions
  // ---------------------------------------------------------------------

  placeBet(playerId: string, bulbId: string, stake: number): void {
    if (this.state !== 'betting') {
      throw new Error(`Cannot place a bet while state is "${this.state}"`);
    }
    if (stake <= 0) {
      throw new Error('stake must be greater than 0');
    }
    if (!this.bulbs.some((b) => b.id === bulbId)) {
      throw new Error(`Unknown bulbId "${bulbId}"`);
    }
    if (this.players.some((p) => p.id === playerId)) {
      throw new Error(`Player "${playerId}" has already placed a bet this cycle`);
    }

    const player: Player = { id: playerId, bulbId, stake, status: 'active' };
    this.players.push(player);
    this.emit('betPlaced', { player: { ...player } });
  }

  /** Explicit early-close hook (e.g. a host action). The betting-window
   *  timer also calls this — whichever happens first wins. No bets are
   *  accepted after this point under any circumstance (placeBet() requires
   *  state === 'betting', which this transition ends). */
  closeBetting(): void {
    if (this.state !== 'betting') return; // stale timer or duplicate call
    this.transitionTo('calculating');
    this.scheduleSafetyTimer(CALCULATING_WINDOW_MS, () => this.finishCalculating());
    this.emitStateChange();
    this.emit('calculatingStarted', { durationMs: CALCULATING_WINDOW_MS });
  }

  /** Stakes are now final and locked. Decide whether this cycle actually
   *  has a contest to run — a round needs at least two DIFFERENT bulbs
   *  staked on, or there's no losing pool for pari-mutuel pricing to
   *  redistribute at all. */
  finishCalculating(): void {
    if (this.state !== 'calculating') return; // stale timer or duplicate call

    this.finalStakeByBulbId = totalStakeByBulbId(this.players);
    const contestedBulbCount = this.finalStakeByBulbId.size;

    if (contestedBulbCount < 2) {
      this.cancelCycle(contestedBulbCount);
      return;
    }

    this.beginRound(1);
  }

  /** Uncontested round: refund everyone in full, no round played. The
   *  caller (GameSession) is responsible for starting a fresh cycle —
   *  mirroring how it already restarts after a normal cycle_complete, this
   *  engine only ever transitions itself forward via startCycle(), never
   *  calls it from inside its own state machine. */
  private cancelCycle(contestedBulbCount: number): void {
    const refundedPlayers = this.players.map((p) => ({ ...p }));
    this.cancelledInfo = { reason: 'uncontested', contestedBulbCount };

    this.transitionTo('cycle_cancelled');
    this.emitStateChange();
    this.emit('cycleCancelled', { reason: 'uncontested', refundedPlayers });
  }

  // ---------------------------------------------------------------------
  // Round lifecycle
  // ---------------------------------------------------------------------

  private beginRound(round: number): void {
    this.currentRound = round;
    this.transitionTo('round_active');

    const durationMs = this.timings.roundDurationMs;
    this.scheduleSafetyTimer(durationMs, () => this.resolveRound());
    this.emitStateChange();
    this.emit('roundStarted', { round, totalRounds: this.totalRounds, durationMs });
  }

  /** Reveals the next pop from the sealed elimination order. Timer-driven
   *  by design — there is no player action during the round countdown to
   *  resolve early — but the *outcome* was already decided in startCycle(),
   *  this just unveils it. */
  resolveRound(): void {
    if (this.state !== 'round_active') return; // stale timer or duplicate call

    const poppedBulbId = this.outcome!.eliminationOrder[this.currentRound - 1];
    const popped = this.bulbs.find((b) => b.id === poppedBulbId);
    if (!popped || popped.status !== 'alive') {
      // The sealed plan and the live bulb list have desynced — this is a
      // bug in the engine or the odds provider, not a normal runtime state.
      throw new Error(
        `Internal consistency error: expected bulb "${poppedBulbId}" to be alive at round ${this.currentRound}`,
      );
    }
    popped.status = 'popped';
    popped.poppedInRound = this.currentRound;

    const eliminatedPool = computeEliminatedPool(this.bulbs, this.finalStakeByBulbId!);
    this.roundPoolHistory.push({
      round: this.currentRound,
      eliminatedPool,
      distributablePool: (1 - this.oddsProvider.houseCutRate) * eliminatedPool,
    });

    const affectedPlayers = this.players.filter(
      (p) => p.bulbId === popped.id && p.status === 'active',
    );
    for (const player of affectedPlayers) {
      player.status = 'popped';
    }

    this.emit('bulbPopped', {
      bulb: { ...popped },
      round: this.currentRound,
      affectedPlayers: affectedPlayers.map((p) => ({ ...p })),
    });

    const stillAlive = this.bulbs.filter((b) => b.status === 'alive');
    if (stillAlive.length <= 1) {
      this.endCycle(stillAlive[0]?.id);
      return;
    }

    // Only open a decision window on a configured checkpoint round for
    // this bulb-count mode — every other round pops straight into the
    // next one, with no cash-out opportunity offered at all.
    if (this.isCashOutCheckpoint(stillAlive.length)) {
      this.beginDecisionWindow();
    } else {
      this.beginRound(this.currentRound + 1);
    }
  }

  /** Whether a pop that leaves `aliveCount` bulbs standing should open a
   *  cash-out decision window — see checkpoints.ts. */
  private isCashOutCheckpoint(aliveCount: number): boolean {
    return isCashOutCheckpoint(this.bulbCount, aliveCount);
  }

  // ---------------------------------------------------------------------
  // Decision window: survivors choose to cash out or continue
  // ---------------------------------------------------------------------

  private beginDecisionWindow(): void {
    this.decidedPlayerIds.clear();
    this.transitionTo('decision_window');

    const eligiblePlayerIds = this.getEligibleDeciders().map((p) => p.id);

    // No one left who can act (e.g. everyone already cashed out or is
    // spectating) — skip straight to the next round instead of waiting
    // out a window nobody can use. No timer to schedule, so no deadline.
    if (eligiblePlayerIds.length === 0) {
      this.emitStateChange();
      this.emit('decisionWindowStarted', {
        round: this.currentRound,
        eligiblePlayerIds,
        liveCoefficients: mapToRecord(this.computeLiveCoefficients()),
        durationMs: 0,
      });
      this.advanceToNextRound();
      return;
    }

    const durationMs = this.timings.decisionWindowMs;
    this.scheduleSafetyTimer(durationMs, () => this.advanceToNextRound());
    this.emitStateChange();
    this.emit('decisionWindowStarted', {
      round: this.currentRound,
      eligiblePlayerIds,
      liveCoefficients: mapToRecord(this.computeLiveCoefficients()),
      durationMs,
    });
  }

  private getEligibleDeciders(): Player[] {
    return this.players.filter((p) => p.status === 'active');
  }

  cashOut(playerId: string): void {
    if (this.state !== 'decision_window') {
      throw new Error(`Cannot cash out while state is "${this.state}"`);
    }
    const player = this.requireActiveUndecidedPlayer(playerId);

    // Priced from the SAME live pari-mutuel formula as everything else —
    // see odds/parimutuel.ts. No separate "fixed coefficient" exists.
    const coefficient = this.computeLiveCoefficients().get(player.bulbId);
    if (coefficient === undefined) {
      // Can't happen in practice: an active decider has stake on this bulb
      // by definition, so it always has a coefficient by now.
      throw new Error(`No live coefficient available for bulb "${player.bulbId}"`);
    }
    const value = this.oddsProvider.payoutValue(player.stake, coefficient);

    player.status = 'cashed_out';
    player.result = { round: this.currentRound, value };
    this.decidedPlayerIds.add(playerId);

    this.emit('playerCashedOut', { player: { ...player } });
    this.maybeAdvanceEarly();
  }

  /** Explicit "I'm staying in" confirmation. Optional — a player who does
   *  nothing is treated as continuing once the safety timer fires — but
   *  calling this lets the decision window end early once everyone has
   *  actually decided, rather than always waiting the full window out. */
  continuePlaying(playerId: string): void {
    if (this.state !== 'decision_window') {
      throw new Error(`Cannot confirm continue while state is "${this.state}"`);
    }
    this.requireActiveUndecidedPlayer(playerId);
    this.decidedPlayerIds.add(playerId);

    this.emit('playerContinued', { playerId });
    this.maybeAdvanceEarly();
  }

  private requireActiveUndecidedPlayer(playerId: string): Player {
    const player = this.players.find((p) => p.id === playerId);
    if (!player || player.status !== 'active') {
      throw new Error(`Player "${playerId}" is not an active decider right now`);
    }
    if (this.decidedPlayerIds.has(playerId)) {
      throw new Error(`Player "${playerId}" has already decided this window`);
    }
    return player;
  }

  private maybeAdvanceEarly(): void {
    const stillDeciding = this.getEligibleDeciders().some(
      (p) => !this.decidedPlayerIds.has(p.id),
    );
    if (!stillDeciding) {
      this.advanceToNextRound();
    }
  }

  /** Fires either because every active player explicitly decided, or
   *  because the decision-window safety timer expired (implicit "continue"
   *  for anyone who didn't act). */
  advanceToNextRound(): void {
    if (this.state !== 'decision_window') return; // stale timer or duplicate call
    this.beginRound(this.currentRound + 1);
  }

  // ---------------------------------------------------------------------
  // Cycle end
  // ---------------------------------------------------------------------

  private endCycle(winningBulbId: string | undefined): void {
    if (winningBulbId !== undefined && winningBulbId !== this.outcome?.winningBulbId) {
      // The sole survivor must always be the bulb decided in startCycle();
      // anything else means the elimination order and round count desynced.
      throw new Error(
        `Internal consistency error: sole survivor "${winningBulbId}" does not match ` +
          `planned winner "${this.outcome?.winningBulbId}"`,
      );
    }

    this.winningBulbId = winningBulbId;
    this.transitionTo('cycle_complete');
    this.emitStateChange();

    const winners = winningBulbId
      ? this.players.filter((p) => p.bulbId === winningBulbId && p.status === 'active')
      : [];

    // Priced from the exact same formula as every mid-round cash-out — at
    // this point every bulb except the winner is 'popped', so eliminated_pool
    // covers the whole losing field and this one lookup IS the win payout.
    const finalCoefficients = this.computeLiveCoefficients();
    let claimedByWinners = 0;
    for (const player of winners) {
      const coefficient = finalCoefficients.get(player.bulbId)!;
      const value = this.oddsProvider.payoutValue(player.stake, coefficient);
      player.status = 'won';
      player.result = { round: this.currentRound, value };
      claimedByWinners += value;
    }

    // Anyone who popped earlier and is still marked 'popped' effectively
    // spent the rest of the cycle spectating; reflect that in final state.
    for (const player of this.players) {
      if (player.status === 'popped') {
        player.status = 'spectator';
      }
    }

    // A cash-out is final (see PlayerStatus) — anyone who left the winning
    // bulb early has no further claim, so if `winners` came up empty (or
    // only covers part of that bulb's total stake), part of the
    // distributable pool has no claimant left. Undefined winningBulbId
    // (the uncontested/cancelled path never reaches endCycle) shouldn't
    // occur here, but this stays defensive rather than assuming.
    if (winningBulbId !== undefined) {
      const eliminatedPool = computeEliminatedPool(this.bulbs, this.finalStakeByBulbId!);
      this.houseTake = computeHouseTake(eliminatedPool, this.oddsProvider.houseCutRate, claimedByWinners);
    }

    this.emit('cycleComplete', {
      winningBulbId: winningBulbId ?? '',
      winners: winners.map((p) => ({ ...p })),
    });
  }

  // ---------------------------------------------------------------------
  // Internal transition/timer plumbing
  // ---------------------------------------------------------------------

  /** Clears any pending timer and bumps state — deliberately does NOT emit
   *  'stateChange' itself. Callers schedule the phase's new safety timer
   *  (if any) first via scheduleSafetyTimer(), then call emitStateChange(),
   *  so subscribers never observe a snapshot whose phaseDeadlineAt is stale
   *  or missing for the state they're looking at. */
  private transitionTo(state: GameState): void {
    this.clearSafetyTimer();
    this.generation += 1;
    this.state = state;
  }

  private emitStateChange(): void {
    this.emit('stateChange', { snapshot: this.getSnapshot() });
  }

  private scheduleSafetyTimer(ms: number, onFire: () => void): void {
    this.clearSafetyTimer();
    const expectedGeneration = this.generation;
    this.phaseDurationMs = ms;
    this.phaseDeadlineAt = Date.now() + ms;
    this.pendingTimer = this.clock.setTimeout(() => {
      if (expectedGeneration !== this.generation) return; // superseded — ignore
      onFire();
    }, ms);
  }

  private clearSafetyTimer(): void {
    if (this.pendingTimer !== undefined) {
      this.clock.clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    this.phaseDurationMs = undefined;
    this.phaseDeadlineAt = undefined;
  }
}
