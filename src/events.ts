import type { Bulb, CycleCompletionReason, CycleSnapshot, Player } from './types';

/** Event payloads the engine emits. A future UI subscribes to these. */
export type BulbGameEvents = {
  stateChange: { snapshot: CycleSnapshot };
  betPlaced: { player: Player };
  /** Betting just closed; stakes are locked and odds are being computed —
   *  fires once, at the start of the fixed 3s 'calculating' phase. */
  calculatingStarted: { durationMs: number };
  /** Fewer than 2 bulbs received any stake at all — nothing to price, so
   *  the round never plays. Every listed player is refunded in full. */
  cycleCancelled: { reason: 'uncontested'; refundedPlayers: Player[] };
  roundStarted: { round: number; totalRounds: number; durationMs: number };
  bulbPopped: { bulb: Bulb; round: number; affectedPlayers: Player[] };
  decisionWindowStarted: {
    round: number;
    eligiblePlayerIds: string[];
    /** Round-by-round cash-out coefficients for currently-alive bulbs,
     *  from each bulb's own precomputed survival curve — what cashing out
     *  right now is actually worth. */
    liveCoefficients: Record<string, number>;
    durationMs: number;
  };
  playerCashedOut: { player: Player };
  playerContinued: { playerId: string };
  /** `reason` distinguishes a true final-pop win ('sole_survivor') from an
   *  early no-contenders settlement ('no_contenders' — only one/zero alive
   *  bulbs still had active stake, so the cycle stopped; the UI should say
   *  "no other bulbs left in contention — settled early" rather than play
   *  the normal dramatic final-pop win. `winningBulbId` is '' when nobody
   *  had any active stake left to settle. */
  cycleComplete: { winningBulbId: string; winners: Player[]; reason: CycleCompletionReason };
};

type Listener<T> = (payload: T) => void;

/**
 * Minimal, dependency-free event emitter (no Node 'events' import) so this
 * engine stays portable to a browser runtime without any bundler shims.
 */
export class TinyEmitter<Events extends Record<string, unknown>> {
  private listeners: { [K in keyof Events]?: Listener<Events[K]>[] } = {};

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const list = this.listeners[event] ?? (this.listeners[event] = []);
    list.push(listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    const list = this.listeners[event];
    if (!list) return;
    this.listeners[event] = list.filter((l) => l !== listener) as Listener<Events[K]>[];
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    // Snapshot the list before iterating so a listener removing itself
    // (or another listener) mid-emit can't skip/duplicate callbacks.
    (this.listeners[event] ?? []).slice().forEach((l) => l(payload));
  }
}
