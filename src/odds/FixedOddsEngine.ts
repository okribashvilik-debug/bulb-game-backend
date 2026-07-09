/**
 * Public seam between the state machine and the odds/payout model.
 *
 * BulbGameEngine only ever talks to an `OddsProvider` — it never imports
 * shapes.ts / outcomePlan.ts / survivalCurves.ts directly. That makes the
 * whole odds model swappable (e.g. a future parimutuel or promo-boosted
 * engine) without touching state-machine code, as long as the replacement
 * implements this same interface.
 */
import { DEFAULT_ODDS_CONFIG, type OddsConfig } from './config';
import { probabilityToCoefficient } from './coefficients';
import { planCycleOutcome, type CycleOutcomePlan } from './outcomePlan';
import type { ProbabilityShape } from './shapes';
import { DefaultRandomSource, type RandomSource } from '../rng';

export interface OddsProvider {
  /** Generates the full sealed outcome plan for a new cycle. Must be called
   *  once, before betting closes, per the integrity ordering in outcomePlan.ts.
   *  `forcedShape` is a testing/admin hook — production callers omit it and
   *  let the shape be chosen randomly. */
  planCycle(bulbIds: string[], forcedShape?: ProbabilityShape): CycleOutcomePlan;
  /** The round-by-round cash-out coefficient for one bulb, looked up from
   *  its precomputed survival curve. Deliberately takes no information
   *  about which OTHER bulbs are still alive — the whole point of this
   *  model is that it doesn't need to (see survivalCurves.ts). */
  cashOutCoefficient(plan: CycleOutcomePlan, bulbId: string, round: number): number;
  /** Converts a stake + coefficient into a payout value. */
  cashoutValue(stake: number, coefficient: number): number;
}

export class FixedOddsEngine implements OddsProvider {
  private readonly config: OddsConfig;
  private readonly rng: RandomSource;

  constructor(config: Partial<OddsConfig> = {}, rng: RandomSource = new DefaultRandomSource()) {
    this.config = { ...DEFAULT_ODDS_CONFIG, ...config };
    this.rng = rng;
  }

  planCycle(bulbIds: string[], forcedShape?: ProbabilityShape): CycleOutcomePlan {
    return planCycleOutcome(bulbIds, this.config, this.rng, { forcedShape });
  }

  cashOutCoefficient(plan: CycleOutcomePlan, bulbId: string, round: number): number {
    const curve = plan.survivalCurveByBulbId.get(bulbId);
    if (!curve) {
      throw new Error(`No survival curve recorded for bulb "${bulbId}"`);
    }
    const survivalProbability = curve[round - 1];
    if (survivalProbability === undefined) {
      throw new Error(`Round ${round} is out of range for bulb "${bulbId}"'s survival curve (length ${curve.length})`);
    }
    return probabilityToCoefficient(survivalProbability, this.config);
  }

  cashoutValue(stake: number, coefficient: number): number {
    return stake * coefficient;
  }
}
