/**
 * Tunable constants for the pari-mutuel model. Kept as a single injectable
 * config object (not a hard-coded literal) so the house cut can be adjusted
 * — or overridden per instance in tests — without touching calculation code.
 */
export interface OddsConfig {
  /** Fraction of the eliminated (losing) pool the house keeps, e.g. 0.05 =
   *  5%. Winners' own stakes are never taxed — only the losing pool is cut. */
  houseCutRate: number;
}

export const DEFAULT_ODDS_CONFIG: OddsConfig = {
  houseCutRate: 0.05,
};
