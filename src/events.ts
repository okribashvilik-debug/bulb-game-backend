import type { Bulb, CycleSnapshot, Player } from './types';

/** Event payloads the engine emits. A future UI subscribes to these. */
export type BulbGameEvents = {
  stateChange: { snapshot: CycleSnapshot };
  betPlaced: { player: Player };
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
  cycleComplete: { winningBulbId: string; winners: Player[] };
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
