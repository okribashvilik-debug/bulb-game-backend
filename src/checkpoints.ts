/**
 * Which "bulbs remaining" counts open a cash-out decision window, per
 * bulb-count mode. Configurable data, not inline conditionals — retune by
 * editing this table only, nothing else needs to change.
 *
 * Currently every round after the first pop offers one (every alive count
 * from bulbCount-1 down to 2 — the last pop always leaves exactly the
 * winner, which ends the cycle directly rather than opening a window).
 * Shared between BulbGameEngine (which drives real gameplay off it) and
 * the RTP simulation harness (odds/rtpSimulation.ts) — a single source of
 * truth here keeps the two from drifting apart.
 */
import type { BulbCount } from './types';

function everyRoundAfterFirstPop(bulbCount: number): number[] {
  const counts: number[] = [];
  for (let alive = bulbCount - 1; alive >= 2; alive--) counts.push(alive);
  return counts;
}

export const CHECKPOINTS_BY_BULB_COUNT: Readonly<Record<BulbCount, readonly number[]>> = {
  5: everyRoundAfterFirstPop(5),
  7: everyRoundAfterFirstPop(7),
  10: everyRoundAfterFirstPop(10),
};

/** Whether a pop that leaves `aliveCount` bulbs standing, in a cycle of
 *  `bulbCount` bulbs, should open a cash-out decision window. */
export function isCashOutCheckpoint(bulbCount: BulbCount, aliveCount: number): boolean {
  return CHECKPOINTS_BY_BULB_COUNT[bulbCount].includes(aliveCount);
}
