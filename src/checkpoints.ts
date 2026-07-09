/**
 * Which "bulbs remaining" counts open a cash-out decision window, per
 * bulb-count mode. Configurable data, not inline conditionals — retune by
 * editing this table only, nothing else needs to change.
 *
 * Shared between BulbGameEngine (which drives real gameplay off it) and
 * the RTP simulation harness (odds/rtpSimulation.ts), which needs to
 * simulate the exact same, now-restricted set of cash-out opportunities
 * to validate the payout guarantee under this checkpoint structure —
 * a single source of truth here keeps the two from drifting apart.
 */
import type { BulbCount } from './types';

export const CHECKPOINTS_BY_BULB_COUNT: Readonly<Record<BulbCount, readonly number[]>> = {
  5: [3],
  7: [5, 3],
  10: [6, 3],
};

/** Whether a pop that leaves `aliveCount` bulbs standing, in a cycle of
 *  `bulbCount` bulbs, should open a cash-out decision window. */
export function isCashOutCheckpoint(bulbCount: BulbCount, aliveCount: number): boolean {
  return CHECKPOINTS_BY_BULB_COUNT[bulbCount].includes(aliveCount);
}
