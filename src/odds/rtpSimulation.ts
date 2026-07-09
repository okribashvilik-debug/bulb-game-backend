/**
 * Simulation harness for the odds engine, kept inside the module itself so
 * it can be reused by both the automated RTP test and any future
 * human-readable balancing report — this is a property of the odds math,
 * independent of the state machine's timers, so it's tested in isolation
 * rather than by driving BulbGameEngine through thousands of real cycles.
 */
import { isCashOutCheckpoint } from '../checkpoints';
import { DEFAULT_ODDS_CONFIG, type OddsConfig } from './config';
import { probabilityToCoefficient } from './coefficients';
import { planCycleOutcome } from './outcomePlan';
import type { ProbabilityShape } from './shapes';
import { DefaultRandomSource, type RandomSource } from '../rng';
import type { BulbCount } from '../types';

export interface RtpSimulationResult {
  shape: ProbabilityShape | 'mixed';
  bulbCount: BulbCount;
  cycles: number;
  totalStake: number;
  totalPayout: number;
  /** totalPayout / totalStake — should converge to config.houseRtp. */
  rtp: number;
  minCoefficientSeen: number;
  maxCoefficientSeen: number;
  clampedLowCount: number;
  clampedHighCount: number;
}

function makeBulbIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `bulb_${i + 1}`);
}

/**
 * Primary RTP measurement: the "fixed-odds" definition of the model.
 * Simulates one 1-unit bettor per bulb per cycle who holds to natural
 * resolution (never cashes out early). Payout is the bulb's fixed
 * coefficient — locked at cycle start from its original probability — if
 * and only if that bulb turns out to be the predetermined winner.
 *
 * This has a clean theoretical target: E[payout] = sum_i p_i * (RTP/p_i)
 * = RTP, exactly, whenever the clamp doesn't bind. Long-run convergence to
 * ~houseRtp here is the direct test of "coefficient = HOUSE_RTP/probability"
 * being wired correctly.
 */
export function runFixedOddsRtpSimulation(options: {
  bulbCount: BulbCount;
  cycles: number;
  shape?: ProbabilityShape;
  config?: OddsConfig;
  rng?: RandomSource;
}): RtpSimulationResult {
  const { bulbCount, cycles, shape, config = DEFAULT_ODDS_CONFIG, rng = new DefaultRandomSource() } = options;
  const bulbIds = makeBulbIds(bulbCount);

  let totalStake = 0;
  let totalPayout = 0;
  let minCoefficientSeen = Infinity;
  let maxCoefficientSeen = -Infinity;
  let clampedLowCount = 0;
  let clampedHighCount = 0;

  for (let cycle = 0; cycle < cycles; cycle++) {
    const plan = planCycleOutcome(bulbIds, config, rng, { forcedShape: shape });

    for (const bulbId of bulbIds) {
      const coefficient = plan.fixedCoefficientByBulbId.get(bulbId)!;
      totalStake += 1;
      totalPayout += bulbId === plan.winningBulbId ? coefficient : 0;

      minCoefficientSeen = Math.min(minCoefficientSeen, coefficient);
      maxCoefficientSeen = Math.max(maxCoefficientSeen, coefficient);
      if (coefficient <= config.minCoefficient) clampedLowCount += 1;
      if (coefficient >= config.maxCoefficient) clampedHighCount += 1;
    }
  }

  return {
    shape: shape ?? 'mixed',
    bulbCount,
    cycles,
    totalStake,
    totalPayout,
    rtp: totalPayout / totalStake,
    minCoefficientSeen,
    maxCoefficientSeen,
    clampedLowCount,
    clampedHighCount,
  };
}

/**
 * Secondary measurement: simulates bettors who cash out early using the
 * round-by-round, survival-curve-derived cash-out coefficient — exercising
 * the exact same lookup BulbGameEngine.cashOut() uses, restricted to the
 * exact same checkpoint rounds real players are actually offered a
 * decision at (see checkpoints.ts). Every surviving bettor still alive at
 * a checkpoint cashes out with probability `cashoutProbabilityPerRound`;
 * at non-checkpoint rounds nobody is offered anything (implicit
 * "continue"); if a bettor never cashes out, they're paid the fixed
 * coefficient on natural resolution, exactly like the real engine.
 *
 * Unlike the OLD renormalization-based live coefficient (which this
 * replaces), this now has the SAME clean theoretical target as the
 * fixed-odds measurement above: cash_out_i(r) = HOUSE_RTP / survival_i(r)
 * is constructed so that P(reach r) * cash_out_i(r) = HOUSE_RTP for every
 * bulb and every r, by definition of survival_i(r) itself. Restricting
 * WHICH rounds actually offer that opportunity doesn't touch the formula
 * at all — it's still exactly as fair at every checkpoint it fires on, so
 * long-run RTP should converge to houseRtp just as tightly as before the
 * checkpoint restructure. See survivalCurves.ts for the derivation.
 */
export function runMixedStrategyRtpSimulation(options: {
  bulbCount: BulbCount;
  cycles: number;
  shape?: ProbabilityShape;
  cashoutProbabilityPerRound?: number;
  config?: OddsConfig;
  rng?: RandomSource;
}): RtpSimulationResult {
  const {
    bulbCount,
    cycles,
    shape,
    cashoutProbabilityPerRound = 0.3,
    config = DEFAULT_ODDS_CONFIG,
    rng = new DefaultRandomSource(),
  } = options;
  const bulbIds = makeBulbIds(bulbCount);

  let totalStake = 0;
  let totalPayout = 0;
  let minCoefficientSeen = Infinity;
  let maxCoefficientSeen = -Infinity;
  let clampedLowCount = 0;
  let clampedHighCount = 0;

  for (let cycle = 0; cycle < cycles; cycle++) {
    const plan = planCycleOutcome(bulbIds, config, rng, { forcedShape: shape });
    const resolved = new Set<string>();
    const payoutByBulbId = new Map<string, number>(bulbIds.map((id) => [id, 0]));

    // Walk the sealed elimination order round by round, exactly as the
    // real engine reveals it. After the pop at index `idx` (round idx+1
    // resolved), survivors are offered the round (idx+2) cash-out value.
    plan.eliminationOrder.forEach((poppedId, idx) => {
      resolved.add(poppedId); // popped bettors are resolved at 0, stake lost

      const round = idx + 1;
      const isFinalRound = round === plan.eliminationOrder.length; // only the winner remains after this
      if (isFinalRound) {
        if (!resolved.has(plan.winningBulbId)) {
          payoutByBulbId.set(plan.winningBulbId, plan.fixedCoefficientByBulbId.get(plan.winningBulbId)!);
          resolved.add(plan.winningBulbId);
        }
        return;
      }

      const aliveCountAfterThisPop = bulbIds.length - round;
      if (!isCashOutCheckpoint(bulbCount, aliveCountAfterThisPop)) {
        return; // not a checkpoint round — nobody is offered a decision, implicit "continue"
      }

      const lookupRound = round + 1;
      for (const bulbId of bulbIds) {
        if (resolved.has(bulbId)) continue; // already popped or already cashed out

        // The eventual winner is offered a cash-out here too, using its own
        // survival curve, exactly like everyone else — it doesn't "know"
        // yet that it will win. That's the point of this model.
        const survivalProbability = plan.survivalCurveByBulbId.get(bulbId)![lookupRound - 1];
        const coefficient = probabilityToCoefficient(survivalProbability, config);
        minCoefficientSeen = Math.min(minCoefficientSeen, coefficient);
        maxCoefficientSeen = Math.max(maxCoefficientSeen, coefficient);
        if (coefficient <= config.minCoefficient) clampedLowCount += 1;
        if (coefficient >= config.maxCoefficient) clampedHighCount += 1;

        if (rng.next() < cashoutProbabilityPerRound) {
          payoutByBulbId.set(bulbId, coefficient);
          resolved.add(bulbId);
        }
      }
    });

    for (const bulbId of bulbIds) {
      totalStake += 1;
      totalPayout += payoutByBulbId.get(bulbId)!;
    }
  }

  return {
    shape: shape ?? 'mixed',
    bulbCount,
    cycles,
    totalStake,
    totalPayout,
    rtp: totalPayout / totalStake,
    minCoefficientSeen,
    maxCoefficientSeen,
    clampedLowCount,
    clampedHighCount,
  };
}

export const runRtpSimulation = runFixedOddsRtpSimulation;
