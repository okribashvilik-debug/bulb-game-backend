/**
 * Public seam between the state machine and the pari-mutuel odds/payout
 * model. BulbGameEngine only ever talks to an `OddsProvider` — it never
 * imports outcomePlan.ts / parimutuel.ts directly — so the odds model stays
 * swappable without touching state-machine code, as long as a replacement
 * implements this same interface.
 */
import { DEFAULT_ODDS_CONFIG, type OddsConfig } from './config';
import { computeCoefficients } from './parimutuel';
import { planCycleOutcome, type CycleOutcomePlan } from './outcomePlan';
import { DefaultRandomSource, type RandomSource } from '../rng';
import type { Bulb, Player } from '../types';

export interface OddsProvider {
  /** The house-cut fraction this provider prices with — exposed so callers
   *  (the audit trail) can record exactly what was used for a given cycle,
   *  independent of whatever the live config is by the time it's read. */
  readonly houseCutRate: number;
  /** Decides the winner + full elimination order for a new cycle. Must be
   *  called once, before betting closes — see outcomePlan.ts. */
  planOutcome(bulbIds: string[]): CycleOutcomePlan;
  /** Live coefficient for every currently-alive, currently-staked bulb,
   *  computed fresh from the CURRENT bulb/player state — see parimutuel.ts.
   *  Bulbs with zero stake are omitted, never given a fallback value. */
  liveCoefficients(bulbs: Bulb[], players: Player[]): Map<string, number>;
  /** Converts a stake + coefficient into a payout value. */
  payoutValue(stake: number, coefficient: number): number;
}

export class PariMutuelEngine implements OddsProvider {
  private readonly config: OddsConfig;
  private readonly rng: RandomSource;

  constructor(config: Partial<OddsConfig> = {}, rng: RandomSource = new DefaultRandomSource()) {
    this.config = { ...DEFAULT_ODDS_CONFIG, ...config };
    this.rng = rng;
  }

  get houseCutRate(): number {
    return this.config.houseCutRate;
  }

  planOutcome(bulbIds: string[]): CycleOutcomePlan {
    return planCycleOutcome(bulbIds, this.rng);
  }

  liveCoefficients(bulbs: Bulb[], players: Player[]): Map<string, number> {
    return computeCoefficients(bulbs, players, this.config.houseCutRate);
  }

  payoutValue(stake: number, coefficient: number): number {
    return stake * coefficient;
  }
}
