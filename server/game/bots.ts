/**
 * Server-side simulated bettors — give the pari-mutuel pool real liquidity
 * and the live feed some life even when only one real player is connected.
 * Talks to BulbGameEngine only through its public API (placeBet / cashOut /
 * continuePlaying) — from the engine's point of view a bot is
 * indistinguishable from a real player, and its stake is real pari-mutuel
 * pool money exactly like anyone else's (it counts toward eliminated_pool,
 * distributable_pool, and every live coefficient the same way).
 *
 * What's NOT real: bots never touch Supabase — no balance, no `bets` row,
 * no payout, since there's no real person to credit or debit. GameSession
 * calls isBot() to skip that persistence for bot players specifically (see
 * the resolution handlers in GameSession.ts) while still writing their
 * activity into the `live_bets` feed table with a null player_id, so the
 * feed reads the same for a fresh page load as it does live.
 *
 * A bot's id IS its display name (drawn without replacement from the pool
 * below, so it's unique within one cycle) — simpler than a synthetic id
 * scheme, and it means the client's existing name-masking/display logic
 * needs no bot-specific handling at all.
 */
import type { BulbGameEngine, CycleSnapshot } from '../../src/index';

const BOT_NAME_POOL = [
  'Nino', 'Levan', 'Mariam', 'Giorgi', 'Tako', 'Data', 'Ana', 'Luka',
  'Salome', 'Beka', 'Keti', 'Zura', 'Tea', 'Sandro', 'Nutsa', 'Otar',
  'Elene', 'Vato', 'Mari', 'Irakli',
];

const STAKE_POOL = [1, 2, 5, 10, 20, 25, 50, 100];

/** `items` must be non-empty — every caller here passes a fixed, non-empty
 *  pool (bulb list, name pool, stake pool). */
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

export interface BotControllerOptions {
  minBots?: number;
  maxBots?: number;
  /** Chance any given surviving bot cashes out at each decision window. */
  cashoutChance?: number;
}

/** 3-8 bots per cycle, same tuning as the original client-side demo
 *  simulator this replaces — proven to feel lively without swamping the
 *  pool. */
const DEFAULTS: Required<BotControllerOptions> = {
  minBots: 3,
  maxBots: 8,
  cashoutChance: 0.35,
};

export class BotController {
  private readonly options: Required<BotControllerOptions>;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private currentBotIds = new Set<string>();

  constructor(
    private readonly engine: BulbGameEngine,
    options: BotControllerOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    this.unsubscribers.push(
      engine.on('stateChange', ({ snapshot }) => this.handleStateChange(snapshot)),
      engine.on('decisionWindowStarted', ({ eligiblePlayerIds, durationMs }) =>
        this.scheduleDecisions(eligiblePlayerIds, durationMs),
      ),
    );
  }

  /** Whether `playerId` is one of the current cycle's simulated bots — the
   *  boundary GameSession uses to skip Supabase persistence that only
   *  makes sense for a real, financially-real player. */
  isBot(playerId: string): boolean {
    return this.currentBotIds.has(playerId);
  }

  dispose(): void {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.pendingTimers.forEach((timer) => clearTimeout(timer));
    this.pendingTimers.clear();
  }

  private setTimer(fn: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      fn();
    }, delayMs);
    this.pendingTimers.add(timer);
  }

  private handleStateChange(snapshot: CycleSnapshot): void {
    if (snapshot.state === 'betting') {
      // Fresh roster every cycle — a name only needs to be unique for the
      // one cycle it's used in.
      this.currentBotIds = new Set();
      this.scheduleBets(snapshot);
    }
  }

  private scheduleBets(snapshot: CycleSnapshot): void {
    const botCount = Math.floor(
      this.options.minBots + Math.random() * (this.options.maxBots - this.options.minBots + 1),
    );
    const names = shuffled(BOT_NAME_POOL).slice(0, botCount);
    const bettingWindowMs = snapshot.timings.bettingWindowMs;

    for (const name of names) {
      this.currentBotIds.add(name);
      // Leave a margin before the window closes so a slow tick doesn't miss it.
      const delay = 150 + Math.random() * Math.max(200, bettingWindowMs - 800);
      this.setTimer(() => {
        const bulb = pick(snapshot.bulbs);
        const stake = pick(STAKE_POOL);
        try {
          this.engine.placeBet(name, bulb.id, stake);
        } catch {
          // Betting window may have just closed — fine to drop the bet.
        }
      }, delay);
    }
  }

  private scheduleDecisions(eligiblePlayerIds: string[], durationMs: number): void {
    const botIds = eligiblePlayerIds.filter((id) => this.isBot(id));
    for (const playerId of botIds) {
      const delay = 100 + Math.random() * Math.max(100, durationMs - 500);
      this.setTimer(() => {
        try {
          if (Math.random() < this.options.cashoutChance) {
            this.engine.cashOut(playerId);
          } else {
            this.engine.continuePlaying(playerId);
          }
        } catch {
          // Window may have already ended, or this bot already decided.
        }
      }, delay);
    }
  }
}
