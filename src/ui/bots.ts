/**
 * Simulated "other players" so the UI has something to show in the live
 * bets feed, the leaderboard, and the main event area beyond a single
 * human bettor. Talks to BulbGameEngine only through its public API
 * (placeBet / cashOut / continuePlaying) — from the engine's point of
 * view a bot is indistinguishable from a real player.
 */
import type { BulbGameEngine } from '../BulbGameEngine';
import type { CycleSnapshot } from '../types';

const BOT_NAME_POOL = [
  'Nino', 'Levan', 'Mariam', 'Giorgi', 'Tako', 'Data', 'Ana', 'Luka',
  'Salome', 'Beka', 'Keti', 'Zura', 'Tea', 'Sandro', 'Nutsa', 'Otar',
  'Elene', 'Vato', 'Mari', 'Irakli',
];

const STAKE_POOL = [1, 2, 5, 10, 20, 25, 50, 100];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export interface BotSimulatorOptions {
  minBots?: number;
  maxBots?: number;
  /** Chance any given surviving bot cashes out at each decision window. */
  cashoutChance?: number;
}

const DEFAULTS: Required<BotSimulatorOptions> = {
  minBots: 3,
  maxBots: 8,
  cashoutChance: 0.35,
};

export class BotSimulator {
  private readonly options: Required<BotSimulatorOptions>;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly engine: BulbGameEngine,
    options: BotSimulatorOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    this.unsubscribers.push(
      engine.on('stateChange', ({ snapshot }) => this.handleStateChange(snapshot)),
      engine.on('decisionWindowStarted', ({ eligiblePlayerIds, liveCoefficients, durationMs }) =>
        this.scheduleDecisions(eligiblePlayerIds, liveCoefficients, durationMs),
      ),
    );
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

  private scheduleDecisions(
    eligiblePlayerIds: string[],
    _liveCoefficients: Record<string, number>,
    durationMs: number,
  ): void {
    const botIds = eligiblePlayerIds.filter((id) => id !== 'you');
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
