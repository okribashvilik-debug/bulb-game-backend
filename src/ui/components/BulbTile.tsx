import { useMemo } from 'react';
import { makeParticles, type StageBulb } from '../stage';

interface BulbTileProps {
  bulb: StageBulb;
  /** The player has an open position on this bulb — keeps the existing
   *  "track my bulb" outline affordance from the old flat-disc tile. */
  isMine: boolean;
}

/**
 * One hanging bulb: cord, screw cap, glass (highlight + filament + number),
 * winner rays, and the transient pop-burst / win-spark overlays — the
 * per-bulb anatomy from design_handoff_main_event_area, exactly in the
 * spec's z-order. All state styling lives in the `bulb--<state>` CSS
 * families in styles.css; this component only places geometry (from
 * StageBulbLayout) and mounts/unmounts the particle overlays so their CSS
 * animations retrigger fresh on every pop.
 *
 * The room-facing light for this bulb (wall glow, flare, cone, floor pool)
 * deliberately does NOT live here — see RoomLighting.tsx.
 */
export function BulbTile({ bulb, isMine }: BulbTileProps) {
  const L = bulb.layout;

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
      className={`bulb bulb--${bulb.state}${isMine ? ' bulb--mine' : ''}`}
      style={{ left: `${L.leftPct}%`, '--bulb-color': bulb.color } as React.CSSProperties}
    >
      <div className="bulb__cord" style={{ height: L.cordH }} />
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
    </div>
  );
}
