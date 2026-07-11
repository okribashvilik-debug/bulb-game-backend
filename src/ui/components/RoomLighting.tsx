import { computeAmbient, type StageBulb } from '../stage';

/**
 * The reactive room behind the bulbs — pure presentation, its only input
 * is the derived stage-bulb list. Renders (bottom → top, per the handoff):
 *
 *   1. the static stage shell: curtain wall, floor, gold horizon at 76%
 *   2. ambient warm wash — opacity follows the handoff's ambient formula,
 *      so every pop visibly darkens the whole room by that bulb's share
 *   3. win climax wash — the single brightest, warmest frame
 *   4. darkness vignette — strongest when the room is at its quietest
 *   5. per-bulb wall glows / overcharge flares / light cones / floor pools,
 *      each anchored at its bulb's column so a pop dims only THAT bulb's
 *      corner of the room (a 1s local dim, not a flat global fade)
 *
 * It never touches bulb markup — the bulbs (BulbTile) render on top of
 * this, inside MainEventArea.
 */
export function RoomLighting({ bulbs }: { bulbs: StageBulb[] }) {
  const ambient = computeAmbient(bulbs);
  const hasWinner = bulbs.some((b) => b.state === 'win');

  return (
    <div className="room" aria-hidden="true">
      <div className="room__wall" />
      <div className="room__floor" />
      <div className="room__horizon" />
      <div className="room__wash" style={{ opacity: ambient }} />
      <div className="room__win-wash" style={{ opacity: hasWinner ? 0.4 : 0 }} />
      <div className="room__vignette" style={{ opacity: (1 - ambient) * 0.6 }} />

      {bulbs.map((bulb) => {
        const L = bulb.layout;
        return (
          <div
            key={bulb.id}
            className={`room__bulb room__bulb--${bulb.state}`}
            style={{ left: `${L.leftPct}%`, '--bulb-color': bulb.color } as React.CSSProperties}
          >
            <div
              className="room__glow"
              style={{
                left: -Math.round(L.wallW / 2),
                top: L.wallTop,
                width: L.wallW,
                height: L.wallH,
              }}
            />
            <div
              className="room__flare"
              style={{
                left: -Math.round(L.flareW / 2),
                top: L.flareTop,
                width: L.flareW,
                height: L.flareH,
              }}
            />
            <div
              className="room__cone"
              style={{
                left: -Math.round(L.coneW / 2),
                top: L.coneTop,
                width: L.coneW,
                height: `calc(76% - ${L.coneTop}px)`,
              }}
            />
            <div
              className="room__pool"
              style={{
                left: -Math.round(L.poolW / 2),
                width: L.poolW,
                height: L.poolH,
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
