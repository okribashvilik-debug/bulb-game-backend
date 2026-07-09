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
 * Every simulated player holds to natural resolution (never cashes out
 * early) — cash-out pricing uses the exact same formula as the final win
 * payout (see parimutuel.ts), so simulating hold-to-resolution already
 * exercises the whole pricing model; timing strategy doesn't change the
 * house's total take, only which round an individual player is paid at.
 */
import { computeCoefficients } from './parimutuel';
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
      bulbId: bulbIds[s.bulbIndex],
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
  return pool[Math.floor(rng.next() * pool.length)];
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
