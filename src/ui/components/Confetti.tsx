import { useMemo } from 'react';
import { BULB_PALETTE } from '../palette';

const PIECE_COUNT = 28;

interface Piece {
  left: number;
  delay: number;
  duration: number;
  rotation: number;
  color: string;
  drift: number;
}

/**
 * Celebratory confetti burst — reserved for the human's own cycle win (see
 * useBulbGame's winPulse). Deliberately has no equivalent for losses: a
 * loss never gets this kind of energetic treatment.
 */
export function Confetti({ token }: { token: number }) {
  const pieces = useMemo<Piece[]>(
    () =>
      Array.from({ length: PIECE_COUNT }, () => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.3,
        duration: 1.6 + Math.random() * 0.9,
        rotation: Math.random() * 360,
        color: BULB_PALETTE[Math.floor(Math.random() * BULB_PALETTE.length)],
        drift: (Math.random() - 0.5) * 120,
      })),
    // Regenerated only when the win pulse fires again (new token).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token],
  );

  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((piece, i) => (
        <span
          key={i}
          className="confetti__piece"
          style={
            {
              left: `${piece.left}%`,
              animationDelay: `${piece.delay}s`,
              animationDuration: `${piece.duration}s`,
              backgroundColor: piece.color,
              '--rotate': `${piece.rotation}deg`,
              '--drift': `${piece.drift}px`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
