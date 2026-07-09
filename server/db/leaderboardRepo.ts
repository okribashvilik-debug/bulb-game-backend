/**
 * Reads for the day/week/month leaderboard views (see schema.sql). Plain
 * SELECTs against a view — Postgres recomputes the aggregation on read,
 * which stays automatically consistent with `bets` with no refresh job.
 */
import { supabase } from '../supabaseClient';
import type { LeaderboardRow } from './types';

export type LeaderboardWindow = 'day' | 'week' | 'month';

const VIEW_BY_WINDOW: Record<LeaderboardWindow, string> = {
  day: 'leaderboard_daily',
  week: 'leaderboard_weekly',
  month: 'leaderboard_monthly',
};

export async function fetchLeaderboard(window: LeaderboardWindow, limit = 10): Promise<LeaderboardRow[]> {
  const { data, error } = await supabase
    .from(VIEW_BY_WINDOW[window])
    .select('*')
    .order('net_profit', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as LeaderboardRow[];
}
