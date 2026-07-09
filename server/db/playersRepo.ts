/**
 * Player identity + balance. There's no auth system here (out of scope for
 * this backend) — a client persists the `playerId` it's given back (e.g.
 * localStorage) and sends it on every `join`, so reconnecting resumes the
 * same balance and, via the game session's own snapshot, the same
 * in-progress bet if they have one this cycle.
 */
import { supabase } from '../supabaseClient';
import type { PlayerRow } from './types';

const STARTING_BALANCE = 1000;

function randomDisplayName(): string {
  return `Player ${Math.floor(1000 + Math.random() * 9000)}`;
}

/** Looks up an existing player by id; creates a new one (with the
 *  starting balance) if `playerId` is missing or unknown. */
export async function getOrCreatePlayer(playerId?: string): Promise<PlayerRow> {
  if (playerId) {
    const { data, error } = await supabase.from('players').select('*').eq('id', playerId).maybeSingle();
    if (error) throw error;
    if (data) return data as PlayerRow;
    // Unknown id (e.g. a stale localStorage value from a wiped database) —
    // fall through and create a fresh player rather than erroring the
    // connection out.
  }

  const { data, error } = await supabase
    .from('players')
    .insert({ display_name: randomDisplayName(), balance: STARTING_BALANCE })
    .select('*')
    .single();
  if (error) throw error;
  return data as PlayerRow;
}

export async function getPlayerBalance(playerId: string): Promise<number | null> {
  const { data, error } = await supabase.from('players').select('balance').eq('id', playerId).maybeSingle();
  if (error) throw error;
  return data ? Number(data.balance) : null;
}
