/**
 * Tunable constants for the fixed-odds model. Kept as a single injectable
 * config object (not hard-coded literals scattered through the module) so
 * the house edge or clamp bounds can be adjusted — or overridden per
 * instance in tests — without touching any calculation code.
 */
export interface OddsConfig {
  /** Target return-to-player, e.g. 0.95 = 95% RTP / 5% house edge. */
  houseRtp: number;
  /** Coefficients are clamped to [minCoefficient, maxCoefficient]. */
  minCoefficient: number;
  maxCoefficient: number;
}

export const DEFAULT_ODDS_CONFIG: OddsConfig = {
  houseRtp: 0.95,
  minCoefficient: 1.02,
  maxCoefficient: 50,
};
