/**
 * "Near miss" detection: was a surviving bulb statistically close to being
 * the one that popped this round? Deliberately reserved, not fired on
 * every survival — see the two guards below.
 *
 * Uses each bulb's FIXED coefficient as a stand-in for its elimination
 * weight (coefficient = HOUSE_RTP / probability, so a higher coefficient
 * means a lower probability means a higher pop-order weight — see
 * odds/outcomePlan.ts). Good enough for a flavor cue; doesn't need to be
 * exact since it isn't used for payouts.
 */

const SPREAD_THRESHOLD = 0.5; // skip fields that are too uniform to have a meaningful "close call"
const NEAR_MISS_RATIO = 0.85; // how close the runner-up's coefficient must be to the popped bulb's

export function detectNearMissBulbId(
  poppedBulbId: string,
  survivorBulbIds: string[],
  fixedCoefficients: Record<string, number>,
): string | null {
  const poppedCoeff = fixedCoefficients[poppedBulbId];
  if (poppedCoeff === undefined || survivorBulbIds.length === 0) return null;

  const pool = [poppedCoeff, ...survivorBulbIds.map((id) => fixedCoefficients[id])];
  const poolMax = Math.max(...pool);
  const poolMin = Math.min(...pool);
  // A near-uniform field (e.g. the "wide open" shape) doesn't produce a
  // meaningful close call every round — that's just the normal texture of
  // that shape, not a special moment worth flagging.
  if (poolMin <= 0 || (poolMax - poolMin) / poolMin <= SPREAD_THRESHOLD) return null;

  let runnerUpId: string | null = null;
  let runnerUpCoeff = -Infinity;
  for (const id of survivorBulbIds) {
    const coeff = fixedCoefficients[id];
    if (coeff > runnerUpCoeff) {
      runnerUpCoeff = coeff;
      runnerUpId = id;
    }
  }

  if (runnerUpId !== null && runnerUpCoeff >= poppedCoeff * NEAR_MISS_RATIO) {
    return runnerUpId;
  }
  return null;
}
