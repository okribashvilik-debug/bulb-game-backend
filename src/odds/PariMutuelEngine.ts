/**
 * Public seam between the state machine and the pari-mutuel odds/payout
 * model. BulbGameEngine only ever talks to an `OddsProvider` — it never
 * imports outcomePlan.ts / parimutuel.ts directly — so the odds model stays
 * swappable without touching state-machine code, as long as a replacement
 * implements this same interface.
 *
 * Pricing is stateful per cycle (the shared depleting pool — see
 * PoolLedger in parimutuel.ts), so the provider hands the engine one
 * ledger per cycle via createLedger(); all coefficients, cash-out claims
 * and the final win settlement run through that single ledger instance.
 */
import { DEFAULT_ODDS_CONFIG, type OddsConfig } from './config';
import { PoolLedger } from './parimutuel';
import { planCycleOutcome, type CycleOutcomePlan } from './outcomePlan';
import { DefaultRandomSource, type RandomSource } from '../rng';

export interface OddsProvider {
  /** The house-cut fraction this provider prices with — exposed so callers
   *  (the audit trail) can record exactly what was used for a given cycle,
   *  independent of whatever the live config is by the time it's read. */
  readonly houseCutRate: number;
  /** Decides the winner + full elimination order for a new cycle. Must be
   *  called once, before betting closes — see outcomePlan.ts. */
  planOutcome(bulbIds: string[]): CycleOutcomePlan;
  /** One shared money ledger per cycle — created at cycle start, single
   *  source of truth for pool contributions, live coefficients, and every
   *  payout (cash-out or win). See PoolLedger in parimutuel.ts. */
  createLedger(): PoolLedger;
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

  createLedger(): PoolLedger {
    return new PoolLedger(this.config.houseCutRate);
  }
}
