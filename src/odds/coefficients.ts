import type { OddsConfig } from './config';

/**
 * The single formula the whole fixed-odds model is built on:
 *   coefficient = HOUSE_RTP / probability, clamped to [min, max].
 *
 * Every coefficient in this module — the fixed odds locked in at cycle
 * start and the live, round-by-round recomputed odds — goes through this
 * exact function so the house-edge math only ever lives in one place.
 */
export function probabilityToCoefficient(probability: number, config: OddsConfig): number {
  if (probability <= 0) {
    throw new Error(`probability must be > 0, got ${probability}`);
  }
  const raw = config.houseRtp / probability;
  return clamp(raw, config.minCoefficient, config.maxCoefficient);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
