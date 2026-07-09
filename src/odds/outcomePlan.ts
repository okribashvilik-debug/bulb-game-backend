/**
 * The integrity-critical core of the odds engine.
 *
 * Everything here runs ONCE, synchronously, at the start of a cycle —
 * before betting closes and before a single round is played — and the
 * result is treated as a sealed plan that the state machine only *reveals*
 * round by round. This ordering is deliberate and must not change:
 *
 *   1. Generate a probability distribution shape and assign it to bulbs.
 *   2. Decide the winning bulb from that distribution (weighted draw).
 *   3. Generate an elimination order for every OTHER bulb, as an
 *      independent weighted-random draw (lower probability -> more likely,
 *      but never guaranteed, to be eliminated earlier).
 *
 * Deciding the winner and the elimination order up front — rather than
 * rolling each pop live, round by round — is what prevents the outcome
 * from being steered by information that only exists after betting closes
 * (e.g. which bulbs attracted the most stake).
 */
import type { OddsConfig } from './config';
import { probabilityToCoefficient } from './coefficients';
import { generateShapeProbabilities, type ProbabilityShape } from './shapes';
import { computeSurvivalCurves } from './survivalCurves';
import type { RandomSource } from '../rng';

export interface CycleOutcomePlan {
  shape: ProbabilityShape;
  /** Each bulb's original assigned win probability (sums to 1 across the cycle). */
  probabilityByBulbId: Map<string, number>;
  /** coefficient = HOUSE_RTP / original probability, clamped. Locked for the
   *  whole cycle — this is what a bulb pays out at if it goes all the way
   *  to being the sole survivor without its bettors ever cashing out early. */
  fixedCoefficientByBulbId: Map<string, number>;
  /** survivalCurveByBulbId.get(id)[r-1] = P(bulb `id` alive entering round r),
   *  for r = 1..totalRounds+1. Computed purely from probabilityByBulbId —
   *  unconditional on the actual winningBulbId/eliminationOrder below, which
   *  is the point (see survivalCurves.ts). This is what round-by-round
   *  cash-out values are looked up from. */
  survivalCurveByBulbId: Map<string, number[]>;
  /** Decided before betting closes / before any round runs. */
  winningBulbId: string;
  /** Pop order for every bulb except the winner: eliminationOrder[0] pops in
   *  round 1, eliminationOrder[1] in round 2, and so on. */
  eliminationOrder: string[];
}

export function planCycleOutcome(
  bulbIds: string[],
  config: OddsConfig,
  rng: RandomSource,
  options: { forcedShape?: ProbabilityShape } = {},
): CycleOutcomePlan {
  if (bulbIds.length < 2) {
    throw new Error('planCycleOutcome requires at least 2 bulbs');
  }

  const { shape, values } = generateShapeProbabilities(bulbIds.length, rng, config, options.forcedShape);
  const probabilityByBulbId = assignShuffled(bulbIds, values, rng);

  const fixedCoefficientByBulbId = new Map<string, number>();
  for (const [bulbId, probability] of probabilityByBulbId) {
    fixedCoefficientByBulbId.set(bulbId, probabilityToCoefficient(probability, config));
  }

  // Step 1 (of the integrity ordering): the winner is decided first, from
  // the probabilities alone, before anything else about the cycle's
  // outcome is generated.
  const winningBulbId = decideWinningBulb(probabilityByBulbId, rng);

  // Step 2: a *separate* randomized process decides the order everyone
  // else pops in. This deliberately does not reuse the winner draw above.
  const losers = bulbIds.filter((id) => id !== winningBulbId);
  const eliminationOrder = generateEliminationOrder(losers, probabilityByBulbId, rng);

  const plan = {
    shape,
    probabilityByBulbId,
    fixedCoefficientByBulbId,
    winningBulbId,
    eliminationOrder,
  } as CycleOutcomePlan;

  // survivalCurveByBulbId is computed purely from probabilityByBulbId — it
  // doesn't need the winner or elimination order above at all, which is
  // deliberate (it must be a fair, unconditional curve, not one that
  // secretly knows the outcome). It's also the single most expensive part
  // of planning a cycle (an exact combinatorial DP — see survivalCurves.ts)
  // and not every caller needs it (e.g. a hold-to-resolution simulation
  // never looks at it), so it's computed lazily on first access and cached
  // — real gameplay always ends up needing it once betting closes, but
  // there's no reason to pay for it before that.
  let survivalCurveCache: Map<string, number[]> | undefined;
  Object.defineProperty(plan, 'survivalCurveByBulbId', {
    enumerable: true,
    get(): Map<string, number[]> {
      if (!survivalCurveCache) {
        survivalCurveCache = computeSurvivalCurves(bulbIds, probabilityByBulbId);
      }
      return survivalCurveCache;
    },
  });

  return plan;
}

/** Shuffles which bulb id receives which probability value, so e.g. the
 *  "dominant" favorite in a Dominant-shaped cycle isn't always bulb_1. */
function assignShuffled(
  bulbIds: string[],
  values: number[],
  rng: RandomSource,
): Map<string, number> {
  const shuffled = [...bulbIds];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const map = new Map<string, number>();
  shuffled.forEach((bulbId, i) => map.set(bulbId, values[i]));
  return map;
}

/** Weighted random draw: P(bulb wins) is exactly its assigned probability. */
export function decideWinningBulb(
  probabilityByBulbId: Map<string, number>,
  rng: RandomSource,
): string {
  const entries = [...probabilityByBulbId.entries()];
  const index = weightedRandomIndex(
    entries.map(([, p]) => p),
    rng,
  );
  return entries[index][0];
}

/**
 * Weighted sampling WITHOUT replacement over the loser pool. Weight is the
 * inverse of a bulb's original win probability, so longshots are more
 * likely to be drawn (and therefore pop) earlier — but every draw is still
 * a genuine weighted-random pick, not a deterministic sort, so the order
 * varies cycle to cycle even for an identical probability distribution.
 */
export function generateEliminationOrder(
  loserBulbIds: string[],
  probabilityByBulbId: Map<string, number>,
  rng: RandomSource,
): string[] {
  const remaining = [...loserBulbIds];
  const order: string[] = [];

  while (remaining.length > 0) {
    const weights = remaining.map((id) => 1 / probabilityByBulbId.get(id)!);
    const index = weightedRandomIndex(weights, rng);
    order.push(remaining[index]);
    remaining.splice(index, 1);
  }

  return order;
}

function weightedRandomIndex(weights: number[], rng: RandomSource): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1; // floating-point fallback, practically unreachable
}
