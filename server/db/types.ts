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

export type CycleStatus = 'betting' | 'active' | 'complete';

export interface CycleRow {
  id: string;
  engine_cycle_id: string | null;
  mode: 5 | 7 | 10;
  shape: 'dominant' | 'wide_open' | 'duel';
  probabilities: Record<string, number>;
  fixed_coefficients: Record<string, number>;
  winning_bulb_id: string | null;
  elimination_order: string[] | null;
  total_rounds: number;
  status: CycleStatus;
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
