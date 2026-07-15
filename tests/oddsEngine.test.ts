/**
 * Pari-mutuel odds/payout engine test suite (Node's built-in test runner —
 * no extra dependency needed). Covers, roughly in order:
 *
 *  1. The core coefficient formula, tested exactly (no RNG involved),
 *     including the "undefined for zero stake" rule.
 *  2. Outcome planning: winner and elimination order are now UNIFORM random
 *     — statistically even across bulbs, not weighted by anything — since
 *     there's no probability shape left to weight by. Elimination order
 *     still accounts for every bulb exactly once.
 *  3. Full BulbGameEngine integration, driven manually (no real timers):
 *     no coefficients shown before round 1, coefficients only increase
 *     round-over-round, and the winner is paid via the exact same live
 *     formula as a mid-round cash-out.
 *  4. The uncontested-round rule: fewer than 2 bulbs staked -> the round is
 *     cancelled, everyone is refunded in full, no round is played.
 *  5. The checkpoint restructure + fixed timing constants — unaffected by
 *     this model swap, reverified so a future change can't silently break
 *     them alongside the pricing model.
 *  6. House-take sanity across representative scenarios (2 players, 10
 *     players, concentrated stakes, uncontested) — a measurement, not a
 *     fixed target; asserts only that it never goes negative (never pays
 *     out more than the pool actually allows).
 *  7. The "unclaimed pool" house-take breakdown (computeHouseTake()): a
 *     cash-out is final, so if everyone on the winning bulb already left,
 *     their share of the final pool has no claimant and stays with the
 *     house on top of the standard cut.
 *  8. The cash-out-behavior RTP harness (runCashOutBehaviorSimulation()):
 *     reports a full house-take DISTRIBUTION (min/max/median/average), not
 *     one average — and proves the shared-pool invariant at scale: total
 *     pool payouts (all cash-outs + the final win) never exceed 95% of the
 *     cycle's effective eliminated stakes, so house take can never go
 *     negative, under every behavior pattern and bulb count. (This replaces
 *     the old pinned test that documented the pre-PoolLedger double-payout
 *     bug, where every alive bulb priced independently off a full copy of
 *     the same pool and the minimum house take could go negative.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { BulbGameEngine } from '../src/BulbGameEngine';
import { CHECKPOINTS_BY_BULB_COUNT } from '../src/checkpoints';
import type { Clock, TimerHandle } from '../src/clock';
import { DEFAULT_ODDS_CONFIG } from '../src/odds/config';
import { PoolLedger, computeCoefficient, computeHouseTake } from '../src/odds/parimutuel';
import type { BulbGameEvents } from '../src/events';
import { planCycleOutcome } from '../src/odds/outcomePlan';
import { PariMutuelEngine, type OddsProvider } from '../src/odds/PariMutuelEngine';
import {
  ALL_CASHOUT_BEHAVIORS,
  ALL_SCENARIOS,
  alwaysCashOutBehavior,
  evenSpreadScenario,
  neverCashOutBehavior,
  runCashOutBehaviorSimulation,
  runPariMutuelSimulation,
  simulateCycleWithCashOuts,
  tenPlayersScenario,
} from '../src/odds/rtpSimulation';
import { DefaultRandomSource, type RandomSource } from '../src/rng';
import type { Bulb, Player } from '../src/types';

// A deterministic, seedable RNG (mulberry32) so tests are reproducible
// instead of depending on Math.random().
function seededRng(seed: number): RandomSource {
  let a = seed >>> 0;
  return {
    next(): number {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

function player(id: string, bulbId: string, stake: number, status: Player['status'] = 'active'): Player {
  return { id, bulbId, stake, status };
}

function bulb(id: string, status: Bulb['status'] = 'alive'): Bulb {
  return { id, status };
}

// -------------------------------------------------------------------------
// 1. Coefficient formula — exact, no RNG
// -------------------------------------------------------------------------

test('computeCoefficient: 1 + bulbPoolShare / activeStakeOnBulb', () => {
  // A bulb reserved a 95 pool share with 50 active stake: 1 + 95/50 = 2.9
  const coeff = computeCoefficient(50, 95);
  assert.ok(Math.abs(coeff! - 2.9) < 1e-9, `expected 2.9, got ${coeff}`);
});

test('computeCoefficient: zero pool share (round 1, nothing popped yet) gives exactly 1.0', () => {
  const coeff = computeCoefficient(50, 0);
  assert.equal(coeff, 1);
});

test('computeCoefficient: undefined (not 0, not a fallback) when nobody staked on the bulb', () => {
  assert.equal(computeCoefficient(0, 500), undefined);
});

test('PoolLedger.coefficients: only alive AND actively-staked bulbs get an entry — popped, unstaked, or fully-cashed-out bulbs are omitted', () => {
  const bulbs = [bulb('bulb_1', 'popped'), bulb('bulb_2'), bulb('bulb_3')];
  const players = [player('p1', 'bulb_1', 10, 'popped'), player('p2', 'bulb_2', 20)];
  // bulb_3 is alive but nobody staked on it; bulb_1 is popped (its stake IS
  // part of the eliminated pool, but it can't itself receive a live entry).
  const ledger = new PoolLedger(0.05);
  ledger.recordElimination(10); // bulb_1's active stake entered the pool
  const coefficients = ledger.coefficients(bulbs, players);

  assert.equal(coefficients.size, 1);
  assert.ok(coefficients.has('bulb_2'));
  assert.ok(!coefficients.has('bulb_1'));
  assert.ok(!coefficients.has('bulb_3'));
  // remainingPool = 0.95 * 10 = 9.5; bulb_2 is the ONLY alive staked bulb
  // (N = 1), so it gets the whole share: coefficient = 1 + 9.5/20 = 1.475
  assert.ok(Math.abs(coefficients.get('bulb_2')! - 1.475) < 1e-9);
});

test('PoolLedger.coefficients: alive bulbs with very different stakes share ONE coefficient, so payouts scale with stake and total possible claims never exceed the pool', () => {
  const bulbs = [bulb('bulb_1', 'popped'), bulb('bulb_2'), bulb('bulb_3'), bulb('bulb_4')];
  const players = [
    player('p1', 'bulb_1', 100, 'popped'),
    player('p2', 'bulb_2', 10),
    player('p3', 'bulb_3', 40),
  ];
  const ledger = new PoolLedger(0.05);
  ledger.recordElimination(100); // remainingPool = 95

  // Total alive active stake = 10 + 40 = 50 -> shared coefficient
  // 1 + 95/50 = 2.9 for BOTH bulbs — no small-stake multiplier exploit.
  const coefficients = ledger.coefficients(bulbs, players);
  assert.ok(Math.abs(coefficients.get('bulb_2')! - 2.9) < 1e-9);
  assert.ok(Math.abs(coefficients.get('bulb_3')! - 2.9) < 1e-9);

  // The invariant in miniature: if EVERY active player cashes out at these
  // prices, the pool is drained to exactly zero — never overdrawn — and
  // payouts are stake-proportional (the 40 bettor takes 4× the 10 bettor).
  const paidP2 = ledger.claim(10, coefficients.get('bulb_2')!);
  const paidP3 = ledger.claim(40, coefficients.get('bulb_3')!);
  assert.ok(Math.abs(paidP2 - 29) < 1e-9);
  assert.ok(Math.abs(paidP3 - 116) < 1e-9);
  assert.ok(Math.abs(ledger.remainingPool) < 1e-9, `pool should be exactly drained, got ${ledger.remainingPool}`);
});

test('PoolLedger.claim: depletes the shared pool, so a later window reprices against what actually remains', () => {
  const bulbs = [bulb('bulb_1', 'popped'), bulb('bulb_2'), bulb('bulb_3')];
  const players = [
    player('p1', 'bulb_1', 100, 'popped'),
    player('p2', 'bulb_2', 10),
    player('p3', 'bulb_3', 40),
  ];
  const ledger = new PoolLedger(0.05);
  ledger.recordElimination(100); // remainingPool = 95

  // p2 cashes out at the shared price 1 + 95/50 = 2.9: claims 10×1.9 = 19.
  const coefficients = ledger.coefficients(bulbs, players);
  ledger.claim(10, coefficients.get('bulb_2')!);
  players[1] = player('p2', 'bulb_2', 10, 'cashed_out');
  assert.ok(Math.abs(ledger.remainingPool - 76) < 1e-9);

  // bulb_3 is now the only alive staked bulb — it prices against the
  // DEPLETED 76, not a fresh copy of 95. This is the bug fix.
  const repriced = ledger.coefficients(bulbs, players);
  assert.ok(Math.abs(repriced.get('bulb_3')! - (1 + 76 / 40)) < 1e-9);
});

// -------------------------------------------------------------------------
// 2. Outcome planning — uniform random, not weighted
// -------------------------------------------------------------------------

test('planCycleOutcome: elimination order contains every bulb except the winner, exactly once', () => {
  const bulbIds = ['bulb_1', 'bulb_2', 'bulb_3', 'bulb_4', 'bulb_5', 'bulb_6', 'bulb_7'];
  const plan = planCycleOutcome(bulbIds, seededRng(2));

  assert.equal(plan.eliminationOrder.length, bulbIds.length - 1);
  assert.ok(!plan.eliminationOrder.includes(plan.winningBulbId));
  assert.deepEqual(
    [...plan.eliminationOrder].sort(),
    bulbIds.filter((id) => id !== plan.winningBulbId).sort(),
  );
});

test('planCycleOutcome: winner is uniform random — every bulb wins roughly equally often, none dominates', () => {
  const bulbIds = ['A', 'B', 'C', 'D'];
  const rng = seededRng(42);
  const wins: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
  const trials = 8000;

  for (let i = 0; i < trials; i++) {
    wins[planCycleOutcome(bulbIds, rng).winningBulbId] += 1;
  }

  const expected = trials / bulbIds.length;
  for (const id of bulbIds) {
    const deviation = Math.abs(wins[id] - expected) / expected;
    assert.ok(deviation < 0.15, `${id} won ${wins[id]}/${trials}, expected roughly ${expected} (deviation ${deviation})`);
  }
});

test('planCycleOutcome: elimination position is also uniform — no bulb is systematically first or last', () => {
  const bulbIds = ['A', 'B', 'C', 'D', 'E'];
  const rng = seededRng(7);
  const positionSums: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const trials = 6000;

  for (let i = 0; i < trials; i++) {
    const plan = planCycleOutcome(bulbIds, rng);
    // winner gets position = eliminationOrder.length (survives every round);
    // everyone else's position is their index in eliminationOrder.
    for (const id of bulbIds) {
      const idx = plan.eliminationOrder.indexOf(id);
      positionSums[id] += idx === -1 ? plan.eliminationOrder.length : idx;
    }
  }

  const avgs = bulbIds.map((id) => positionSums[id] / trials);
  const overallAvg = avgs.reduce((a, b) => a + b, 0) / avgs.length;
  for (const [id, avg] of bulbIds.map((id, i) => [id, avgs[i]] as const)) {
    const deviation = Math.abs(avg - overallAvg) / overallAvg;
    assert.ok(deviation < 0.15, `${id}'s average position ${avg} deviates too far from the overall average ${overallAvg}`);
  }
});

// -------------------------------------------------------------------------
// 3. Full engine integration (deterministic — no real timers)
// -------------------------------------------------------------------------

const manualClock: Clock = {
  setTimeout: (): TimerHandle => 0 as unknown as TimerHandle,
  clearTimeout: () => {},
};

test('BulbGameEngine: no coefficients are shown during betting or calculating — nothing can be priced yet', () => {
  const engine = new BulbGameEngine({ clock: manualClock, oddsProvider: new PariMutuelEngine(undefined, seededRng(1)) });
  engine.startCycle(5);
  assert.deepEqual(engine.getSnapshot().liveCoefficients, {});

  engine.placeBet('p1', 'bulb_1', 10);
  engine.placeBet('p2', 'bulb_2', 20);
  assert.deepEqual(engine.getSnapshot().liveCoefficients, {}, 'still betting — no coefficients');

  engine.closeBetting();
  assert.equal(engine.getState(), 'calculating');
  assert.deepEqual(engine.getSnapshot().liveCoefficients, {}, 'calculating — stakes locked but nothing revealed yet');
});

test('BulbGameEngine: coefficients appear at round 1, populated only for staked bulbs, and only increase from there', () => {
  const engine = new BulbGameEngine({ clock: manualClock, oddsProvider: new PariMutuelEngine(undefined, seededRng(9)) });
  engine.startCycle(7);

  engine.placeBet('p1', 'bulb_1', 10);
  engine.placeBet('p2', 'bulb_2', 10);
  engine.placeBet('p3', 'bulb_3', 10);
  // bulb_4..bulb_7 receive no stake at all.
  engine.closeBetting();
  engine.finishCalculating();
  assert.equal(engine.getState(), 'round_active');

  const round1Coefficients = engine.getSnapshot().liveCoefficients;
  assert.deepEqual(Object.keys(round1Coefficients).sort(), ['bulb_1', 'bulb_2', 'bulb_3']);
  // Round 1: nothing has popped yet, so eliminatedPool = 0 for every bulb.
  for (const id of ['bulb_1', 'bulb_2', 'bulb_3']) {
    assert.equal(round1Coefficients[id], 1);
  }

  const seenCoefficients = new Map<string, number[]>();
  let round = 0;
  while (engine.getState() !== 'cycle_complete') {
    engine.resolveRound();
    round += 1;
    if (engine.getState() !== 'decision_window' && engine.getState() !== 'round_active') continue;

    for (const [bulbId, coefficient] of Object.entries(engine.getSnapshot().liveCoefficients)) {
      const history = seenCoefficients.get(bulbId) ?? [];
      history.push(coefficient);
      seenCoefficients.set(bulbId, history);
    }

    if (engine.getState() === 'decision_window') {
      for (const p of engine.getSnapshot().players.filter((p) => p.status === 'active')) {
        engine.continuePlaying(p.id);
      }
    }
    assert.ok(round < 20, 'safety valve — engine did not reach cycle_complete');
  }

  for (const [bulbId, history] of seenCoefficients) {
    for (let i = 1; i < history.length; i++) {
      assert.ok(
        history[i] >= history[i - 1] - 1e-9,
        `${bulbId}: live coefficient decreased across rounds: ${history.join(' -> ')}`,
      );
    }
  }
});

test('BulbGameEngine: the winner is paid via the exact same live-coefficient formula as a mid-round cash-out', () => {
  const engine = new BulbGameEngine({ clock: manualClock, oddsProvider: new PariMutuelEngine(undefined, seededRng(123)) });
  engine.startCycle(5);

  engine.placeBet('p1', 'bulb_1', 10);
  engine.placeBet('p2', 'bulb_2', 10);
  engine.placeBet('p3', 'bulb_3', 10);
  engine.placeBet('p4', 'bulb_4', 10);
  engine.placeBet('p5', 'bulb_5', 10);
  engine.closeBetting();
  engine.finishCalculating();

  let round = 0;
  while (engine.getState() !== 'cycle_complete') {
    engine.resolveRound();
    round += 1;
    if (engine.getState() === 'decision_window') {
      for (const p of engine.getSnapshot().players.filter((p) => p.status === 'active')) {
        engine.continuePlaying(p.id);
      }
    }
    assert.ok(round < 20, 'safety valve');
  }

  const finalSnapshot = engine.getSnapshot();
  const winner = finalSnapshot.players.find((p) => p.status === 'won')!;
  assert.ok(winner, 'exactly one bettor should have won');

  // At cycle_complete, every bulb except the winner's is 'popped' — the
  // engine's own liveCoefficients at this exact snapshot already reflect
  // the full eliminated pool, so this lookup IS the win payout, unmediated
  // by any separate "fixed coefficient" formula (none exists anymore).
  const expectedCoefficient = finalSnapshot.liveCoefficients[winner.bulbId];
  assert.ok(expectedCoefficient !== undefined);
  assert.ok(
    Math.abs(winner.result!.value - winner.stake * expectedCoefficient) < 1e-9,
    `winner paid ${winner.result!.value}, expected ${winner.stake * expectedCoefficient}`,
  );
});

// -------------------------------------------------------------------------
// 4. Uncontested round — auto-cancel and refund
// -------------------------------------------------------------------------

test('BulbGameEngine: a single-bulb (uncontested) round is cancelled and every stake refunded, no round played', () => {
  const engine = new BulbGameEngine({ clock: manualClock, oddsProvider: new PariMutuelEngine(undefined, seededRng(5)) });
  engine.startCycle(5);

  engine.placeBet('p1', 'bulb_1', 10);
  engine.placeBet('p2', 'bulb_1', 25); // same bulb as p1 — still only 1 contested bulb

  let cancelledPayload: { reason: string; refundedPlayers: Player[] } | undefined;
  engine.on('cycleCancelled', (payload) => {
    cancelledPayload = payload;
  });

  engine.closeBetting();
  engine.finishCalculating();

  assert.equal(engine.getState(), 'cycle_cancelled');
  assert.ok(cancelledPayload, 'expected a cycleCancelled event');
  assert.equal(cancelledPayload!.reason, 'uncontested');
  assert.deepEqual(
    cancelledPayload!.refundedPlayers.map((p) => p.id).sort(),
    ['p1', 'p2'],
  );

  const audit = engine.getAuditRecord()!;
  assert.deepEqual(audit.cancelled, { reason: 'uncontested', contestedBulbCount: 1 });
  assert.deepEqual(audit.roundPoolHistory, [], 'no round was ever played');
});

test('BulbGameEngine: zero bets at all is also uncontested (0 contested bulbs, not a crash)', () => {
  const engine = new BulbGameEngine({ clock: manualClock, oddsProvider: new PariMutuelEngine(undefined, seededRng(6)) });
  engine.startCycle(5);
  engine.closeBetting();
  engine.finishCalculating();

  assert.equal(engine.getState(), 'cycle_cancelled');
  assert.equal(engine.getAuditRecord()!.cancelled?.contestedBulbCount, 0);
});

test('BulbGameEngine: exactly 2 contested bulbs is enough to play — not cancelled', () => {
  const engine = new BulbGameEngine({ clock: manualClock, oddsProvider: new PariMutuelEngine(undefined, seededRng(11)) });
  engine.startCycle(5);
  engine.placeBet('p1', 'bulb_1', 10);
  engine.placeBet('p2', 'bulb_2', 10);
  engine.closeBetting();
  engine.finishCalculating();

  assert.equal(engine.getState(), 'round_active');
});

test('BulbGameEngine: after a cancellation, startCycle() can run again immediately (the caller restarts it)', () => {
  const engine = new BulbGameEngine({ clock: manualClock, oddsProvider: new PariMutuelEngine(undefined, seededRng(21)) });
  engine.startCycle(5);
  engine.placeBet('p1', 'bulb_1', 10);
  engine.closeBetting();
  engine.finishCalculating();
  assert.equal(engine.getState(), 'cycle_cancelled');

  engine.startCycle(5); // must not throw
  assert.equal(engine.getState(), 'betting');
});

// -------------------------------------------------------------------------
// 5. Checkpoints + fixed timing — unaffected by the pricing-model swap
// -------------------------------------------------------------------------

test('checkpoints.ts: a decision window opens after every round (every alive count down to 2)', () => {
  assert.deepEqual(CHECKPOINTS_BY_BULB_COUNT[5], [4, 3, 2]);
  assert.deepEqual(CHECKPOINTS_BY_BULB_COUNT[7], [6, 5, 4, 3, 2]);
  assert.deepEqual(CHECKPOINTS_BY_BULB_COUNT[10], [9, 8, 7, 6, 5, 4, 3, 2]);
});

function driveCycleAndRecordCheckpoints(bulbCount: 5 | 7 | 10): number[] {
  const engine = new BulbGameEngine({ clock: manualClock, oddsProvider: new PariMutuelEngine() });
  engine.startCycle(bulbCount);
  for (const bulbNumber of Array.from({ length: bulbCount }, (_, i) => i + 1)) {
    engine.placeBet(`p${bulbNumber}`, `bulb_${bulbNumber}`, 10);
  }
  engine.closeBetting();
  engine.finishCalculating();

  const aliveCountsAtCheckpoints: number[] = [];
  while (engine.getState() !== 'cycle_complete') {
    engine.resolveRound();
    if (engine.getState() !== 'decision_window') continue;

    const snapshot = engine.getSnapshot();
    aliveCountsAtCheckpoints.push(snapshot.bulbs.filter((b) => b.status === 'alive').length);
    for (const p of snapshot.players.filter((p) => p.status === 'active')) {
      engine.continuePlaying(p.id);
    }
  }
  return aliveCountsAtCheckpoints;
}

test('BulbGameEngine: decision windows open only at the configured checkpoints, for every bulb-count mode', () => {
  for (const bulbCount of [5, 7, 10] as const) {
    const aliveCountsAtCheckpoints = driveCycleAndRecordCheckpoints(bulbCount);
    assert.deepEqual(
      aliveCountsAtCheckpoints,
      CHECKPOINTS_BY_BULB_COUNT[bulbCount],
      `bulbCount=${bulbCount}: expected checkpoints at ${CHECKPOINTS_BY_BULB_COUNT[bulbCount]}, observed ${aliveCountsAtCheckpoints}`,
    );
  }
});

test('BulbGameEngine: every phase duration is a fixed constant, including the new calculating phase', () => {
  const engine = new BulbGameEngine({ clock: manualClock, oddsProvider: new PariMutuelEngine() });

  engine.startCycle(7);
  assert.equal(engine.getSnapshot().timings.bettingWindowMs, 10_000);
  assert.equal(engine.getSnapshot().timings.roundDurationMs, 5_000);
  assert.equal(engine.getSnapshot().timings.decisionWindowMs, 5_000);
  assert.equal(engine.getSnapshot().phaseDurationMs, 10_000); // betting window under way

  engine.placeBet('p1', 'bulb_1', 10);
  engine.closeBetting();
  assert.equal(engine.getSnapshot().phaseDurationMs, 3_000); // calculating
});

test('BulbGameEngine: round_active phase duration is fixed at 5s once a round actually starts', () => {
  const engine = new BulbGameEngine({ clock: manualClock, oddsProvider: new PariMutuelEngine() });
  engine.startCycle(7);
  engine.placeBet('p1', 'bulb_1', 10);
  engine.placeBet('p2', 'bulb_2', 10);
  engine.closeBetting();
  engine.finishCalculating();
  assert.equal(engine.getSnapshot().phaseDurationMs, 5_000);

  while (engine.getSnapshot().state !== 'decision_window' && engine.getSnapshot().state !== 'cycle_complete') {
    engine.resolveRound();
  }
  if (engine.getSnapshot().state === 'decision_window') {
    assert.equal(engine.getSnapshot().phaseDurationMs, 5_000); // decision window, also fixed at 5s
  }
});

// -------------------------------------------------------------------------
// 6. House-take sanity across scenarios — a measurement, not a target
// -------------------------------------------------------------------------

test('runPariMutuelSimulation: house take is never negative across representative scenarios (never overpays the pool)', () => {
  for (const scenario of ALL_SCENARIOS) {
    for (const bulbCount of [5, 7, 10] as const) {
      const result = runPariMutuelSimulation({
        bulbCount,
        cycles: 2_000,
        scenario,
        rng: seededRng(bulbCount * 1000 + scenario.name.length),
      });
      assert.ok(
        result.houseTakePct >= -1e-9,
        `${scenario.name} bulbCount=${bulbCount}: house take went negative (${result.houseTakePct}) — paid out more than the pool allowed`,
      );
      assert.ok(Number.isFinite(result.houseTakePct));
    }
  }
});

test('runPariMutuelSimulation: the fully-uncontested scenario cancels every cycle and wagers nothing', () => {
  const uncontested = ALL_SCENARIOS.find((s) => s.name.startsWith('uncontested'))!;
  const result = runPariMutuelSimulation({
    bulbCount: 5,
    cycles: 500,
    scenario: uncontested,
    rng: new DefaultRandomSource(),
  });
  assert.equal(result.uncontestedCycles, result.cycles);
  assert.equal(result.totalWagered, 0);
  assert.equal(result.totalPaidOut, 0);
});

test('DEFAULT_ODDS_CONFIG: house cut rate is 5% by default', () => {
  assert.equal(DEFAULT_ODDS_CONFIG.houseCutRate, 0.05);
});

// -------------------------------------------------------------------------
// 7. "Unclaimed pool" house-take breakdown — a cash-out is final, so if
//    everyone on the winning bulb already left, their share of the pool has
//    no claimant left and stays with the house on top of the standard cut.
// -------------------------------------------------------------------------

test('computeHouseTake: nobody left unclaimed -> unclaimedPool is 0, totalHouseTake is just the standard cut', () => {
  // 100 staked on the losing pool, 5% cut -> 95 distributable; all 95 claimed.
  const breakdown = computeHouseTake(100, 0.05, 95);
  assert.equal(breakdown.standardCut, 5);
  assert.equal(breakdown.distributablePool, 95);
  assert.equal(breakdown.unclaimedPool, 0);
  assert.equal(breakdown.totalHouseTake, 5);
});

test('computeHouseTake: nobody claims anything -> the WHOLE distributable pool is unclaimed, house keeps the full eliminated pool', () => {
  const breakdown = computeHouseTake(100, 0.05, 0);
  assert.equal(breakdown.standardCut, 5);
  assert.equal(breakdown.distributablePool, 95);
  assert.equal(breakdown.unclaimedPool, 95);
  assert.equal(breakdown.totalHouseTake, 100); // = the full eliminatedPool
});

test('computeHouseTake: a partial claim leaves the remainder unclaimed', () => {
  // 100 staked on the losing pool, 5% cut -> 95 distributable; only 50 of
  // that 95 gets claimed -> 45 unclaimed, total take = 5 (standard) + 45.
  const breakdown = computeHouseTake(100, 0.05, 50);
  assert.equal(breakdown.unclaimedPool, 45);
  assert.equal(breakdown.totalHouseTake, 50);
});

test('BulbGameEngine: nobody cashes out -> houseTake.unclaimedPool is ~0, claimedByWinners ~= distributablePool', () => {
  const engine = new BulbGameEngine({ clock: manualClock, oddsProvider: new PariMutuelEngine(undefined, seededRng(31)) });
  engine.startCycle(5);
  for (let i = 1; i <= 5; i++) engine.placeBet(`p${i}`, `bulb_${i}`, 10);
  engine.closeBetting();
  engine.finishCalculating();

  let round = 0;
  while (engine.getState() !== 'cycle_complete') {
    engine.resolveRound();
    round += 1;
    if (engine.getState() === 'decision_window') {
      for (const p of engine.getSnapshot().players.filter((p) => p.status === 'active')) {
        engine.continuePlaying(p.id);
      }
    }
    assert.ok(round < 20, 'safety valve');
  }

  const houseTake = engine.getAuditRecord()!.houseTake!;
  assert.ok(houseTake, 'expected a houseTake breakdown for a completed cycle');
  assert.ok(Math.abs(houseTake.unclaimedPool) < 1e-9, `expected ~0 unclaimed, got ${houseTake.unclaimedPool}`);
  assert.ok(
    Math.abs(houseTake.totalHouseTake - houseTake.standardCut) < 1e-9,
    'total take should equal just the standard cut when nothing goes unclaimed',
  );
});

test('BulbGameEngine: the winning bulb\'s only bettor cashes out at the first opportunity -> the last remaining staked bettor is settled early as no_contenders and drains the pool', () => {
  const engine = new BulbGameEngine({ clock: manualClock, oddsProvider: new PariMutuelEngine(undefined, seededRng(17)) });
  engine.startCycle(5);
  for (let i = 1; i <= 5; i++) engine.placeBet(`p${i}`, `bulb_${i}`, 10);
  engine.closeBetting();
  engine.finishCalculating();

  // The winner is sealed at startCycle() time — read it from the audit
  // record (server/test-only) so we know which single player to cash out.
  const winningBulbId = engine.getAuditRecord()!.winningBulbId;
  const winningPlayerId = engine.getSnapshot().players.find((p) => p.bulbId === winningBulbId)!.id;

  let round = 0;
  let winnerCashedOut = false;
  while (engine.getState() !== 'cycle_complete') {
    engine.resolveRound();
    round += 1;
    if (engine.getState() === 'decision_window') {
      for (const p of engine.getSnapshot().players.filter((p) => p.status === 'active')) {
        if (p.id === winningPlayerId) {
          engine.cashOut(p.id); // final and irrevocable — no further claim on this cycle
          winnerCashedOut = true;
        } else {
          engine.continuePlaying(p.id);
        }
      }
    }
    assert.ok(round < 20, 'safety valve');
  }

  assert.ok(winnerCashedOut, 'the winning bulb\'s bettor must have had at least one decision window to cash out in');
  const finalSnapshot = engine.getSnapshot();
  assert.equal(
    finalSnapshot.players.find((p) => p.id === winningPlayerId)!.status,
    'cashed_out',
    'a cashed-out player must not flip to "won" later, even though their bulb ended up winning',
  );

  // With the sealed winner's bulb left unstaked by the cash-out, the other
  // staked bulbs pop one by one until only ONE staked bulb remains — at
  // that point the no-contenders rule settles the cycle early: that last
  // bettor is paid the full remaining pool (coefficient 1 + remaining/stake
  // drains it exactly), so nothing goes unclaimed anymore. Pre-fix, this
  // bettor's bulb would have popped on schedule and the whole remainder
  // stayed with the house — the unclaimed-pool outcome this test used to
  // pin. That outcome is now impossible by design.
  const audit = engine.getAuditRecord()!;
  assert.equal(audit.completionReason, 'no_contenders');
  const settledWinner = finalSnapshot.players.find((p) => p.status === 'won')!;
  assert.ok(settledWinner, 'the last staked bettor must have been settled as a winner');
  assert.notEqual(settledWinner.id, winningPlayerId);

  const houseTake = audit.houseTake!;
  assert.ok(houseTake.claimedByWinners > 0, 'the early-settled bettor claimed the remaining pool');
  const cashedOut = finalSnapshot.players.find((p) => p.id === winningPlayerId)!;
  const claimedEarlier = cashedOut.result!.value - cashedOut.stake;
  assert.ok(claimedEarlier > 0, 'the early cash-out should have claimed some pool money');
  assert.ok(
    Math.abs(houseTake.unclaimedPool) < 1e-9,
    'the early settlement drains the pool — nothing left unclaimed',
  );
  assert.ok(
    Math.abs(houseTake.totalHouseTake - houseTake.standardCut) < 1e-9,
    'house take collapses to just the flat 5% edge',
  );
  assert.ok(
    Math.abs(claimedEarlier + houseTake.claimedByWinners - houseTake.distributablePool) < 1e-9,
    'cash-out claim + settlement claim account for the whole distributable pool',
  );
});

test('BulbGameEngine: a cancelled (uncontested) cycle has no houseTake at all', () => {
  const engine = new BulbGameEngine({ clock: manualClock, oddsProvider: new PariMutuelEngine(undefined, seededRng(6)) });
  engine.startCycle(5);
  engine.placeBet('p1', 'bulb_1', 10);
  engine.closeBetting();
  engine.finishCalculating();

  assert.equal(engine.getState(), 'cycle_cancelled');
  assert.equal(engine.getAuditRecord()!.houseTake, undefined);
});

// -------------------------------------------------------------------------
// 8. RTP simulation harness — full house-take distribution under varying
//    cash-out behavior, not just a single average.
// -------------------------------------------------------------------------

// Pre-PoolLedger, "everyone cashes out early" left a huge UNCLAIMED pool
// (each bulb was priced off its own full copy, and the winning bulb's
// share was orphaned). Under the shared depleting ledger the same behavior
// instead DRAINS the pool — survivors claim all of it — and shrinks the
// effective eliminated pool, since cashed-out stakes never enter it.
test('runCashOutBehaviorSimulation: "everyone cashes out early" drains the shared pool (no unclaimed remainder) and shrinks the effective eliminated pool versus "nobody cashes out"', () => {
  const behaviorNever = runCashOutBehaviorSimulation({
    bulbCount: 5,
    cycles: 3000,
    scenario: evenSpreadScenario,
    behavior: neverCashOutBehavior,
    rng: seededRng(101),
  });
  const behaviorAlways = runCashOutBehaviorSimulation({
    bulbCount: 5,
    cycles: 3000,
    scenario: evenSpreadScenario,
    behavior: alwaysCashOutBehavior,
    rng: seededRng(101),
  });

  assert.ok(
    behaviorNever.unclaimedPoolShareOfVolume < 0.01,
    `expected ~no unclaimed pool when nobody cashes out, got ${behaviorNever.unclaimedPoolShareOfVolume}`,
  );
  assert.ok(
    behaviorAlways.unclaimedPoolShareOfVolume < 0.01,
    `expected the pool to be drained (not orphaned) when everyone cashes out early, got ${behaviorAlways.unclaimedPoolShareOfVolume}`,
  );
  // Cashed-out stakes leave the game before their bulbs pop, so the flat
  // cut is levied on a much smaller effective eliminated pool — the house
  // still always keeps its 5% of what WAS eliminated, just of less volume.
  assert.ok(
    behaviorAlways.standardCutShareOfVolume < behaviorNever.standardCutShareOfVolume,
    `expected a smaller flat-cut share under early cash-outs, got always=${behaviorAlways.standardCutShareOfVolume} vs never=${behaviorNever.standardCutShareOfVolume}`,
  );
  assert.ok(behaviorAlways.aggregateHouseTakePct >= -1e-9, 'house take must never be negative');
});

test('runCashOutBehaviorSimulation: distribution.min/median/max bracket the average, and never diverge from the aggregate figure', () => {
  for (const behavior of [neverCashOutBehavior, alwaysCashOutBehavior]) {
    const result = runCashOutBehaviorSimulation({
      bulbCount: 7,
      cycles: 2000,
      scenario: evenSpreadScenario,
      behavior,
      rng: seededRng(55),
    });
    assert.ok(result.distribution.min <= result.distribution.median + 1e-9);
    assert.ok(result.distribution.median <= result.distribution.max + 1e-9);
    assert.ok(result.distribution.min <= result.distribution.average + 1e-9);
    assert.ok(result.distribution.average <= result.distribution.max + 1e-9);
  }
});

// Replaces the old pinned "house take CAN go negative" test, which
// documented the pre-PoolLedger double-payout bug (every alive bulb priced
// against its own full copy of the distributable pool). With the shared
// depleting ledger that behavior is impossible — asserted here per-cycle,
// at the same simulation scale, across every behavior pattern, bulb count,
// and stake scenario the harness knows about.
test('shared-pool invariant: total pool payouts per cycle (all cash-outs + final win) never exceed 95% of eliminated stakes, and house take is never negative — every behavior, bulb count, and scenario', () => {
  const EPS = 1e-6;
  const houseCutRate = DEFAULT_ODDS_CONFIG.houseCutRate;
  const scenarios = [evenSpreadScenario, tenPlayersScenario];
  for (const behavior of ALL_CASHOUT_BEHAVIORS) {
    for (const bulbCount of [5, 7, 10] as const) {
      for (const scenario of scenarios) {
        const rng = seededRng(202 + bulbCount);
        let contested = 0;
        for (let i = 0; i < 3000; i++) {
          const stakes = scenario.generateStakes(bulbCount, rng);
          const sample = simulateCycleWithCashOuts(bulbCount, stakes, rng, DEFAULT_ODDS_CONFIG, behavior);
          if (!sample) continue; // uncontested — refunded, nothing to assert
          contested += 1;
          const label = `${behavior.name} / ${scenario.name} / bulbCount=${bulbCount} / cycle=${i}`;
          // The hard invariant: pool money paid out across the WHOLE cycle
          // never exceeds (1 - houseCut) x the effective eliminated stakes.
          assert.ok(
            sample.poolPaidOut <= (1 - houseCutRate) * sample.eliminatedPool + EPS,
            `${label}: pool paid out ${sample.poolPaidOut} > 95% of eliminated pool ${sample.eliminatedPool}`,
          );
          // Consequence: house take is bounded below by the flat cut on the
          // effective eliminated pool — never negative, house never at risk.
          assert.ok(
            sample.houseTake >= sample.standardCut - EPS,
            `${label}: house take ${sample.houseTake} fell below the flat cut ${sample.standardCut}`,
          );
          assert.ok(sample.houseTake >= -EPS, `${label}: house take went negative (${sample.houseTake})`);
        }
        assert.ok(contested > 1000, `expected mostly contested cycles, got ${contested}`);
      }
    }
  }
});

// The same invariant read off the aggregate harness, so a future change to
// runCashOutBehaviorSimulation itself can't drift from the per-cycle check.
test('runCashOutBehaviorSimulation: minimum per-cycle house take never goes negative under any behavior pattern', () => {
  for (const behavior of ALL_CASHOUT_BEHAVIORS) {
    for (const bulbCount of [5, 7, 10] as const) {
      const result = runCashOutBehaviorSimulation({
        bulbCount,
        cycles: 3000,
        scenario: evenSpreadScenario,
        behavior,
        rng: seededRng(202),
      });
      assert.ok(
        result.distribution.min >= -1e-9,
        `${behavior.name} bulbCount=${bulbCount}: minimum house take went negative (${result.distribution.min})`,
      );
    }
  }
});

// -------------------------------------------------------------------------
// 9. Early "no contenders" settlement — once at most one alive bulb still
//    has active stake, further rounds can't change any payout (unstaked
//    pops contribute $0 to the pool), so the cycle ends right there.
// -------------------------------------------------------------------------

/** OddsProvider with a fixed, known outcome — so tests can force the exact
 *  pop order the no-contenders scenarios need. */
function scriptedProvider(winningBulbId: string, eliminationOrder: string[]): OddsProvider {
  return {
    houseCutRate: 0.05,
    planOutcome: () => ({ winningBulbId, eliminationOrder }),
    createLedger: () => new PoolLedger(0.05),
  };
}

test('settleNoContenders: cycle ends the moment only one staked bulb is left alive — paid at the live coefficient, no sealed-winner assertion', () => {
  // 5 bulbs, stakes on bulb_1..bulb_3 only. The sealed plan pops the three
  // staked bulbs first and crowns UNSTAKED bulb_5 the winner — so if the
  // cycle wrongly ran to the end, bulb_3 would pop in round 3 and p3 would
  // lose despite being the only bettor left with anything at risk.
  const engine = new BulbGameEngine({
    clock: manualClock,
    oddsProvider: scriptedProvider('bulb_5', ['bulb_1', 'bulb_2', 'bulb_3', 'bulb_4']),
  });
  const completions: BulbGameEvents['cycleComplete'][] = [];
  engine.on('cycleComplete', (payload) => completions.push(payload));

  engine.startCycle(5);
  engine.placeBet('p1', 'bulb_1', 10);
  engine.placeBet('p2', 'bulb_2', 10);
  engine.placeBet('p3', 'bulb_3', 10);
  engine.closeBetting();
  engine.finishCalculating();

  engine.resolveRound(); // round 1: bulb_1 pops -> 4 alive, checkpoint window
  assert.equal(engine.getState(), 'decision_window');
  for (const p of engine.getSnapshot().players.filter((p) => p.status === 'active')) {
    engine.continuePlaying(p.id);
  }

  // Round 2: bulb_2 pops. bulb_3 is now the ONLY alive bulb with active
  // stake (bulb_4/bulb_5 are alive but were never bet on) — the cycle must
  // end HERE, without opening the 3-alive checkpoint window and without
  // tripping the sole-survivor-vs-planned-winner assertion (bulb_3 is NOT
  // the sealed winner, and that's fine — this is a business stop, not a
  // reveal).
  engine.resolveRound();
  assert.equal(engine.getState(), 'cycle_complete');
  assert.equal(engine.getSnapshot().currentRound, 2, 'no round 3+ was played');

  const p3 = engine.getSnapshot().players.find((p) => p.id === 'p3')!;
  assert.equal(p3.status, 'won');
  // Pool: 20 eliminated -> 19 distributable; p3 is the only active stake
  // (10), so the live coefficient is 1 + 19/10 = 2.9 -> payout 29.
  assert.ok(Math.abs(p3.result!.value - 29) < 1e-9, `expected 29, got ${p3.result!.value}`);

  assert.equal(completions.length, 1);
  assert.equal(completions[0].reason, 'no_contenders');
  assert.equal(completions[0].winningBulbId, 'bulb_3');

  // Unstaked survivors stay 'alive' — never contested, never revealed.
  const aliveLeft = engine.getSnapshot().bulbs.filter((b) => b.status === 'alive').map((b) => b.id);
  assert.deepEqual(aliveLeft.sort(), ['bulb_3', 'bulb_4', 'bulb_5']);

  const audit = engine.getAuditRecord()!;
  assert.equal(audit.completionReason, 'no_contenders');
  assert.equal(audit.settledBulbId, 'bulb_3');
  assert.equal(audit.winningBulbId, 'bulb_5', 'the sealed planned winner stays on record, unchanged');
});

test('settleNoContenders: zero staked bulbs left (last bettor cashed out) -> cycle ends immediately with no winner payout', () => {
  // Sealed plan pops bulb_3 first; p1 and p2 (the only other bettors) then
  // BOTH cash out in the 4-alive decision window, leaving ZERO alive bulbs
  // with active stake while 4 bulbs are still physically alive.
  const engine = new BulbGameEngine({
    clock: manualClock,
    oddsProvider: scriptedProvider('bulb_5', ['bulb_3', 'bulb_1', 'bulb_2', 'bulb_4']),
  });
  const completions: BulbGameEvents['cycleComplete'][] = [];
  engine.on('cycleComplete', (payload) => completions.push(payload));

  engine.startCycle(5);
  engine.placeBet('p1', 'bulb_1', 10);
  engine.placeBet('p2', 'bulb_2', 10);
  engine.placeBet('p3', 'bulb_3', 10);
  engine.closeBetting();
  engine.finishCalculating();

  engine.resolveRound(); // round 1: bulb_3 pops -> checkpoint window opens
  assert.equal(engine.getState(), 'decision_window');
  engine.cashOut('p1');
  engine.cashOut('p2'); // last decider -> window resolves at once

  // The cash-outs drained every competing stake — no round 2 runs.
  assert.equal(engine.getState(), 'cycle_complete');
  assert.equal(engine.getSnapshot().currentRound, 1, 'no further rounds were played');
  assert.equal(engine.getSnapshot().winningBulbId, undefined);
  assert.equal(engine.getSnapshot().players.filter((p) => p.status === 'won').length, 0);

  // Both were paid the frozen window coefficient 1 + 9.5/20 = 1.475 ->
  // 14.75 each, draining the pool exactly; nothing else is paid at
  // settlement.
  for (const id of ['p1', 'p2']) {
    const paid = engine.getSnapshot().players.find((p) => p.id === id)!;
    assert.equal(paid.status, 'cashed_out');
    assert.ok(Math.abs(paid.result!.value - 14.75) < 1e-9, `${id} paid ${paid.result!.value}`);
  }

  assert.equal(completions.length, 1);
  assert.equal(completions[0].reason, 'no_contenders');
  assert.equal(completions[0].winningBulbId, '');
  assert.deepEqual(completions[0].winners, []);

  const audit = engine.getAuditRecord()!;
  assert.equal(audit.completionReason, 'no_contenders');
  assert.equal(audit.settledBulbId, undefined);
  // House take is still recorded: flat 5% of the 10 eliminated, and the
  // pool was fully claimed by the cash-out, so nothing goes unclaimed.
  assert.ok(Math.abs(audit.houseTake!.standardCut - 0.5) < 1e-9);
  assert.ok(Math.abs(audit.houseTake!.unclaimedPool) < 1e-9);
});

test('settleNoContenders: a normal fully-staked cycle is untouched — completes as sole_survivor with the sealed winner', () => {
  const engine = new BulbGameEngine({ clock: manualClock, oddsProvider: new PariMutuelEngine(undefined, seededRng(77)) });
  const completions: BulbGameEvents['cycleComplete'][] = [];
  engine.on('cycleComplete', (payload) => completions.push(payload));

  engine.startCycle(5);
  for (let i = 1; i <= 5; i++) engine.placeBet(`p${i}`, `bulb_${i}`, 10);
  engine.closeBetting();
  engine.finishCalculating();

  let round = 0;
  while (engine.getState() !== 'cycle_complete') {
    engine.resolveRound();
    round += 1;
    if (engine.getState() === 'decision_window') {
      for (const p of engine.getSnapshot().players.filter((p) => p.status === 'active')) {
        engine.continuePlaying(p.id);
      }
    }
    assert.ok(round < 20, 'safety valve');
  }

  assert.equal(completions[0].reason, 'sole_survivor');
  assert.equal(completions[0].winningBulbId, engine.getAuditRecord()!.winningBulbId);
  assert.equal(engine.getAuditRecord()!.completionReason, 'sole_survivor');
});
