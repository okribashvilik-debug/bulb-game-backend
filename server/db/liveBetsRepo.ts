/**
 * Persistence for the `live_bets` feed table. Real-time delivery to
 * connected clients happens over WebSocket broadcast (see
 * ws/connection.ts) — this table exists so a client that joins mid-cycle
 * (or a fresh page load) can be caught up with recent activity via
 * fetchRecentLiveBets(), and so the feed survives a server restart.
 */
import { supabase } from '../supabaseClient';
import type { BulbCount } from '../../src/index';
import type { LiveBetEventType, LiveBetRow } from './types';

export async function insertLiveBetEvent(params: {
  cycleId: string | null;
  mode: BulbCount;
  playerId: string | null;
  displayName: string;
  bulbId: string;
  stake: number;
  payout: number | null;
  eventType: LiveBetEventType;
}): Promise<void> {
  const { error } = await supabase.from('live_bets').insert({
    cycle_id: params.cycleId,
    mode: params.mode,
    player_id: params.playerId,
    display_name: params.displayName,
    bulb_id: params.bulbId,
    stake: params.stake,
    payout: params.payout,
    event_type: params.eventType,
  });
  if (error) throw error;
}

export async function fetchRecentLiveBets(mode: BulbCount, limit = 50): Promise<LiveBetRow[]> {
  const { data, error } = await supabase
    .from('live_bets')
    .select('*')
    .eq('mode', mode)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as LiveBetRow[];
}
