/**
 * RNG is injected rather than hard-coded so that:
 *  - unit tests can supply a deterministic/scripted sequence
 *  - a future "provably fair" (seeded + hash-committed) source can be
 *    swapped in later without touching engine logic at all.
 */
export interface RandomSource {
  /** Returns a float in [0, 1) — same contract as Math.random(). */
  next(): number;
}

export class DefaultRandomSource implements RandomSource {
  next(): number {
    return Math.random();
  }
}

/** Picks a uniformly random element from a non-empty array. */
export function pickRandom<T>(items: T[], rng: RandomSource): T {
  if (items.length === 0) {
    throw new Error('pickRandom: cannot pick from an empty array');
  }
  const index = Math.floor(rng.next() * items.length);
  return items[index];
}

/** Draws a random float within an inclusive [min, max] range. */
export function randomInRange([min, max]: [number, number], rng: RandomSource): number {
  return min + rng.next() * (max - min);
}
