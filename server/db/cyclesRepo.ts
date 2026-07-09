/**
 * Persistence for the `cycles` table — the audit-grade record of what the
 * odds engine generated for each cycle. BulbGameEngine seals the winner +
 * full elimination order at startCycle(), before betting even opens, and
 * that gets written in a single insert right away. The pari-mutuel pool
 * math (final stake totals, house cut, round-by-round pool history) isn't
 * known until stakes are final / the cycle finishes, so it's written once
 * more at completion — see markCycleComplete().
 */
import { supabase } from '../supabaseClient';
import type { BulbCount, CycleAuditRecord } from '../../src/index';
import type { CycleRow } from './types';

export async function insertCycle(audit: CycleAuditRecord, totalRounds: number): Promise<CycleRow> {
  const { data, error } = await supabase
    .from('cycles')
    .insert({
      engine_cycle_id: audit.cycleId,
      mode: audit.bulbCount,
      winning_bulb_id: audit.winningBulbId,
      elimination_order: audit.eliminationOrder,
      total_rounds: totalRounds,
      status: 'betting',
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as CycleRow;
}

export async function markBettingClosed(cycleDbId: string): Promise<void> {
  const { error } = await supabase
    .from('cycles')
    .update({ status: 'active', betting_closed_at: new Date().toISOString() })
    .eq('id', cycleDbId);
  if (error) throw error;
}

/** Final write for a cycle that actually played out — the full pari-mutuel
 *  audit trail (see CycleAuditRecord), so any payout can be independently
 *  re-derived later from final_stake_by_bulb + round_pool_history alone. */
export async function markCycleComplete(
  cycleDbId: string,
  audit: Pick<CycleAuditRecord, 'finalStakeByBulbId' | 'houseCutRate' | 'roundPoolHistory'>,
): Promise<void> {
  const { error } = await supabase
    .from('cycles')
    .update({
      status: 'complete',
      ended_at: new Date().toISOString(),
      final_stake_by_bulb: audit.finalStakeByBulbId,
      house_cut_rate: audit.houseCutRate,
      round_pool_history: audit.roundPoolHistory,
    })
    .eq('id', cycleDbId);
  if (error) throw error;
}

/** Terminal write for an uncontested cycle — refunded, no round played.
 *  Distinct status from 'complete' so the audit trail can tell the two
 *  apart at a glance (see supabase/schema.sql's migration section). */
export async function markCycleCancelled(cycleDbId: string, contestedBulbCount: number): Promise<void> {
  const { error } = await supabase
    .from('cycles')
    .update({
      status: 'cancelled',
      cancel_reason: `uncontested_round (contested_bulb_count=${contestedBulbCount})`,
      ended_at: new Date().toISOString(),
    })
    .eq('id', cycleDbId);
  if (error) throw error;
}

export async function fetchRecentCycles(mode: BulbCount, limit = 30): Promise<CycleRow[]> {
  const { data, error } = await supabase
    .from('cycles')
    .select('*')
    .eq('mode', mode)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as CycleRow[];
}
