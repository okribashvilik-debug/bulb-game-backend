/**
 * Probability distribution "shapes". At the start of every cycle one of
 * these is chosen at random; it decides how the 100% win-probability pool
 * is carved up across the bulbs before any bulb identity is attached to a
 * number (that assignment — which physical bulb gets which slice — is
 * shuffled separately in outcomePlan.ts, so the "favorite" isn't always
 * bulb_1).
 *
 * Every generator here must return exactly `count` positive numbers that
 * sum to 1. Two safety nets are applied to whatever a generator produces:
 *  - a floor at just above `houseRtp / maxCoefficient` (the probability
 *    below which a bulb's fixed coefficient would hit the clamp ceiling),
 *    so no shape can accidentally manufacture a bulb whose payout gets
 *    capped away — that would silently drag the shape's long-run RTP well
 *    under the 95% target, which is a balancing bug, not a feature; and
 *  - a final normalization pass, against floating-point drift and to
 *    restore sum-to-1 after the floor nudges values up.
 */
import type { OddsConfig } from './config';
import { pickRandom, randomInRange, type RandomSource } from '../rng';

export type ProbabilityShape = 'dominant' | 'wide_open' | 'duel';

const ALL_SHAPES: ProbabilityShape[] = ['dominant', 'wide_open', 'duel'];

export function pickRandomShape(rng: RandomSource): ProbabilityShape {
  return pickRandom(ALL_SHAPES, rng);
}

/** One heavy favorite (~45%) with a steep geometric drop-off across the rest. */
export function generateDominantShape(count: number, rng: RandomSource): number[] {
  const favorite = randomInRange([0.42, 0.48], rng);
  const remainingMass = 1 - favorite;
  const tailCount = count - 1;

  // Geometric decay: weights are 1, decay, decay^2, ... so each subsequent
  // bulb gets a noticeably smaller slice than the one before it. `decay` is
  // itself randomized a little so the drop-off steepness varies cycle to
  // cycle instead of producing an identical tail shape every time.
  const decay = randomInRange([0.45, 0.6], rng);
  const weights = Array.from({ length: tailCount }, (_, i) => decay ** i);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const tail = weights.map((w) => (w / weightSum) * remainingMass);

  return normalize([favorite, ...tail]);
}

/** All bulbs within a narrow band around the uniform average. */
export function generateWideOpenShape(count: number, rng: RandomSource): number[] {
  const average = 1 / count;
  // +/-  roughly 10-20% relative jitter around the average — for count=10
  // this reproduces the ~9-12% band called out in the spec; it scales
  // sensibly for other bulb counts too.
  const raw = Array.from({ length: count }, () => average * randomInRange([0.9, 1.2], rng));
  return normalize(raw);
}

/** Two co-favorites (~35-38% each) with the rest as longshots. */
export function generateDuelShape(count: number, rng: RandomSource): number[] {
  const favoriteA = randomInRange([0.35, 0.38], rng);
  const favoriteB = randomInRange([0.35, 0.38], rng);
  const remainingMass = Math.max(0, 1 - favoriteA - favoriteB);
  const longshotCount = count - 2;

  const longshots = partitionMass(remainingMass, longshotCount, rng);
  return normalize([favoriteA, favoriteB, ...longshots]);
}

const SHAPE_GENERATORS: Record<ProbabilityShape, (count: number, rng: RandomSource) => number[]> = {
  dominant: generateDominantShape,
  wide_open: generateWideOpenShape,
  duel: generateDuelShape,
};

export function generateShapeProbabilities(
  count: number,
  rng: RandomSource,
  config: OddsConfig,
  forcedShape?: ProbabilityShape,
): { shape: ProbabilityShape; values: number[] } {
  const shape = forcedShape ?? pickRandomShape(rng);
  const raw = SHAPE_GENERATORS[shape](count, rng);

  // 10% headroom above the exact break-even so that renormalizing after
  // the floor is applied can't nudge a value back under it.
  const floor = (config.houseRtp / config.maxCoefficient) * 1.1;
  return { shape, values: normalize(raw.map((v) => Math.max(v, floor))) };
}

/**
 * Splits `mass` into `count` positive shares that sum to `mass`, drawn
 * uniformly over the simplex (via normalized exponential variates — the
 * standard trick for sampling a flat Dirichlet distribution) so the split
 * is randomized rather than a rigid even division.
 */
function partitionMass(mass: number, count: number, rng: RandomSource): number[] {
  if (count <= 0) return [];
  const draws = Array.from({ length: count }, () => -Math.log(Math.max(rng.next(), Number.EPSILON)));
  const total = draws.reduce((a, b) => a + b, 0);
  return draws.map((d) => (d / total) * mass);
}

function normalize(values: number[]): number[] {
  const sum = values.reduce((a, b) => a + b, 0);
  return values.map((v) => v / sum);
}
