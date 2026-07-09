/**
 * Core type definitions for the Bulb Game engine.
 *
 * No UI/rendering concerns — it only describes the shapes of data the
 * state machine reads and produces. The only cross-module reference is the
 * `ProbabilityShape` type-only import below (zero runtime coupling), kept
 * here so CycleSnapshot can report which shape a cycle rolled.
 */
import type { ProbabilityShape } from './odds/shapes';

/** Bulb counts the game currently supports. */
export type BulbCount = 5 | 7 | 10;

/** Lifecycle status of a single bulb within a cycle. */
export type BulbStatus = 'alive' | 'popped';

export interface Bulb {
  id: string;
  status: BulbStatus;
  /** 1-based round index in which this bulb popped, if it has. */
  poppedInRound?: number;
}

/** Lifecycle status of a single player's participation in a cycle. */
export type PlayerStatus =
  | 'active'      // still in the game: bulb alive, has not cashed out
  | 'cashed_out'  // voluntarily left with a payout before the cycle ended
  | 'popped'      // bulb popped while this player was active — lost stake
  | 'won'         // player's bulb was the sole survivor at cycle end
  | 'spectator';  // popped earlier and is just watching the rest of the cycle

export interface PlayerResult {
  round: number;
  value: number;
}

export interface Player {
  id: string;
  bulbId: string;
  stake: number;
  status: PlayerStatus;
  /** Populated once the player cashes out or wins. */
  result?: PlayerResult;
}

/**
 * Top-level states of the cycle state machine. Every transition between
 * these is an explicit method call on the engine — timers only ever call
 * those same methods as a safety cap, they never mutate state directly.
 */
export type GameState =
  | 'idle'             // no cycle has been started yet
  | 'betting'          // betting window open, players may join
  | 'round_active'     // a round's countdown is running toward a pop
  | 'decision_window'  // survivors may cash out or continue
  | 'cycle_complete';  // exactly one bulb remains; cycle over, awaiting reset

export interface CycleTimings {
  /** Fixed durations (ms) — not randomized ranges. Pacing is retuned by
   *  changing these values, not by touching state-machine logic. */
  bettingWindowMs: number;
  roundDurationMs: number;
  /** Duration of a cash-out decision window, when one is offered — see
   *  CHECKPOINTS_BY_BULB_COUNT in BulbGameEngine.ts for which rounds
   *  actually open one. */
  decisionWindowMs: number;
}

export interface CycleSnapshot {
  cycleId: string;
  state: GameState;
  bulbCount: BulbCount;
  timings: CycleTimings;
  bulbs: Bulb[];
  players: Player[];
  /** 0 before the first round starts, then 1-based. */
  currentRound: number;
  /** Always bulbCount - 1. */
  totalRounds: number;
  winningBulbId?: string;
  /** Which probability shape this cycle rolled. Safe to reveal any time —
   *  it says nothing about which bulb is which. Undefined only in 'idle'. */
  shape?: ProbabilityShape;
  /** coefficient = HOUSE_RTP / original probability, clamped. Locked for
   *  the whole cycle at cycle start — the fixed-odds board a UI would show
   *  during betting. Keyed by bulb id. */
  fixedCoefficients: Record<string, number>;
  /** Round-by-round cash-out coefficient for currently-alive bulbs only,
   *  looked up from each bulb's own precomputed survival curve — what a
   *  cash-out is actually worth right now. Keyed by bulb id. */
  liveCoefficients: Record<string, number>;
  /** Wall-clock deadline (ms, comparable to Date.now()) for the current
   *  timed phase (betting / round_active / decision_window), or undefined
   *  when the current state has no running timer. UI countdowns should
   *  derive remaining time from this rather than re-deriving their own. */
  phaseDeadlineAt?: number;
  /** Total duration of the current timed phase, in ms. Paired with
   *  phaseDeadlineAt so a countdown can compute both remaining time and
   *  progress (e.g. for a shrinking ring or bar). */
  phaseDurationMs?: number;
}

/**
 * Full audit record for a cycle's sealed outcome plan — everything needed
 * to independently re-validate RTP later, including `eliminationOrder`.
 *
 * Deliberately NOT part of CycleSnapshot / getSnapshot(): eliminationOrder
 * reveals every future pop in advance, so broadcasting it to clients would
 * break the game's core integrity guarantee (see outcomePlan.ts). This
 * type only comes from BulbGameEngine.getAuditRecord(), a distinctly-named
 * method so the "this is server-only, never forward it" boundary is
 * explicit in the API itself, not just a comment.
 */
export interface CycleAuditRecord {
  cycleId: string;
  bulbCount: BulbCount;
  shape: ProbabilityShape;
  /** Each bulb's original assigned win probability, keyed by bulb id. */
  probabilities: Record<string, number>;
  fixedCoefficients: Record<string, number>;
  winningBulbId: string;
  /** Full pop order for every bulb except the winner. Sensitive — see above. */
  eliminationOrder: string[];
}
