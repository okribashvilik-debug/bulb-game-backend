/**
 * Simulation harness for the pari-mutuel odds engine.
 *
 * There is no fixed RTP target to converge to anymore — house take is now
 * an emergent consequence of how stakes happen to be distributed across
 * bulbs in a given cycle, not a guaranteed constant. This harness instead
 * runs a range of realistic player-count / stake-distribution scenarios and
 * reports the ACTUAL house take as a percentage of total volume wagered,
 * so it can be eyeballed for sanity (e.g. "does it ever pay out more than
 * was staked?") rather than asserted against a target percentage.
 *
 * Two simulation modes live in this file:
 *
 *  - runPariMutuelSimulation() — every player holds to natural resolution
 *    (never cashes out early). Cash-out pricing uses the exact same formula
 *    as the final win payout (see parimutuel.ts), so hold-to-resolution
 *    already exercises the whole pricing model on its own; kept as-is since
 *    it's the simplest possible measurement and existing tests depend on it.
 *  - runCashOutBehaviorSimulation() — actually drives round-by-round
 *    cash-out decisions (see CashOutBehavior below) and reports the full
 *    distribution of house take, not just an average. The standard 5%
 *    house-cut rate is a FLOOR under this model, not a ceiling: when
 *    everyone who bet on the eventual winning bulb cashes out before the
 *    cycle ends, their share of the final distributable pool has no
 *    claimant left and stays with the house too (see computeHouseTake() in
 *    parimutuel.ts) — this function is what surfaces how much that actually
 *    adds up to, across many cycles and behavior patterns, instead of
 *    leaving it as an implicit side effect nobody measured.
 */
import { isCashOutCheckpoint } from '../checkpoints';
import { computeCoefficients, computeEliminatedPool, totalStakeByBulbId } from './parimutuel';
import { planCycleOutcome } from './outcomePlan';
import { DEFAULT_ODDS_CONFIG, type OddsConfig } from './config';
import { DefaultRandomSource, type RandomSource } from '../rng';
import type { Bulb, BulbCount, Player } from '../types';

export interface StakeScenario {
  name: string;
  /** Generates one cycle's bettors: which bulb (1-based index into
   *  bulbIds) each stakes on, and how much. */
  generateStakes(bulbCount: number, rng: RandomSource): Array<{ bulbIndex: number; stake: number }>;
}

export interface PariMutuelSimulationResult {
  scenario: string;
  bulbCount: BulbCount;
  cycles: number;
  totalWagered: number;
  totalPaidOut: number;
  /** 1 - totalPaidOut/totalWagered. Variable by design — not a target. */
  houseTakePct: number;
  /** Cycles where fewer than 2 bulbs received any stake at all, and so were
   *  auto-cancelled/refunded rather than played (excluded from the wagered/
   *  paid-out totals above, since a refunded cycle has no house take). */
  uncontestedCycles: number;
}

function makeBulbIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `bulb_${i + 1}`);
}

/** Runs one scenario across `cycles` simulated cycles, playing every bet to
 *  natural resolution, and reports the resulting house take. */
export function runPariMutuelSimulation(options: {
  bulbCount: BulbCount;
  cycles: number;
  scenario: StakeScenario;
  config?: OddsConfig;
  rng?: RandomSource;
}): PariMutuelSimulationResult {
  const { bulbCount, cycles, scenario, config = DEFAULT_ODDS_CONFIG, rng = new DefaultRandomSource() } = options;
  const bulbIds = makeBulbIds(bulbCount);

  let totalWagered = 0;
  let totalPaidOut = 0;
  let uncontestedCycles = 0;

  for (let cycle = 0; cycle < cycles; cycle++) {
    const stakes = scenario.generateStakes(bulbCount, rng);
    const players: Player[] = stakes.map((s, i) => ({
      id: `p${i}`,
      bulbId: bulbIds[s.bulbIndex]!, // scenario generators always produce an in-range index
      stake: s.stake,
      status: 'active' as const,
    }));

    const contestedBulbCount = new Set(players.map((p) => p.bulbId)).size;
    if (contestedBulbCount < 2) {
      uncontestedCycles += 1;
      continue; // refunded — no wager stands, no house take
    }

    const { winningBulbId, eliminationOrder } = planCycleOutcome(bulbIds, rng);
    const bulbs: Bulb[] = bulbIds.map((id) => ({ id, status: 'alive' as const }));

    // Reveal pops one at a time, exactly as the real engine does, pricing
    // every remaining bulb after each pop — the winner is only priced once
    // every other bulb has already popped, which is what makes the win
    // payout fall out of the same formula as a mid-round cash-out.
    for (const poppedId of eliminationOrder) {
      const popped = bulbs.find((b) => b.id === poppedId)!;
      popped.status = 'popped';
    }

    const coefficients = computeCoefficients(bulbs, players, config.houseCutRate);
    for (const player of players) {
      totalWagered += player.stake;
      if (player.bulbId === winningBulbId) {
        const coefficient = coefficients.get(player.bulbId);
        if (coefficient !== undefined) {
          totalPaidOut += player.stake * coefficient;
        }
      }
    }
  }

  return {
    scenario: scenario.name,
    bulbCount,
    cycles,
    totalWagered,
    totalPaidOut,
    houseTakePct: totalWagered > 0 ? 1 - totalPaidOut / totalWagered : 0,
    uncontestedCycles,
  };
}

// -------------------------------------------------------------------------
// Representative scenarios
// -------------------------------------------------------------------------

function randomStake(rng: RandomSource): number {
  const pool = [1, 2, 5, 10, 20, 25, 50, 100];
  return pool[Math.floor(rng.next() * pool.length)]!; // index always in range
}

/** Every bulb gets exactly one bettor, evenly spread, stakes randomized. */
export const evenSpreadScenario: StakeScenario = {
  name: 'even spread (1 bettor per bulb)',
  generateStakes: (bulbCount, rng) =>
    Array.from({ length: bulbCount }, (_, i) => ({ bulbIndex: i, stake: randomStake(rng) })),
};

/** Just two players, one bulb each — the minimum contested cycle. */
export const twoPlayersScenario: StakeScenario = {
  name: '2 players, 1 bulb each',
  generateStakes: (bulbCount, rng) => {
    const a = Math.floor(rng.next() * bulbCount);
    let b = Math.floor(rng.next() * bulbCount);
    while (b === a) b = Math.floor(rng.next() * bulbCount);
    return [
      { bulbIndex: a, stake: randomStake(rng) },
      { bulbIndex: b, stake: randomStake(rng) },
    ];
  },
};

/** Ten players scattered across bulbs at random (some bulbs may get several,
 *  some may get none). */
export const tenPlayersScenario: StakeScenario = {
  name: '10 players, scattered',
  generateStakes: (bulbCount, rng) =>
    Array.from({ length: 10 }, () => ({
      bulbIndex: Math.floor(rng.next() * bulbCount),
      stake: randomStake(rng),
    })),
};

/** Heavy stake concentration: most players pile onto one favorite bulb,
 *  with a handful of longshot bettors scattered on the rest. */
export const concentratedScenario: StakeScenario = {
  name: 'concentrated (most stake on one bulb)',
  generateStakes: (bulbCount, rng) => {
    const favorite = Math.floor(rng.next() * bulbCount);
    const bets = Array.from({ length: 8 }, () => ({ bulbIndex: favorite, stake: randomStake(rng) }));
    for (let i = 0; i < bulbCount; i++) {
      if (i === favorite) continue;
      if (rng.next() < 0.5) bets.push({ bulbIndex: i, stake: randomStake(rng) });
    }
    return bets;
  },
};

/** Only one bulb ever receives a stake — the uncontested/cancelled case. */
export const uncontestedScenario: StakeScenario = {
  name: 'uncontested (all stake on 1 bulb)',
  generateStakes: (bulbCount, rng) =>
    Array.from({ length: 5 }, () => ({ bulbIndex: 0, stake: randomStake(rng) })),
};

export const ALL_SCENARIOS: StakeScenario[] = [
  twoPlayersScenario,
  evenSpreadScenario,
  tenPlayersScenario,
  concentratedScenario,
  uncontestedScenario,
];

// -------------------------------------------------------------------------
// Cash-out behavior simulation — the "unclaimed pool" harness
// -------------------------------------------------------------------------

/** A strategy for deciding, at each cash-out checkpoint, whether an active
 *  player takes the money now. Applied independently to every active player
 *  at every checkpoint their bulb is still alive for. */
export interface CashOutBehavior {
  name: string;
  shouldCashOut(rng: RandomSource): boolean;
}

/** Nobody ever cashes out — equivalent in outcome to runPariMutuelSimulation,
 *  included here so it's directly comparable against the other behaviors
 *  under the exact same round-by-round machinery. */
export const neverCashOutBehavior: CashOutBehavior = {
  name: 'nobody cashes out (hold to resolution)',
  shouldCashOut: () => false,
};

/** Every active player cashes out the first chance they get. The scenario
 *  the task's "unclaimed pool" behavior is named for: if this empties out
 *  the eventual winning bulb before the cycle ends, its whole final share
 *  of the pool goes unclaimed. */
export const alwaysCashOutBehavior: CashOutBehavior = {
  name: 'everyone cashes out at first opportunity',
  shouldCashOut: () => true,
};

/** Each active player independently has a fixed per-checkpoint chance of
 *  cashing out — a rough stand-in for a mixed real-world player base. */
export const mixedCashOutBehavior: CashOutBehavior = {
  name: 'mixed (~40% chance to cash out per checkpoint)',
  shouldCashOut: (rng) => rng.next() < 0.4,
};

export const ALL_CASHOUT_BEHAVIORS: CashOutBehavior[] = [
  neverCashOutBehavior,
  alwaysCashOutBehavior,
  mixedCashOutBehavior,
];

/** One simulated cycle's money-conservation ledger: every dollar wagered is
 *  either paid out (at a cash-out, on any bulb, at any round, or as the
 *  final win payout) or kept by the house. `standardCut`/`unclaimedPool`
 *  additionally break down the house's take at FINAL settlement only (see
 *  computeHouseTake()) — a subset of `houseTake`, not the whole of it,
 *  since an early cash-out on a bulb that later loses is a separate payout
 *  event already reflected in `paidOut`, not part of either breakdown term. */
export interface CycleHouseTakeSample {
  wagered: number;
  paidOut: number;
  houseTake: number;
  houseTakePct: number;
  standardCut: number;
  unclaimedPool: number;
}

function simulateCycleWithCashOuts(
  bulbCount: BulbCount,
  stakes: Array<{ bulbIndex: number; stake: number }>,
  rng: RandomSource,
  config: OddsConfig,
  behavior: CashOutBehavior,
): CycleHouseTakeSample | undefined {
  const bulbIds = makeBulbIds(bulbCount);
  const players: Player[] = stakes.map((s, i) => ({
    id: `p${i}`,
    bulbId: bulbIds[s.bulbIndex]!, // scenario generators always produce an in-range index
    stake: s.stake,
    status: 'active' as const,
  }));

  const contestedBulbCount = new Set(players.map((p) => p.bulbId)).size;
  if (contestedBulbCount < 2) return undefined; // refunded — no wager stands, no house take

  const { winningBulbId, eliminationOrder } = planCycleOutcome(bulbIds, rng);
  const bulbs: Bulb[] = bulbIds.map((id) => ({ id, status: 'alive' as const }));
  const wagered = players.reduce((sum, p) => sum + p.stake, 0);
  let paidOut = 0;

  for (const poppedId of eliminationOrder) {
    const popped = bulbs.find((b) => b.id === poppedId)!;
    popped.status = 'popped';
    for (const p of players) {
      if (p.bulbId === popped.id && p.status === 'active') p.status = 'popped';
    }

    const aliveCount = bulbs.filter((b) => b.status === 'alive').length;
    if (!isCashOutCheckpoint(bulbCount, aliveCount)) continue;

    // Live coefficients as of right now — same formula every mid-round
    // cash-out and the final win payout both use, just evaluated early.
    const coefficients = computeCoefficients(bulbs, players, config.houseCutRate);
    for (const p of players) {
      if (p.status !== 'active') continue;
      if (!behavior.shouldCashOut(rng)) continue;
      const coefficient = coefficients.get(p.bulbId);
      if (coefficient === undefined) continue; // can't happen: an active player always has stake on an alive bulb
      paidOut += p.stake * coefficient;
      p.status = 'cashed_out';
    }
  }

  // Final settlement: every bulb but the winner is now 'popped'.
  const finalStakeByBulbId = totalStakeByBulbId(players);
  const eliminatedPool = computeEliminatedPool(bulbs, finalStakeByBulbId);
  const standardCut = config.houseCutRate * eliminatedPool;
  const distributablePool = eliminatedPool - standardCut;
  const finalCoefficients = computeCoefficients(bulbs, players, config.houseCutRate);

  let claimedByWinners = 0;
  for (const p of players) {
    if (p.bulbId !== winningBulbId || p.status !== 'active') continue;
    const coefficient = finalCoefficients.get(p.bulbId)!;
    const value = p.stake * coefficient;
    paidOut += value;
    claimedByWinners += value;
  }
  const unclaimedPool = Math.max(0, distributablePool - claimedByWinners);
  const houseTake = wagered - paidOut;

  return {
    wagered,
    paidOut,
    houseTake,
    houseTakePct: wagered > 0 ? houseTake / wagered : 0,
    standardCut,
    unclaimedPool,
  };
}

export interface CashOutSimulationResult {
  scenario: string;
  behavior: string;
  bulbCount: BulbCount;
  cycles: number;
  contestedCycles: number;
  uncontestedCycles: number;
  totalWagered: number;
  totalPaidOut: number;
  /** (totalWagered - totalPaidOut) / totalWagered — the aggregate take
   *  across every contested cycle combined, same shape as
   *  PariMutuelSimulationResult.houseTakePct. */
  aggregateHouseTakePct: number;
  /** Distribution of PER-CYCLE house-take-as-%-of-that-cycle's-own-wagered
   *  volume, across every contested cycle. This is what actually shows the
   *  5% edge is a floor, not a ceiling — min/max/median can sit well above
   *  (or, in principle, below) the aggregate depending on cash-out timing. */
  distribution: { min: number; max: number; median: number; average: number };
  /** Standard 5%-edge and unclaimed-pool shares, each as a fraction of
   *  total volume wagered across contested cycles — the same split
   *  computeHouseTake() logs per-cycle in the audit trail, aggregated here
   *  so the two sources of house take are visible independently at scale. */
  standardCutShareOfVolume: number;
  unclaimedPoolShareOfVolume: number;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Runs one (scenario x cash-out behavior) combination across `cycles`
 *  simulated cycles and reports the full house-take distribution, not just
 *  an average — see CashOutSimulationResult. */
export function runCashOutBehaviorSimulation(options: {
  bulbCount: BulbCount;
  cycles: number;
  scenario: StakeScenario;
  behavior: CashOutBehavior;
  config?: OddsConfig;
  rng?: RandomSource;
}): CashOutSimulationResult {
  const {
    bulbCount,
    cycles,
    scenario,
    behavior,
    config = DEFAULT_ODDS_CONFIG,
    rng = new DefaultRandomSource(),
  } = options;

  let uncontestedCycles = 0;
  let totalWagered = 0;
  let totalPaidOut = 0;
  let totalStandardCut = 0;
  let totalUnclaimedPool = 0;
  const perCyclePct: number[] = [];

  for (let i = 0; i < cycles; i++) {
    const stakes = scenario.generateStakes(bulbCount, rng);
    const sample = simulateCycleWithCashOuts(bulbCount, stakes, rng, config, behavior);
    if (!sample) {
      uncontestedCycles += 1;
      continue;
    }
    totalWagered += sample.wagered;
    totalPaidOut += sample.paidOut;
    totalStandardCut += sample.standardCut;
    totalUnclaimedPool += sample.unclaimedPool;
    perCyclePct.push(sample.houseTakePct);
  }

  const sortedPct = [...perCyclePct].sort((a, b) => a - b);

  return {
    scenario: scenario.name,
    behavior: behavior.name,
    bulbCount,
    cycles,
    contestedCycles: cycles - uncontestedCycles,
    uncontestedCycles,
    totalWagered,
    totalPaidOut,
    aggregateHouseTakePct: totalWagered > 0 ? (totalWagered - totalPaidOut) / totalWagered : 0,
    distribution: {
      min: sortedPct.length > 0 ? sortedPct[0]! : 0,
      max: sortedPct.length > 0 ? sortedPct[sortedPct.length - 1]! : 0,
      median: median(sortedPct),
      average: sortedPct.length > 0 ? sortedPct.reduce((a, b) => a + b, 0) / sortedPct.length : 0,
    },
    standardCutShareOfVolume: totalWagered > 0 ? totalStandardCut / totalWagered : 0,
    unclaimedPoolShareOfVolume: totalWagered > 0 ? totalUnclaimedPool / totalWagered : 0,
  };
}
