/**
 * Core type definitions for the Bulb Game engine.
 *
 * No UI/rendering concerns — it only describes the shapes of data the
 * state machine reads and produces.
 */

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
  | 'calculating'      // betting just closed; stakes are final, odds are being computed
  | 'round_active'     // a round's countdown is running toward a pop
  | 'decision_window'  // survivors may cash out or continue
  | 'cycle_complete'   // exactly one bulb remains; cycle over, awaiting reset
  | 'cycle_cancelled'; // uncontested (<2 bulbs staked) — refunded, no round played

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
  /** Live pari-mutuel coefficient for currently-alive, currently-staked
   *  bulbs only — computed fresh from real stake totals (see
   *  odds/parimutuel.ts). Empty during 'idle' / 'betting' / 'calculating'
   *  (nothing can be priced until stakes are final), and a bulb with zero
   *  stake never appears as a key even once pricing starts — the UI must
   *  render a missing key as blank, never as 0 or any other fallback. Keyed
   *  by bulb id. */
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

/** One round's snapshot of the pari-mutuel pool math, recorded as it
 *  happens — part of CycleAuditRecord so a cycle's entire payout history
 *  can be independently re-derived later. */
export interface RoundPoolRecord {
  round: number;
  eliminatedPool: number;
  distributablePool: number;
}

/**
 * Full audit record for a cycle — everything needed to independently
 * re-validate every payout later, including `eliminationOrder` and the
 * round-by-round pool math.
 *
 * Deliberately NOT part of CycleSnapshot / getSnapshot(): eliminationOrder
 * reveals every future pop in advance, so broadcasting it to clients would
 * break the game's core integrity guarantee (see odds/outcomePlan.ts). This
 * type only comes from BulbGameEngine.getAuditRecord(), a distinctly-named
 * method so the "this is server-only, never forward it" boundary is
 * explicit in the API itself, not just a comment.
 */
export interface CycleAuditRecord {
  cycleId: string;
  bulbCount: BulbCount;
  winningBulbId: string;
  /** Full pop order for every bulb except the winner. Sensitive — see above. */
  eliminationOrder: string[];
  /** Total stake per bulb, locked the instant betting closed. Empty until
   *  then. Keyed by bulb id. */
  finalStakeByBulbId: Record<string, number>;
  /** The house-cut fraction actually used for this cycle's pricing — stored
   *  per-cycle (not just read from current config) so a later config change
   *  can't retroactively make an old cycle's payouts look wrong. */
  houseCutRate: number;
  /** One entry per round resolved so far, in order. */
  roundPoolHistory: RoundPoolRecord[];
  /** Present only if this cycle was auto-cancelled as uncontested (fewer
   *  than 2 bulbs received any stake) — refunded in full, no round played. */
  cancelled?: {
    reason: 'uncontested';
    contestedBulbCount: number;
  };
}
