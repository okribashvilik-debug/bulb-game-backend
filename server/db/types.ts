/** Row shapes mirroring supabase/schema.sql — kept as plain hand-written
 *  types (no codegen step in this project) so they're easy to read
 *  alongside the SQL that defines them. */

export interface PlayerRow {
  id: string;
  display_name: string;
  balance: number;
  created_at: string;
  updated_at: string;
}

export type CycleStatus = 'betting' | 'active' | 'complete' | 'cancelled';

export interface RoundPoolRow {
  round: number;
  eliminatedPool: number;
  distributablePool: number;
}

export interface CycleRow {
  id: string;
  engine_cycle_id: string | null;
  mode: 5 | 7 | 10;
  winning_bulb_id: string | null;
  elimination_order: string[] | null;
  total_rounds: number;
  status: CycleStatus;
  /** Total stake per bulb, locked once betting closed. Null until the cycle
   *  finishes (see markCycleComplete). Bulb id -> stake. */
  final_stake_by_bulb: Record<string, number> | null;
  /** The house-cut fraction actually used for this cycle's pricing. */
  house_cut_rate: number | null;
  /** One entry per round resolved, in order. Null until the cycle finishes. */
  round_pool_history: RoundPoolRow[] | null;
  /** houseCutRate * eliminatedPool — the flat edge, regardless of cash-out
   *  behavior. Null until the cycle finishes; null (not 0) for a cancelled
   *  cycle. See computeHouseTake() in src/odds/parimutuel.ts. */
  standard_house_cut: number | null;
  /** Share of the distributable pool with no remaining claimant because
   *  everyone on the winning bulb had already cashed out earlier in the
   *  cycle. Zero (not null) once the cycle finishes with nobody's claim
   *  going unclaimed; null until the cycle finishes or if cancelled. */
  unclaimed_pool: number | null;
  /** standard_house_cut + unclaimed_pool. Null until the cycle finishes or
   *  if cancelled. */
  total_house_take: number | null;
  /** Populated only for status='cancelled' (uncontested round, refunded). */
  cancel_reason: string | null;
  /** Populated for status='complete': 'sole_survivor' (sealed elimination
   *  order ran its course) or 'no_contenders' (settled early — at most one
   *  alive bulb still had active stake). */
  completion_reason: string | null;
  started_at: string;
  betting_closed_at: string | null;
  ended_at: string | null;
}

export type BetOutcome = 'active' | 'won' | 'cashed_out' | 'popped';

export interface BetRow {
  id: string;
  player_id: string;
  cycle_id: string;
  mode: 5 | 7 | 10;
  bulb_id: string;
  stake: number;
  round_placed: number;
  outcome: BetOutcome;
  round_resolved: number | null;
  coefficient_at_resolution: number | null;
  payout: number | null;
  placed_at: string;
  resolved_at: string | null;
}

export type LiveBetEventType = 'bet_placed' | 'won' | 'cashed_out' | 'popped';

export interface LiveBetRow {
  id: string;
  cycle_id: string | null;
  mode: 5 | 7 | 10;
  player_id: string | null;
  display_name: string;
  bulb_id: string;
  stake: number;
  payout: number | null;
  event_type: LiveBetEventType;
  created_at: string;
}

export interface LeaderboardRow {
  player_id: string;
  display_name: string;
  net_profit: number;
  bets_count: number;
}
