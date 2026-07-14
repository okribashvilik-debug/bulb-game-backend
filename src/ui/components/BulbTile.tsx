import { useMemo } from 'react';
import { makeParticles, type StageBulb } from '../stage';
import { formatCoefficient } from '../format';

interface BulbTileProps {
  bulb: StageBulb;
  /** Live pari-mutuel coefficient for this bulb (undefined when the bulb
   *  is popped/unstaked — snapshot.liveCoefficients is sparse). */
  coefficient?: number;
  /** Whether the coefficient label row is shown at all — false while
   *  nothing is priced yet (betting/idle), so the stage stays clean. */
  showCoefficient: boolean;
  /** The player has an open position on this bulb — keeps the existing
   *  "track my bulb" outline affordance from the old flat-disc tile. */
  isMine: boolean;
  /** This bulb is the player's current pick (same selectedBulbId the
   *  ControlPanel chips read/write, so the two always stay in sync). */
  selected: boolean;
  /** Betting is open and the player can still (re)pick — only then is the
   *  bulb rendered with a click/tap/keyboard hit target at all. */
  selectable: boolean;
  onSelect: () => void;
}

/**
 * One hanging bulb: cord (with an electricity-flow overlay), screw cap,
 * glass (highlight + filament + number), winner rays, and the transient
 * pop-burst / win-spark overlays — the per-bulb anatomy from
 * design_handoff_main_event_area, exactly in the spec's z-order. All state
 * styling lives in the `bulb--<state>` / `cord-energy--<state>` CSS
 * families in styles.css; this component only places geometry (from
 * StageBulbLayout) and mounts/unmounts the particle/spark/arc overlays so
 * their CSS animations retrigger fresh (particles on every pop; the
 * spark's travel and the overcharge arc mount with their state, per the
 * electricity-flow patch).
 *
 * The room-facing light for this bulb (wall glow, flare, cone, floor pool)
 * deliberately does NOT live here — see RoomLighting.tsx.
 */
export function BulbTile({
  bulb,
  coefficient,
  showCoefficient,
  isMine,
  selected,
  selectable,
  onSelect,
}: BulbTileProps) {
  const L = bulb.layout;
  // "Powered" states get a travelling spark on the cord; only overcharge
  // additionally gets the jittering arc bolt.
  const powered = bulb.state === 'charging' || bulb.state === 'overcharge' || bulb.state === 'win';

  // Generous hit target for touch: at least 44×44px, covering cap + glass.
  const hitW = Math.max(L.s, 44);
  const hitH = Math.max(L.capH + L.s, 44);

  // Fresh shards per pop (keyed by the burst token), 12 rects in 65%
  // bulb-color / 35% white. Only ever non-empty for NEUTRAL pops — a human
  // loss keeps the restrained dim with no celebratory burst (the old
  // bulb-tile--just-popped-human-loss rule, carried over).
  const shards = useMemo(
    () => (bulb.burstToken === null ? [] : makeParticles(bulb.color, 12, 46, 80, true)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bulb.burstToken],
  );

  // 16 gold/white spark dots, generated once per win entry.
  const isWin = bulb.state === 'win';
  const sparks = useMemo(
    () => (isWin ? makeParticles('#f5c451', 16, 60, 120, false) : []),
    [isWin],
  );

  return (
    <div
      className={`bulb bulb--${bulb.state}${isMine ? ' bulb--mine' : ''}${selected ? ' bulb--selected' : ''}`}
      style={{ left: `${L.leftPct}%`, '--bulb-color': bulb.color } as React.CSSProperties}
    >
      <div className="bulb__cord" style={{ height: L.cordH }} />

      {/* Electricity flowing ceiling -> bulb: an overlay on the cord, never
          touching cord geometry. Dashes are always present (opacity/flow
          speed vary per state via the cord-energy--<state> class); the
          travelling spark and the overcharge arc mount only while
          applicable so they don't animate invisibly in the background. */}
      <div className={`cord-energy cord-energy--${bulb.state}`} style={{ height: L.cordH }}>
        <div className="cord-energy__dashes" />
        {powered && <div className="cord-energy__spark" />}
        {bulb.state === 'overcharge' && (
          <div className="cord-energy__arc">
            <svg viewBox="0 0 12 100" preserveAspectRatio="none">
              <polyline className="cord-energy__arc-halo" points="6,0 3,14 9,26 4,40 8,54 3,68 9,82 6,100" />
              <polyline className="cord-energy__arc-core" points="6,0 3,14 9,26 4,40 8,54 3,68 9,82 6,100" />
            </svg>
          </div>
        )}
      </div>

      <div
        className="bulb__cap"
        style={{ left: -Math.round(L.capW / 2), top: L.cordH, width: L.capW, height: L.capH }}
      />

      {/* Shake wrapper — the overcharge jitter animates this, never the
          glass itself, so the flicker and the shake compose cleanly. */}
      <div
        className="bulb__wrap"
        style={{ left: -Math.round(L.s / 2), top: L.glassTop, width: L.s, height: L.s }}
      >
        <div className="bulb__rays" style={{ width: L.raysW, height: L.raysW }} />

        <div className="bulb__glass">
          <div className="bulb__highlight" />
          <div className="bulb__filament" />
          <div className="bulb__number" style={{ fontSize: L.numSize }}>
            {bulb.num}
          </div>
        </div>

        {/* Pop burst — mounted fresh for ~0.9s per (neutral) pop so the
            forwards-fill animations fire again each time. */}
        {bulb.burstToken !== null && (
          <>
            <div className="bulb__flash" />
            <div className="bulb__shockwave" />
            {shards.map((p, i) => (
              <span
                key={`${bulb.burstToken}:${i}`}
                className="bulb__shard"
                style={
                  {
                    width: p.w,
                    height: p.h,
                    background: p.c,
                    '--a': `${p.a}deg`,
                    '--d': `${p.d}px`,
                    animationDuration: `${p.dur}s`,
                  } as React.CSSProperties
                }
              />
            ))}
          </>
        )}

        {/* Win sparks — one burst on entry; they fly out and fade, and the
            spent (opacity 0) particles unmount with the win state. */}
        {isWin &&
          sparks.map((p, i) => (
            <span
              key={i}
              className="bulb__spark"
              style={
                {
                  width: p.w,
                  height: p.h,
                  background: p.c,
                  '--a': `${p.a}deg`,
                  '--d': `${p.d}px`,
                  animationDuration: `${p.dur}s`,
                } as React.CSSProperties
              }
            />
          ))}
      </div>

      {/* Live coefficient, centered under the glass — outside bulb__wrap so
          the overcharge shake never jitters the number. Same "—" convention
          as OutcomeChip for bulbs with nothing to price (popped/unstaked);
          hidden entirely while nothing is priced yet (betting/idle). */}
      {showCoefficient && (
        <div
          className={`bulb__coeff${coefficient === undefined || bulb.state === 'popped' ? ' bulb__coeff--none' : ''}`}
          style={{ top: L.glassTop + L.s + 6 }}
        >
          {coefficient !== undefined && bulb.state !== 'popped' ? formatCoefficient(coefficient) : '—'}
        </div>
      )}

      {/* Click/tap/keyboard hit target — only mounted while the player can
          actually (re)pick, so outside the betting window there's no
          cursor affordance, no focus stop, and clicks fall through. */}
      {selectable && (
        <button
          type="button"
          className="bulb__hit"
          style={{
            left: -Math.round(hitW / 2),
            top: Math.min(L.cordH, L.cordH + L.capH + L.s - hitH),
            width: hitW,
            height: hitH,
          }}
          aria-pressed={selected}
          aria-label={`Select bulb ${bulb.num}`}
          onClick={onSelect}
        />
      )}
    </div>
  );
}
