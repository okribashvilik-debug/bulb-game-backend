import { useEffect, useState } from 'react';

export interface Countdown {
  remainingMs: number;
  /** 0 at the start of the phase, 1 right at the deadline. */
  progress: number;
}

/** Ticks ~10x/sec while a deadline is active, for countdown UI (rings,
 *  bars, "3.2s" labels). Purely a display concern — the engine's own
 *  timers are what actually drive state transitions. */
export function useCountdown(deadlineAt: number | undefined, durationMs: number | undefined): Countdown {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadlineAt === undefined) return;
    // Refresh immediately: `now` may be stale from a previous phase that had
    // no deadline (e.g. cycle_complete's pause before auto-restart), during
    // which this effect was skipped entirely and `now` was never updated.
    // Without this, the first reading against a brand-new deadline would be
    // inflated by however long that idle gap lasted.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [deadlineAt]);

  if (deadlineAt === undefined || durationMs === undefined || durationMs <= 0) {
    return { remainingMs: 0, progress: 0 };
  }

  const remainingMs = Math.max(0, deadlineAt - now);
  const progress = Math.min(1, Math.max(0, 1 - remainingMs / durationMs));
  return { remainingMs, progress };
}
