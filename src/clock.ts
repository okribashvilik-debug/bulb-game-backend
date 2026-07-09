/**
 * Clock is injected so the engine has zero hard dependency on the global
 * timer functions. That makes it possible to:
 *  - fast-forward through a cycle in tests/demos instead of waiting real seconds
 *  - run identically in a browser or in Node (both expose setTimeout/clearTimeout,
 *    but with different handle types — TimerHandle papers over that)
 */
export type TimerHandle = ReturnType<typeof setTimeout>;

export interface Clock {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const defaultClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};
