import { useMemo } from 'react';

const PARTICLE_COUNT = 7;

/**
 * Small radiating particle burst — the "concentrated dramatic effect" for
 * the exact moment a bulb pops. Only ever rendered for neutral pops (see
 * BulbTile); a human loss gets no particles at all, on purpose.
 */
export function PopBurst({ color, token }: { color: string; token: number }) {
  const particles = useMemo(
    () =>
      Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
        angle: (360 / PARTICLE_COUNT) * i + (Math.random() * 20 - 10),
        dist: 26 + Math.random() * 14,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token],
  );

  return (
    <span className="bulb-tile__burst" aria-hidden="true">
      {particles.map((p, i) => (
        <span
          key={i}
          style={
            {
              '--angle': `${p.angle}deg`,
              '--dist': `${p.dist}px`,
              '--particle-color': color,
            } as React.CSSProperties
          }
        />
      ))}
    </span>
  );
}
