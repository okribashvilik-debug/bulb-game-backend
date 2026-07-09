/**
 * The single formula the whole pari-mutuel model is built on.
 *
 * For a bulb `i` still alive at round `r`:
 *   eliminated_pool(r)     = total stake (across all players) on every bulb
 *                            that has already popped by round r
 *   distributable_pool(r)  = (1 - houseCutRate) * eliminated_pool(r)
 *   live_coefficient_i(r)  = 1 + distributable_pool(r) / total_stake_on_bulb_i
 *
 * The house only ever cuts the LOSING pool — a bulb's own stake, and every
 * other still-alive bulb's stake, are never taxed. This same formula prices
 * both a mid-round cash-out and the final win payout: at the last round,
 * eliminated_pool includes every bulb except the winner, so it falls out of
 * this one formula with no separate "fixed payout" calculation needed.
 *
 * If nobody has staked on a bulb, its coefficient is mathematically
 * undefined (division by zero) — callers must treat `undefined` as "blank,"
 * never coerce it to 0 or any other fallback number.
 */
import type { Bulb, Player } from '../types';

export function computeCoefficient(
  stakeOnBulb: number,
  eliminatedPool: number,
  houseCutRate: number,
): number | undefined {
  if (stakeOnBulb <= 0) return undefined;
  const distributablePool = (1 - houseCutRate) * eliminatedPool;
  return 1 + distributablePool / stakeOnBulb;
}

/** Total stake, across all players, on every bulb — keyed by bulb id.
 *  Bulbs nobody bet on simply don't appear as a key. */
export function totalStakeByBulbId(players: Player[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const player of players) {
    totals.set(player.bulbId, (totals.get(player.bulbId) ?? 0) + player.stake);
  }
  return totals;
}

/** Sum of `totalStakeByBulbId` over every bulb currently in `'popped'`
 *  status — the losing pool the live coefficient formula redistributes. */
export function computeEliminatedPool(bulbs: Bulb[], stakeByBulbId: Map<string, number>): number {
  let pool = 0;
  for (const bulb of bulbs) {
    if (bulb.status === 'popped') {
      pool += stakeByBulbId.get(bulb.id) ?? 0;
    }
  }
  return pool;
}

/** Live coefficient for every currently-alive bulb, keyed by bulb id. Bulbs
 *  with zero stake are omitted entirely (never a 0 or fallback entry) — see
 *  computeCoefficient(). */
export function computeCoefficients(
  bulbs: Bulb[],
  players: Player[],
  houseCutRate: number,
): Map<string, number> {
  const stakeByBulbId = totalStakeByBulbId(players);
  const eliminatedPool = computeEliminatedPool(bulbs, stakeByBulbId);

  const coefficients = new Map<string, number>();
  for (const bulb of bulbs) {
    if (bulb.status !== 'alive') continue;
    const stake = stakeByBulbId.get(bulb.id) ?? 0;
    const coefficient = computeCoefficient(stake, eliminatedPool, houseCutRate);
    if (coefficient !== undefined) coefficients.set(bulb.id, coefficient);
  }
  return coefficients;
}
