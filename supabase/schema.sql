-- ============================================================================
-- Bulb Game — Supabase schema
--
-- Run this once in the Supabase SQL Editor (Project -> SQL Editor -> New
-- query -> paste -> Run). Safe to re-run: tables/indexes use IF NOT EXISTS,
-- views/functions use CREATE OR REPLACE.
--
-- Tables:
--   players       identity + balance
--   cycles        one row per game cycle per mode — the audit-grade record
--                 of exactly what was generated (probabilities, winner,
--                 elimination order) and when
--   bets          one row per player bet, full lifecycle (placed -> resolved)
--   live_bets     recent-activity feed for the right-panel display
-- Views:
--   leaderboard_daily / _weekly / _monthly   top net winners per window
-- Functions:
--   place_bet     atomically decrements balance + inserts a bet row
--   resolve_bet   atomically credits payout (if any) + updates the bet row
--   void_bet      compensating rollback if the engine rejects a bet the
--                 database already accepted (see server/game/GameSession.ts)
-- ============================================================================

create extension if not exists pgcrypto; -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- players: identity + balance
-- ----------------------------------------------------------------------------
create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  display_name text not null default 'Player',
  balance numeric(12, 2) not null default 1000.00 check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists players_touch_updated_at on players;
create trigger players_touch_updated_at
  before update on players
  for each row execute function touch_updated_at();

-- ----------------------------------------------------------------------------
-- cycles: one row per game cycle, per bulb-count mode. This is the
-- audit-grade record of exactly what was generated for that cycle — the
-- winning bulb, the full elimination order (pop order for every other
-- bulb, decided by a fair uniform shuffle — see src/odds/outcomePlan.ts),
-- and the pari-mutuel pool math (final stake per bulb, house cut rate, and
-- the round-by-round eliminated/distributable pool history) needed to
-- independently re-derive every payout later.
-- ----------------------------------------------------------------------------
create table if not exists cycles (
  id uuid primary key default gen_random_uuid(),
  -- The engine's own in-memory cycle id (e.g. "cycle_abc123_1"), kept only
  -- for cross-referencing against server logs — not used as a join key.
  engine_cycle_id text,
  mode smallint not null check (mode in (5, 7, 10)),
  winning_bulb_id text,
  -- Ordered array of bulb ids: elimination_order[0] pops in round 1,
  -- elimination_order[1] in round 2, and so on. Written once, at cycle
  -- start, alongside everything else above — never mutated afterward.
  elimination_order jsonb,
  total_rounds smallint not null,
  status text not null default 'betting' check (status in ('betting', 'active', 'complete', 'cancelled')),
  -- bulb_id -> total stake, locked the instant betting closed. Null until
  -- the cycle finishes (see markCycleComplete in server/db/cyclesRepo.ts).
  final_stake_by_bulb jsonb,
  -- The house-cut fraction actually used for this cycle's pricing — stored
  -- per-cycle so a later config change can't retroactively make an old
  -- cycle's payouts look wrong.
  house_cut_rate numeric(5, 4),
  -- Array of {round, eliminatedPool, distributablePool}, one entry per
  -- round resolved, in order. Null until the cycle finishes.
  round_pool_history jsonb,
  -- House-take breakdown, written once at cycle completion alongside the
  -- fields above (see computeHouseTake() in src/odds/parimutuel.ts). A
  -- cash-out is final — a player who leaves has no further claim on the
  -- cycle — so if everyone who bet on the eventual winning bulb cashed out
  -- early, their share of the pool has no claimant left and stays with the
  -- house on top of the standard edge. Kept as separate numeric columns
  -- (not folded into one jsonb blob) so historical analytics can directly
  -- aggregate/compare "how much came from the flat edge" vs. "how much
  -- came from unclaimed early cash-outs" across many cycles. All null
  -- until the cycle finishes; all null (not zero) for a cancelled cycle,
  -- since a cancelled cycle has no house take at all.
  standard_house_cut numeric(12, 2),
  unclaimed_pool numeric(12, 2),
  total_house_take numeric(12, 2),
  -- Populated only for status='cancelled' (uncontested round — fewer than
  -- 2 bulbs staked, refunded in full, no round played).
  cancel_reason text,
  started_at timestamptz not null default now(),
  betting_closed_at timestamptz,
  ended_at timestamptz
);

create index if not exists cycles_mode_started_at_idx on cycles (mode, started_at desc);

-- ----------------------------------------------------------------------------
-- bets: one row per player bet, tracked through its full lifecycle.
-- ----------------------------------------------------------------------------
create table if not exists bets (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players (id) on delete cascade,
  cycle_id uuid not null references cycles (id) on delete cascade,
  mode smallint not null check (mode in (5, 7, 10)),
  bulb_id text not null,
  stake numeric(12, 2) not null check (stake > 0),
  round_placed smallint not null default 0,
  outcome text not null default 'active' check (outcome in ('active', 'won', 'cashed_out', 'popped')),
  round_resolved smallint,
  -- The exact coefficient the payout was computed from — won: the fixed
  -- cycle-start coefficient; cashed_out: the round-by-round survival-curve
  -- coefficient at that round; popped: null (no payout).
  coefficient_at_resolution numeric(10, 4),
  payout numeric(12, 2),
  placed_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists bets_cycle_id_idx on bets (cycle_id);
create index if not exists bets_player_id_idx on bets (player_id);
-- Mirrors BulbGameEngine's own "one bet per player per cycle" rule —
-- defense in depth at the persistence layer.
create unique index if not exists bets_one_per_player_per_cycle on bets (player_id, cycle_id);

-- ----------------------------------------------------------------------------
-- live_bets: recent-activity feed for the right-panel "Live Bets" display.
-- Deliberately a separate table from `bets` (not a view) so it can be
-- pruned/capped on its own schedule without touching the permanent audit
-- trail in `bets`/`cycles`.
-- ----------------------------------------------------------------------------
create table if not exists live_bets (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid references cycles (id) on delete set null,
  mode smallint not null check (mode in (5, 7, 10)),
  player_id uuid references players (id) on delete set null,
  -- Denormalized on purpose: the feed should keep showing a sensible name
  -- even if the player row is later deleted, and avoids a join for what's
  -- meant to be a cheap, frequent, real-time-ish query.
  display_name text not null,
  bulb_id text not null,
  stake numeric(12, 2) not null,
  -- Null until resolved; stays null forever for a loss ("popped") — never
  -- a literal 0, so the UI can tell "not resolved yet" apart from
  -- "resolved for nothing" (see the earlier Live Bets tab requirement).
  payout numeric(12, 2),
  event_type text not null check (event_type in ('bet_placed', 'won', 'cashed_out', 'popped')),
  created_at timestamptz not null default now()
);

create index if not exists live_bets_mode_created_at_idx on live_bets (mode, created_at desc);

-- ----------------------------------------------------------------------------
-- Leaderboard: day / week / month top net winners, derived from bets.
-- Plain views (not materialized) — recomputed on read. That's cheap enough
-- at this scale and stays automatically consistent with `bets`, with no
-- refresh/update logic to maintain.
-- ----------------------------------------------------------------------------
create or replace view leaderboard_daily as
select
  b.player_id,
  p.display_name,
  sum(coalesce(b.payout, 0) - b.stake) as net_profit,
  count(*) as bets_count
from bets b
join players p on p.id = b.player_id
where b.placed_at >= now() - interval '1 day'
  and b.outcome <> 'active'
group by b.player_id, p.display_name
order by net_profit desc;

create or replace view leaderboard_weekly as
select
  b.player_id,
  p.display_name,
  sum(coalesce(b.payout, 0) - b.stake) as net_profit,
  count(*) as bets_count
from bets b
join players p on p.id = b.player_id
where b.placed_at >= now() - interval '7 days'
  and b.outcome <> 'active'
group by b.player_id, p.display_name
order by net_profit desc;

create or replace view leaderboard_monthly as
select
  b.player_id,
  p.display_name,
  sum(coalesce(b.payout, 0) - b.stake) as net_profit,
  count(*) as bets_count
from bets b
join players p on p.id = b.player_id
where b.placed_at >= now() - interval '30 days'
  and b.outcome <> 'active'
group by b.player_id, p.display_name
order by net_profit desc;

-- ----------------------------------------------------------------------------
-- place_bet: atomically decrements balance + inserts the bet row, so two
-- concurrent bets from the same player can never overdraw their balance —
-- the balance check and the debit happen in the same UPDATE, not as a
-- separate read-then-write from the application.
-- ----------------------------------------------------------------------------
create or replace function place_bet(
  p_player_id uuid,
  p_cycle_id uuid,
  p_mode smallint,
  p_bulb_id text,
  p_stake numeric,
  p_round smallint default 0
) returns bets as $$
declare
  v_bet bets;
begin
  update players
     set balance = balance - p_stake
   where id = p_player_id
     and balance >= p_stake;

  if not found then
    raise exception 'insufficient_balance';
  end if;

  insert into bets (player_id, cycle_id, mode, bulb_id, stake, round_placed)
  values (p_player_id, p_cycle_id, p_mode, p_bulb_id, p_stake, p_round)
  returning * into v_bet;

  return v_bet;
end;
$$ language plpgsql security definer;

-- ----------------------------------------------------------------------------
-- resolve_bet: atomically credits the payout (if any) + updates the bet
-- row's final outcome. Called once per bet, when the engine reports it as
-- popped, cashed out, or won.
-- ----------------------------------------------------------------------------
create or replace function resolve_bet(
  p_bet_id uuid,
  p_outcome text,
  p_round smallint,
  p_coefficient numeric,
  p_payout numeric
) returns bets as $$
declare
  v_bet bets;
begin
  if p_payout is not null and p_payout > 0 then
    update players
       set balance = balance + p_payout
     where id = (select player_id from bets where id = p_bet_id);
  end if;

  update bets
     set outcome = p_outcome,
         round_resolved = p_round,
         coefficient_at_resolution = p_coefficient,
         payout = p_payout,
         resolved_at = now()
   where id = p_bet_id
  returning * into v_bet;

  return v_bet;
end;
$$ language plpgsql security definer;

-- ----------------------------------------------------------------------------
-- void_bet: compensating rollback. Refunds the stake and deletes the bet
-- row. Used only for the rare race where the database accepted a bet
-- (balance debited) but the in-memory engine then rejected it (e.g. the
-- betting window closed in the few milliseconds of network round-trip) —
-- see GameSession.placeBet(). Keeps balance/bets consistent with the
-- actual, authoritative game state.
-- ----------------------------------------------------------------------------
create or replace function void_bet(p_bet_id uuid)
returns void as $$
declare
  v_player_id uuid;
  v_stake numeric;
begin
  select player_id, stake into v_player_id, v_stake from bets where id = p_bet_id;
  if v_player_id is null then
    return;
  end if;

  update players set balance = balance + v_stake where id = v_player_id;
  delete from bets where id = p_bet_id;
end;
$$ language plpgsql security definer;

-- ----------------------------------------------------------------------------
-- Row Level Security: locked down by default. This backend talks to
-- Supabase with the service_role key, which bypasses RLS entirely, so no
-- permissive policies are defined here — safe by default (anon/authenticated
-- roles get no access at all) until a future direct-from-browser integration
-- explicitly needs scoped read access, at which point add narrow policies
-- rather than removing this.
-- ----------------------------------------------------------------------------
alter table players enable row level security;
alter table cycles enable row level security;
alter table bets enable row level security;
alter table live_bets enable row level security;

-- ============================================================================
-- MIGRATION — pari-mutuel odds model (run once against an existing database
-- that already has the ORIGINAL `cycles` table from the fixed-odds model).
-- Safe to re-run: every step is IF EXISTS / IF NOT EXISTS. Paste this whole
-- block into the Supabase SQL Editor and run it. A fresh database created
-- from the `create table` above already has the new shape and does not
-- need this section.
-- ============================================================================

-- Drop the fixed-odds-only columns — no longer produced by the engine.
alter table cycles drop column if exists shape;
alter table cycles drop column if exists probabilities;
alter table cycles drop column if exists fixed_coefficients;

-- Add the pari-mutuel audit columns.
alter table cycles add column if not exists final_stake_by_bulb jsonb;
alter table cycles add column if not exists house_cut_rate numeric(5, 4);
alter table cycles add column if not exists round_pool_history jsonb;
alter table cycles add column if not exists cancel_reason text;

-- Add the "unclaimed pool" house-take breakdown (see computeHouseTake() in
-- src/odds/parimutuel.ts) — separate columns for the flat 5% edge vs. the
-- portion left unclaimed because everyone on the winning bulb had already
-- cashed out, so historical data can distinguish the two sources of take.
alter table cycles add column if not exists standard_house_cut numeric(12, 2);
alter table cycles add column if not exists unclaimed_pool numeric(12, 2);
alter table cycles add column if not exists total_house_take numeric(12, 2);

-- Widen the status check constraint to allow 'cancelled' (uncontested
-- rounds, refunded in full). Constraint names are auto-generated by
-- Postgres as "<table>_<column>_check" unless overridden — this matches
-- what `create table ... check (...)` produces by default.
alter table cycles drop constraint if exists cycles_status_check;
alter table cycles add constraint cycles_status_check
  check (status in ('betting', 'active', 'complete', 'cancelled'));
