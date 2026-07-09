/**
 * Decides WHICH bulb wins and in what order the others pop — entirely
 * separate from pari-mutuel pricing (see parimutuel.ts), which only prices
 * an outcome, never influences it. That separation is the defining property
 * of a pari-mutuel model (same as horse racing): the pool prices the race,
 * the race doesn't know about the pool.
 *
 * With no probability shapes assigned to bulbs anymore, there is nothing to
 * weight a draw by — every bulb is equally likely to win, and equally
 * likely to pop in any given remaining round. This is a single uniform
 * random shuffle, decided once, synchronously, at the start of a cycle —
 * before betting opens, let alone closes — so the outcome can never be
 * steered by which bulbs end up attracting stake. Every later pop just
 * reveals the next entry of this sealed order.
 */
import type { RandomSource } from '../rng';

export interface CycleOutcomePlan {
  /** Decided before betting opens. */
  winningBulbId: string;
  /** Pop order for every bulb except the winner: eliminationOrder[0] pops in
   *  round 1, eliminationOrder[1] in round 2, and so on. */
  eliminationOrder: string[];
}

export function planCycleOutcome(bulbIds: string[], rng: RandomSource): CycleOutcomePlan {
  if (bulbIds.length < 2) {
    throw new Error('planCycleOutcome requires at least 2 bulbs');
  }

  const shuffled = shuffle(bulbIds, rng);
  // Safe: the length guard above ensures shuffled has at least 2 entries.
  const [winningBulbId, ...eliminationOrder] = shuffled as [string, ...string[]];

  return { winningBulbId, eliminationOrder };
}

/** Uniform random (Fisher-Yates) shuffle — every permutation equally likely. */
function shuffle<T>(items: T[], rng: RandomSource): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}
