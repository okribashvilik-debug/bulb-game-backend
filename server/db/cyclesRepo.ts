/**
 * Persistence for the `cycles` table — the audit-grade record of what the
 * odds engine generated for each cycle. Because BulbGameEngine seals a
 * cycle's ENTIRE outcome (winner + elimination order) at startCycle(), all
 * of that is already known and gets written in a single insert right when
 * the cycle starts — nothing about the outcome itself is ever updated
 * later, only `status`/`betting_closed_at`/`ended_at` as the cycle
 * progresses through real time.
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
      shape: audit.shape,
      probabilities: audit.probabilities,
      fixed_coefficients: audit.fixedCoefficients,
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

export async function markCycleComplete(cycleDbId: string): Promise<void> {
  const { error } = await supabase
    .from('cycles')
    .update({ status: 'complete', ended_at: new Date().toISOString() })
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
