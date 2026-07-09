/**
 * Persistence for the `bets` table, via the atomic SQL functions in
 * supabase/schema.sql (place_bet / resolve_bet / void_bet) rather than
 * separate read-then-write calls from here — see GameSession for why
 * that matters (concurrent bets can't overdraw a balance).
 */
import { supabase } from '../supabaseClient';
import type { BulbCount } from '../../src/index';
import type { BetOutcome, BetRow } from './types';

export class InsufficientBalanceError extends Error {
  constructor() {
    super('insufficient_balance');
    this.name = 'InsufficientBalanceError';
  }
}

export async function placeBet(params: {
  playerId: string;
  cycleId: string;
  mode: BulbCount;
  bulbId: string;
  stake: number;
  round?: number;
}): Promise<BetRow> {
  const { data, error } = await supabase.rpc('place_bet', {
    p_player_id: params.playerId,
    p_cycle_id: params.cycleId,
    p_mode: params.mode,
    p_bulb_id: params.bulbId,
    p_stake: params.stake,
    p_round: params.round ?? 0,
  });
  if (error) {
    if (error.message?.includes('insufficient_balance')) throw new InsufficientBalanceError();
    throw error;
  }
  return data as BetRow;
}

export async function resolveBet(params: {
  betId: string;
  outcome: Extract<BetOutcome, 'won' | 'cashed_out' | 'popped'>;
  round: number;
  coefficient: number | null;
  payout: number | null;
}): Promise<BetRow> {
  const { data, error } = await supabase.rpc('resolve_bet', {
    p_bet_id: params.betId,
    p_outcome: params.outcome,
    p_round: params.round,
    p_coefficient: params.coefficient,
    p_payout: params.payout,
  });
  if (error) throw error;
  return data as BetRow;
}

/** Compensating rollback — see void_bet() in schema.sql for when this is used. */
export async function voidBet(betId: string): Promise<void> {
  const { error } = await supabase.rpc('void_bet', { p_bet_id: betId });
  if (error) throw error;
}

/** The caller's own bet in a given cycle, if any — used on join/reconnect
 *  so a client can be told about an in-progress bet even before the next
 *  engine event fires (the engine's own snapshot.players already carries
 *  this too, since bet ids and engine player ids are the same value, but
 *  this is a convenient direct lookup for the "welcome" payload). */
export async function findPlayerBetInCycle(playerId: string, cycleId: string): Promise<BetRow | null> {
  const { data, error } = await supabase
    .from('bets')
    .select('*')
    .eq('player_id', playerId)
    .eq('cycle_id', cycleId)
    .maybeSingle();
  if (error) throw error;
  return (data as BetRow) ?? null;
}
