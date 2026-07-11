/**
 * Presentation model for the main-event stage — the "bulbs hanging from
 * cords in a dark show room" redesign (see design_handoff_main_event_area).
 *
 * Pure derivation, no React: turns a CycleSnapshot (+ the transient pop
 * sequence from useBulbGame) into one StageBulb per bulb, carrying the
 * visual state and all the pixel geometry the prototype computed in its
 * renderVals(). Both the RoomLighting layer and each BulbLamp render from
 * this one model, so the room's reaction can never drift out of sync with
 * the bulb it's reacting to.
 *
 * State mapping (same data sources as the old BulbTile, per the handoff):
 *   idle       — cycle in idle / betting / calculating / cycle_cancelled
 *   charging   — bulb alive while the cycle is live (round_active AND
 *                decision_window: the handoff names only round_active, but
 *                dropping the whole room back to idle-dark for every 5s
 *                decision window would read as a reset mid-cycle, so the
 *                charge holds until the cycle actually ends)
 *   overcharge — transient: a bulbPopped event arrived for this bulb and
 *                the ~1.1s pre-pop flicker is playing (the snapshot already
 *                says 'popped'; this holds the visual back deliberately)
 *   popped     — bulb.status === 'popped', once the overcharge beat is done
 *   win        — cycle_complete and this bulb is the winner. Held back at
 *                'charging' while the final pop's overcharge beat plays so
 *                the winner lights gold at the burst moment, not before —
 *                the real server sends cycle_complete in the same breath
 *                as the last bulbPopped, unlike the prototype's scripted
 *                demo which paused between them.
 */
import type { Bulb, CycleSnapshot } from '../types';
import { bulbNumber } from './format';
import { getBulbColor } from './palette';
import type { PopTransition } from './useBulbGame';

export type LampState = 'idle' | 'charging' | 'overcharge' | 'popped' | 'win';

/** All pixel geometry for one hanging bulb — formulas verbatim from the
 *  prototype's renderVals(). Everything is derived from the glass size `s`
 *  and the bulb's index, so retuning means touching only this function. */
export interface StageBulbLayout {
  /** Horizontal center of this bulb's column, in % of stage width. */
  leftPct: number;
  /** Glass diameter, px: 78 (5 bulbs) / 66 (7) / 56 (10). */
  s: number;
  /** Cord length, px — middle bulbs hang lower (slight arc). */
  cordH: number;
  capW: number;
  capH: number;
  /** Top of the glass circle: cordH + capH − 3. */
  glassTop: number;
  coneTop: number;
  coneW: number;
  poolW: number;
  poolH: number;
  wallW: number;
  wallH: number;
  wallTop: number;
  flareW: number;
  flareH: number;
  flareTop: number;
  raysW: number;
  numSize: number;
}

export interface StageBulb {
  id: string;
  num: number;
  color: string;
  state: LampState;
  /** Set (with a fresh token per pop) only while this bulb's ~0.9s pop
   *  burst overlays should be mounted — and only for NEUTRAL pops. A
   *  human loss never gets the celebratory flash/shockwave/shards (the
   *  loss-restraint rule carried over from the old
   *  bulb-tile--just-popped-human-loss treatment). */
  burstToken: number | null;
  layout: StageBulbLayout;
}

function deriveLampState(
  bulb: Bulb,
  snapshot: CycleSnapshot,
  popTransition: PopTransition | null,
): LampState {
  if (popTransition?.bulbId === bulb.id && popTransition.phase === 'overcharge') return 'overcharge';
  if (bulb.status === 'popped') return 'popped';
  if (snapshot.state === 'cycle_complete' && snapshot.winningBulbId === bulb.id) {
    // Hold the gold until the final pop's overcharge + burst beats have
    // fully resolved (~2s) — pop lands first, THEN the winner lights up,
    // the same cadence as the prototype's scripted round.
    if (popTransition !== null) return 'charging';
    return 'win';
  }
  if (snapshot.state === 'round_active' || snapshot.state === 'decision_window') return 'charging';
  return 'idle';
}

export function computeStage(snapshot: CycleSnapshot, popTransition: PopTransition | null): StageBulb[] {
  const n = snapshot.bulbs.length;
  if (n === 0) return [];

  const s = n >= 10 ? 56 : n >= 7 ? 66 : 78;
  const spacing = Math.min(13, 82 / Math.max(1, n - 1));
  const mid = (n - 1) / 2;

  return snapshot.bulbs.map((bulb, i) => {
    const norm = mid === 0 ? 0 : (i - mid) / mid;
    const cordH = Math.round(64 + 74 * (1 - norm * norm));
    const capW = Math.round(s * 0.44);
    const capH = Math.round(s * 0.26);
    const glassTop = cordH + capH - 3;
    const coneW = Math.round(s * 3.6);
    const poolW = Math.round(s * 4.2);
    const wallW = Math.round(s * 7.5);
    const flareW = Math.round(s * 10);

    const burstToken =
      popTransition !== null &&
      popTransition.bulbId === bulb.id &&
      popTransition.phase === 'burst' &&
      popTransition.kind === 'neutral'
        ? popTransition.token
        : null;

    return {
      id: bulb.id,
      num: bulbNumber(bulb.id),
      color: getBulbColor(bulb.id),
      state: deriveLampState(bulb, snapshot, popTransition),
      burstToken,
      layout: {
        leftPct: 50 + (i - mid) * spacing,
        s,
        cordH,
        capW,
        capH,
        glassTop,
        coneTop: Math.round(glassTop + s * 0.6),
        coneW,
        poolW,
        poolH: Math.round(poolW * 0.2),
        wallW,
        wallH: Math.round(wallW * 0.7),
        wallTop: Math.round(glassTop + s / 2 - wallW * 0.35),
        flareW,
        flareH: Math.round(flareW * 0.7),
        flareTop: Math.round(glassTop + s / 2 - flareW * 0.35),
        raysW: Math.round(s * 2.7),
        numSize: Math.round(s * 0.3),
      },
    };
  });
}

/**
 * How lit the whole room is, 0..1 — the handoff's ambient formula verbatim.
 * Per-bulb weights sum (capped at 0.55) so each pop visibly darkens the
 * room by that bulb's contribution; a winner adds a flat 0.45 on top so the
 * win is deterministically the brightest the room ever gets.
 */
export function computeAmbient(bulbs: StageBulb[]): number {
  const weights: Record<LampState, number> = {
    idle: 0.012,
    charging: 0.11,
    overcharge: 0.18,
    popped: 0,
    win: 0, // excluded from the sum — a winner contributes via the flat bonus instead
  };
  let sum = 0;
  let hasWin = false;
  for (const bulb of bulbs) {
    if (bulb.state === 'win') hasWin = true;
    else sum += weights[bulb.state];
  }
  return Math.max(0, Math.min(1, Math.min(0.55, sum) + (hasWin ? 0.45 : 0)));
}

export interface StageParticle {
  /** Fly-out angle (deg) — evenly spread around the circle, jittered. */
  a: number;
  /** Fly distance (px, negative = outward along the rotated Y axis). */
  d: number;
  w: number;
  h: number;
  c: string;
  /** Animation duration, s. */
  dur: number;
}

/** Shards (pop) and sparks (win) share one generator, exactly like the
 *  prototype's makeParticles — shards are small rects in 65% bulb-color /
 *  35% white, sparks are round gold/white dots that fly further. */
export function makeParticles(
  color: string,
  count: number,
  minDist: number,
  maxDist: number,
  shards: boolean,
): StageParticle[] {
  return Array.from({ length: count }, (_, i) => ({
    a: Math.round(i * (360 / count) + Math.random() * 18),
    d: -Math.round(minDist + Math.random() * (maxDist - minDist)),
    w: shards ? Math.round(3 + Math.random() * 4) : Math.round(4 + Math.random() * 4),
    h: shards ? Math.round(6 + Math.random() * 8) : Math.round(4 + Math.random() * 4),
    c: Math.random() < 0.35 ? '#ffffff' : color,
    dur: 0.45 + Math.random() * 0.35,
  }));
}
