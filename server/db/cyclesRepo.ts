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
 *  re-derived later from final_stake_by_bulb + round_pool_history alone.
 *  Also writes the house-take breakdown (see computeHouseTake() in
 *  src/odds/parimutuel.ts) as its own columns — the standard 5% edge and
 *  the unclaimed-pool amount are logged separately so historical data can
 *  distinguish how much of a cycle's take came from each. */
export async function markCycleComplete(
  cycleDbId: string,
  audit: Pick<
    CycleAuditRecord,
    'finalStakeByBulbId' | 'houseCutRate' | 'roundPoolHistory' | 'houseTake' | 'completionReason' | 'settledBulbId'
  >,
): Promise<void> {
  const { error } = await supabase
    .from('cycles')
    .update({
      status: 'complete',
      ended_at: new Date().toISOString(),
      final_stake_by_bulb: audit.finalStakeByBulbId,
      house_cut_rate: audit.houseCutRate,
      round_pool_history: audit.roundPoolHistory,
      standard_house_cut: audit.houseTake?.standardCut ?? null,
      unclaimed_pool: audit.houseTake?.unclaimedPool ?? null,
      total_house_take: audit.houseTake?.totalHouseTake ?? null,
      completion_reason: audit.completionReason ?? null,
      // A no-contenders settlement stops early: the bulb the cycle settled
      // on is a business decision, not the sealed planned winner written at
      // insert time — overwrite it (or null it, when everyone had cashed
      // out) so the audit row reflects who was actually paid.
      ...(audit.completionReason === 'no_contenders'
        ? { winning_bulb_id: audit.settledBulbId ?? null }
        : {}),
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

/** One entry of the outcome-history read path (GET /api/history) — shaped
 *  exactly like the client's OutcomeHistoryEntry so the fetched seed and
 *  the live websocket-driven entries are interchangeable. */
export interface CycleHistoryEntry {
  cycleId: string;
  bulbId: string;
  bulbNumber: number;
  /** The coefficient the winner was actually PAID at (payout/stake from a
   *  resolved 'won' live_bets row — bots included), i.e. the same frozen
   *  settlement coefficient the live UI showed at cycle_complete. Null when
   *  nobody was left active on the winning bulb (all cashed out, or it was
   *  never staked) — the live UI showed "—" for those, so history must too;
   *  never coerce to 0. */
  coefficient: number | null;
  bulbCount: BulbCount;
  timestamp: number;
}

/** Recent completed cycles for a mode, newest first — the boot-time seed
 *  for the client's Previous Rounds strip. Coefficients come from the
 *  winners' actual resolved payouts (payout = stake × frozen settlement
 *  coefficient — see BulbGameEngine.endCycle), NOT re-derived from pool
 *  math, so history always matches what was displayed live. */
export async function fetchCycleHistory(mode: BulbCount, limit = 30): Promise<CycleHistoryEntry[]> {
  const { data, error } = await supabase
    .from('cycles')
    .select('id, engine_cycle_id, winning_bulb_id, ended_at')
    .eq('mode', mode)
    .eq('status', 'complete')
    .order('ended_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const cycles = (data ?? []) as Array<{
    id: string;
    engine_cycle_id: string;
    winning_bulb_id: string | null;
    ended_at: string;
  }>;
  if (cycles.length === 0) return [];

  const { data: wonRows, error: wonError } = await supabase
    .from('live_bets')
    .select('cycle_id, stake, payout')
    .in('cycle_id', cycles.map((c) => c.id))
    .eq('event_type', 'won');
  if (wonError) throw wonError;

  // All winners on a bulb settle at the same coefficient, so any one won
  // row per cycle is enough.
  const coefficientByCycleId = new Map<string, number>();
  for (const row of (wonRows ?? []) as Array<{ cycle_id: string; stake: number; payout: number | null }>) {
    if (row.payout === null || !(row.stake > 0) || coefficientByCycleId.has(row.cycle_id)) continue;
    coefficientByCycleId.set(row.cycle_id, Number(row.payout) / Number(row.stake));
  }

  return cycles
    .filter((c) => c.winning_bulb_id !== null)
    .map((c) => ({
      cycleId: c.engine_cycle_id,
      bulbId: c.winning_bulb_id!,
      bulbNumber: Number(c.winning_bulb_id!.split('_')[1]),
      coefficient: coefficientByCycleId.get(c.id) ?? null,
      bulbCount: mode,
      timestamp: Date.parse(c.ended_at),
    }));
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
