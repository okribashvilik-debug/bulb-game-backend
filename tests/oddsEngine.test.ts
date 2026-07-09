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
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { BulbGameEngine } from '../src/BulbGameEngine';
import { CHECKPOINTS_BY_BULB_COUNT } from '../src/checkpoints';
import type { Clock, TimerHandle } from '../src/clock';
import { DEFAULT_ODDS_CONFIG } from '../src/odds/config';
import { computeCoefficient, computeCoefficients } from '../src/odds/parimutuel';
import { planCycleOutcome } from '../src/odds/outcomePlan';
import { PariMutuelEngine } from '../src/odds/PariMutuelEngine';
import { ALL_SCENARIOS, runPariMutuelSimulation } from '../src/odds/rtpSimulation';
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

test('computeCoefficient: 1 + distributablePool / stakeOnBulb, house cut applied only to the eliminated pool', () => {
  // 100 staked on the losing pool, 5% house cut -> 95 distributable, split
  // over a bulb with 50 staked on it: 1 + 95/50 = 2.9
  const coeff = computeCoefficient(50, 100, 0.05);
  assert.ok(Math.abs(coeff! - 2.9) < 1e-9, `expected 2.9, got ${coeff}`);
});

test('computeCoefficient: zero eliminated pool (round 1, nothing popped yet) gives exactly 1.0', () => {
  const coeff = computeCoefficient(50, 0, 0.05);
  assert.equal(coeff, 1);
});

test('computeCoefficient: undefined (not 0, not a fallback) when nobody staked on the bulb', () => {
  assert.equal(computeCoefficient(0, 500, 0.05), undefined);
});

test('computeCoefficients: only alive AND staked bulbs get an entry — popped or unstaked bulbs are omitted', () => {
  const bulbs = [bulb('bulb_1', 'popped'), bulb('bulb_2'), bulb('bulb_3')];
  const players = [player('p1', 'bulb_1', 10, 'popped'), player('p2', 'bulb_2', 20)];
  // bulb_3 is alive but nobody staked on it; bulb_1 is popped (its stake IS
  // part of the eliminated pool, but it can't itself receive a live entry).
  const coefficients = computeCoefficients(bulbs, players, 0.05);

  assert.equal(coefficients.size, 1);
  assert.ok(coefficients.has('bulb_2'));
  assert.ok(!coefficients.has('bulb_1'));
  assert.ok(!coefficients.has('bulb_3'));
  // distributablePool = 0.95 * 10 = 9.5; coefficient = 1 + 9.5/20 = 1.475
  assert.ok(Math.abs(coefficients.get('bulb_2')! - 1.475) < 1e-9);
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

test('checkpoints.ts: thresholds match the spec exactly for every bulb-count mode', () => {
  assert.deepEqual(CHECKPOINTS_BY_BULB_COUNT[5], [3]);
  assert.deepEqual(CHECKPOINTS_BY_BULB_COUNT[7], [5, 3]);
  assert.deepEqual(CHECKPOINTS_BY_BULB_COUNT[10], [6, 3]);
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
