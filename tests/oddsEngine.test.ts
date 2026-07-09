/**
 * Odds/payout engine test suite (Node's built-in test runner — no extra
 * dependency needed). Covers, roughly in order:
 *
 *  1. The core coefficient formula and its clamp bounds, tested exactly
 *     (no RNG involved).
 *  2. The integrity ordering from outcomePlan.ts: winner decided first,
 *     elimination order is a separate randomized process, every bulb
 *     accounted for exactly once.
 *  3. That elimination order is genuinely randomized but *statistically*
 *     favors popping low-probability bulbs earlier — the exact wording of
 *     the requirement.
 *  4. Survival curves: exact boundary values, the population-count
 *     invariant, monotonicity, and a hand-computed 3-bulb regression case.
 *  5. The RTP simulation harness across thousands of cycles, for all three
 *     shapes, a mixed/random-shape run, AND round-by-round cash-out timing
 *     (now checkpoint-gated — see #7), which converges just as tightly as
 *     holding to natural resolution.
 *  6. A full BulbGameEngine integration smoke test wired to FixedOddsEngine,
 *     driven manually (no real timers) to keep it deterministic.
 *  7. The checkpoint restructure: decision windows only open at the
 *     configured "bulbs remaining" thresholds per bulb-count mode, and
 *     every phase duration is a fixed constant, not a randomized range.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { BulbGameEngine } from '../src/BulbGameEngine';
import { CHECKPOINTS_BY_BULB_COUNT } from '../src/checkpoints';
import type { Clock, TimerHandle } from '../src/clock';
import { DEFAULT_ODDS_CONFIG } from '../src/odds/config';
import { probabilityToCoefficient } from '../src/odds/coefficients';
import { FixedOddsEngine } from '../src/odds/FixedOddsEngine';
import { decideWinningBulb, generateEliminationOrder, planCycleOutcome } from '../src/odds/outcomePlan';
import { runFixedOddsRtpSimulation, runMixedStrategyRtpSimulation } from '../src/odds/rtpSimulation';
import { computeSurvivalCurves } from '../src/odds/survivalCurves';
import { DefaultRandomSource, type RandomSource } from '../src/rng';

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

// -------------------------------------------------------------------------
// 1. Coefficient formula + clamp
// -------------------------------------------------------------------------

test('probabilityToCoefficient applies HOUSE_RTP / probability exactly when unclamped', () => {
  const coeff = probabilityToCoefficient(0.1, DEFAULT_ODDS_CONFIG);
  assert.ok(Math.abs(coeff - 9.5) < 1e-9, `expected 9.5, got ${coeff}`);
});

test('probabilityToCoefficient clamps tiny probabilities to maxCoefficient', () => {
  const coeff = probabilityToCoefficient(0.001, DEFAULT_ODDS_CONFIG); // raw = 950
  assert.equal(coeff, DEFAULT_ODDS_CONFIG.maxCoefficient);
});

test('probabilityToCoefficient clamps near-certain probabilities to minCoefficient', () => {
  const coeff = probabilityToCoefficient(0.99, DEFAULT_ODDS_CONFIG); // raw = 0.9596
  assert.equal(coeff, DEFAULT_ODDS_CONFIG.minCoefficient);
});

test('probabilityToCoefficient rejects non-positive probability', () => {
  assert.throws(() => probabilityToCoefficient(0, DEFAULT_ODDS_CONFIG));
});

// -------------------------------------------------------------------------
// 2. Outcome plan integrity
// -------------------------------------------------------------------------

test('planCycleOutcome: probabilities sum to 1 and every bulb is assigned one', () => {
  const bulbIds = ['bulb_1', 'bulb_2', 'bulb_3', 'bulb_4', 'bulb_5'];
  const plan = planCycleOutcome(bulbIds, DEFAULT_ODDS_CONFIG, seededRng(1));

  assert.equal(plan.probabilityByBulbId.size, bulbIds.length);
  const sum = [...plan.probabilityByBulbId.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `probabilities should sum to 1, got ${sum}`);
});

test('planCycleOutcome: elimination order contains every bulb except the winner, exactly once', () => {
  const bulbIds = ['bulb_1', 'bulb_2', 'bulb_3', 'bulb_4', 'bulb_5', 'bulb_6', 'bulb_7'];
  const plan = planCycleOutcome(bulbIds, DEFAULT_ODDS_CONFIG, seededRng(2));

  assert.equal(plan.eliminationOrder.length, bulbIds.length - 1);
  assert.ok(!plan.eliminationOrder.includes(plan.winningBulbId));
  assert.deepEqual(
    [...plan.eliminationOrder].sort(),
    bulbIds.filter((id) => id !== plan.winningBulbId).sort(),
  );
});

test('planCycleOutcome: winner is drawn according to assigned probability, not always the favorite', () => {
  // Skewed 2-bulb distribution: bulb A should win far more often than bulb B,
  // but B must still win sometimes — this is a weighted draw, not "highest wins".
  const probabilityByBulbId = new Map([
    ['A', 0.9],
    ['B', 0.1],
  ]);
  const rng = seededRng(42);
  let winsA = 0;
  let winsB = 0;
  for (let i = 0; i < 2000; i++) {
    const winner = decideWinningBulb(probabilityByBulbId, rng);
    if (winner === 'A') winsA += 1;
    else winsB += 1;
  }
  assert.ok(winsB > 0, 'the 10% underdog should still win occasionally');
  assert.ok(winsA > winsB * 4, `expected A to win roughly 9x more often, got A=${winsA} B=${winsB}`);
});

test('planCycleOutcome: carries a survival curve for every bulb', () => {
  const bulbIds = ['bulb_1', 'bulb_2', 'bulb_3', 'bulb_4', 'bulb_5'];
  const plan = planCycleOutcome(bulbIds, DEFAULT_ODDS_CONFIG, seededRng(3));

  assert.equal(plan.survivalCurveByBulbId.size, bulbIds.length);
  for (const id of bulbIds) {
    assert.equal(plan.survivalCurveByBulbId.get(id)!.length, bulbIds.length); // totalRounds + 1 = n
  }
});

// -------------------------------------------------------------------------
// 3. Elimination order: statistical tendency, not determinism
// -------------------------------------------------------------------------

test('generateEliminationOrder: low-probability bulbs pop earlier on average, but not every single time', () => {
  const probabilityByBulbId = new Map([
    ['favorite', 0.5],
    ['mid', 0.3],
    ['longshot', 0.2],
  ]);
  const loserIds = ['favorite', 'mid', 'longshot'];
  const rng = seededRng(7);

  const positionSums: Record<string, number> = { favorite: 0, mid: 0, longshot: 0 };
  const firstPoppedSeen = new Set<string>();
  const trials = 3000;

  for (let i = 0; i < trials; i++) {
    const order = generateEliminationOrder(loserIds, probabilityByBulbId, rng);
    order.forEach((bulbId, position) => {
      positionSums[bulbId] += position;
    });
    firstPoppedSeen.add(order[0]);
  }

  const avg = (id: string) => positionSums[id] / trials;

  // Statistical tendency: on average, lower probability -> earlier (lower) position.
  assert.ok(
    avg('longshot') < avg('mid') && avg('mid') < avg('favorite'),
    `expected avg position longshot < mid < favorite, got ${avg('longshot')}, ${avg('mid')}, ${avg('favorite')}`,
  );

  // Not deterministic: every bulb should have popped first at least once
  // across enough trials, i.e. the favorite is not *guaranteed* to survive
  // longest every single cycle.
  assert.equal(firstPoppedSeen.size, 3, `expected all 3 bulbs to have popped first at least once, saw ${[...firstPoppedSeen]}`);
});

// -------------------------------------------------------------------------
// 4. Survival curves — exact analytical properties
// -------------------------------------------------------------------------

test('computeSurvivalCurves: entering round 1 everyone is alive; at the final entry, exactly the assigned probability', () => {
  const probabilityByBulbId = new Map([
    ['A', 0.5],
    ['B', 0.3],
    ['C', 0.2],
  ]);
  const curves = computeSurvivalCurves(['A', 'B', 'C'], probabilityByBulbId);

  for (const [id, p] of probabilityByBulbId) {
    const curve = curves.get(id)!;
    assert.equal(curve[0], 1, `${id} should be alive entering round 1 with certainty`);
    assert.equal(curve[curve.length - 1], p, `${id}'s final entry should equal its assigned probability exactly`);
  }
});

test('computeSurvivalCurves: sum across all bulbs at round r is exactly n-r+1 (the deterministic population count)', () => {
  // Exactly r-1 pops have happened by round r, always — so exactly n-(r-1)
  // bulbs are alive, even though WHICH ones is random. This must hold
  // exactly (up to float rounding) for every shape/bulbCount/round.
  for (const n of [5, 7, 10]) {
    const bulbIds = Array.from({ length: n }, (_, i) => `bulb_${i + 1}`);
    for (const seed of [10, 20, 30]) {
      const plan = planCycleOutcome(bulbIds, DEFAULT_ODDS_CONFIG, seededRng(seed * n));
      const curves = plan.survivalCurveByBulbId;
      for (let r = 1; r <= n; r++) {
        const sum = bulbIds.reduce((acc, id) => acc + curves.get(id)![r - 1], 0);
        const expected = n - r + 1;
        assert.ok(
          Math.abs(sum - expected) < 1e-9,
          `n=${n} seed=${seed} round=${r}: expected population sum ${expected}, got ${sum}`,
        );
      }
    }
  }
});

test('computeSurvivalCurves: monotonically non-increasing per bulb (surviving longer is never more likely)', () => {
  const bulbIds = ['bulb_1', 'bulb_2', 'bulb_3', 'bulb_4', 'bulb_5', 'bulb_6', 'bulb_7'];
  const plan = planCycleOutcome(bulbIds, DEFAULT_ODDS_CONFIG, seededRng(77));

  for (const id of bulbIds) {
    const curve = plan.survivalCurveByBulbId.get(id)!;
    for (let r = 1; r < curve.length; r++) {
      assert.ok(
        curve[r] <= curve[r - 1] + 1e-12,
        `${id}: survival probability increased from round ${r} to ${r + 1} (${curve[r - 1]} -> ${curve[r]})`,
      );
    }
  }
});

test('computeSurvivalCurves: matches a hand-computed 3-bulb example exactly', () => {
  // A=0.5, B=0.3, C=0.2. Worked out by hand (see PR description / commit
  // message for the derivation): survival entering round 2 (after 1 pop)
  // is A=0.8393, B=0.675, C=0.4857 — cross-checked against the "sums to
  // n-r+1=2" invariant, which they do.
  const probabilityByBulbId = new Map([
    ['A', 0.5],
    ['B', 0.3],
    ['C', 0.2],
  ]);
  const curves = computeSurvivalCurves(['A', 'B', 'C'], probabilityByBulbId);

  assert.ok(Math.abs(curves.get('A')![1] - 0.8393) < 1e-3, `A: got ${curves.get('A')![1]}`);
  assert.ok(Math.abs(curves.get('B')![1] - 0.675) < 1e-3, `B: got ${curves.get('B')![1]}`);
  assert.ok(Math.abs(curves.get('C')![1] - 0.4857) < 1e-3, `C: got ${curves.get('C')![1]}`);
});

test('FixedOddsEngine.cashOutCoefficient: at the final entry, exactly equals the fixed/base coefficient', () => {
  const engine = new FixedOddsEngine(undefined, seededRng(123));
  const bulbIds = ['bulb_1', 'bulb_2', 'bulb_3', 'bulb_4', 'bulb_5'];
  const plan = engine.planCycle(bulbIds);
  const totalRounds = bulbIds.length - 1;

  for (const id of bulbIds) {
    const finalCoefficient = engine.cashOutCoefficient(plan, id, totalRounds + 1);
    const baseCoefficient = plan.fixedCoefficientByBulbId.get(id)!;
    assert.ok(
      Math.abs(finalCoefficient - baseCoefficient) < 1e-9,
      `${id}: cash_out(final)=${finalCoefficient} should equal base coefficient ${baseCoefficient}`,
    );
  }
});

test('FixedOddsEngine.cashOutCoefficient: non-decreasing round over round for every bulb', () => {
  const engine = new FixedOddsEngine(undefined, seededRng(456));
  const bulbIds = ['bulb_1', 'bulb_2', 'bulb_3', 'bulb_4', 'bulb_5', 'bulb_6', 'bulb_7'];
  const plan = engine.planCycle(bulbIds);
  const totalRounds = bulbIds.length - 1;

  for (const id of bulbIds) {
    let previous = -Infinity;
    for (let r = 1; r <= totalRounds + 1; r++) {
      const coefficient = engine.cashOutCoefficient(plan, id, r);
      assert.ok(coefficient >= previous - 1e-9, `${id} round ${r}: coefficient dropped from ${previous} to ${coefficient}`);
      previous = coefficient;
    }
  }
});

// -------------------------------------------------------------------------
// 5. RTP convergence — the main deliverable of this task
// -------------------------------------------------------------------------

const BULB_COUNTS = [5, 7, 10] as const;

test('RTP: every shape converges to houseRtp within tolerance, for every supported bulb count (hold-to-resolution)', () => {
  const tolerance = 0.025;
  for (const shape of ['dominant', 'wide_open', 'duel'] as const) {
    for (const bulbCount of BULB_COUNTS) {
      const result = runFixedOddsRtpSimulation({
        bulbCount,
        cycles: 20_000,
        shape,
        rng: seededRng(shape.length * 1000 + bulbCount),
      });
      const diff = Math.abs(result.rtp - DEFAULT_ODDS_CONFIG.houseRtp);
      assert.ok(
        diff < tolerance,
        `${shape} bulbCount=${bulbCount}: expected RTP near ${DEFAULT_ODDS_CONFIG.houseRtp}, got ${result.rtp} (diff ${diff})`,
      );
    }
  }
});

test('RTP: mixed random-shape simulation over thousands of cycles lands close to houseRtp', () => {
  const result = runFixedOddsRtpSimulation({
    bulbCount: 10,
    cycles: 50_000, // shape chosen at random each cycle, like real play
    rng: seededRng(999),
  });
  const diff = Math.abs(result.rtp - DEFAULT_ODDS_CONFIG.houseRtp);
  assert.ok(diff < 0.05, `mixed-shape RTP ${result.rtp} too far from houseRtp (diff ${diff})`);
  assert.ok(result.clampedHighCount > 0, 'expected the 50x ceiling to be exercised at least once over 50k cycles');
});

test('RTP: round-by-round cash-out now converges to houseRtp regardless of timing — the fix, verified', () => {
  // This is the whole point of the new model. The OLD renormalization-based
  // live coefficient measured ~800-1500% RTP here (see git history / prior
  // test) because it treated "still alive" as evidence of a rising true win
  // probability, when the winner was already fixed. The NEW survival-curve
  // formula is constructed so P(reach r) * cash_out(r) = houseRtp for every
  // bulb and every r — by definition of survival_i(r), not by tuning — so
  // this must now land in the same tight neighborhood as hold-to-resolution,
  // for every cash-out aggressiveness tested. A measurable drift here means
  // a bug in computeSurvivalCurves, not "a model limitation".
  // Cycle count is lower than the hold-to-resolution tests above: this
  // path exercises the O(n * 2^(n-1)) survival-curve DP once per cycle
  // (the hold-to-resolution measurement never touches it), so at n=10
  // it's meaningfully more expensive per cycle. A few thousand cycles per
  // combination is still comfortably "thousands", per the requirement.
  const tolerance = 0.04;
  for (const cashoutProbabilityPerRound of [0.1, 0.3, 0.5, 0.9]) {
    for (const shape of ['dominant', 'wide_open', 'duel'] as const) {
      const result = runMixedStrategyRtpSimulation({
        bulbCount: 10,
        cycles: 4_000,
        shape,
        cashoutProbabilityPerRound,
        rng: seededRng(Math.round(cashoutProbabilityPerRound * 1000) + shape.length),
      });
      const diff = Math.abs(result.rtp - DEFAULT_ODDS_CONFIG.houseRtp);
      assert.ok(
        diff < tolerance,
        `DRIFT DETECTED — shape=${shape} cashoutChance=${cashoutProbabilityPerRound}: ` +
          `RTP ${result.rtp} vs houseRtp ${DEFAULT_ODDS_CONFIG.houseRtp} (diff ${diff}). ` +
          'This indicates a bug in the survival-probability calculation, not an inherent model limitation.',
      );
    }
  }
});

test('RTP: always cashing out at the very first opportunity still converges to houseRtp', () => {
  // The most extreme timing strategy — everyone bails after round 1 if
  // they survived it. Still per-bulb EV-neutral by construction.
  const result = runMixedStrategyRtpSimulation({
    bulbCount: 7,
    cycles: 20_000,
    cashoutProbabilityPerRound: 1.0,
    rng: seededRng(31415),
  });
  const diff = Math.abs(result.rtp - DEFAULT_ODDS_CONFIG.houseRtp);
  assert.ok(diff < 0.03, `immediate-cashout RTP ${result.rtp} too far from houseRtp (diff ${diff})`);
});

// -------------------------------------------------------------------------
// 6. Full engine integration (deterministic — no real timers)
// -------------------------------------------------------------------------

/** A Clock that never fires on its own — every transition in this test is
 *  driven by explicitly calling the engine's public methods, so the test
 *  has zero dependency on real elapsed time. */
const manualClock: Clock = {
  setTimeout: (): TimerHandle => 0 as unknown as TimerHandle,
  clearTimeout: () => {},
};

test('BulbGameEngine + FixedOddsEngine: winner is paid the fixed coefficient, cash-outs use the round-by-round survival curve', () => {
  const rng = new DefaultRandomSource();
  const engine = new BulbGameEngine({
    clock: manualClock,
    oddsProvider: new FixedOddsEngine(undefined, rng),
  });

  engine.startCycle(5);
  const startSnapshot = engine.getSnapshot();
  assert.equal(Object.keys(startSnapshot.fixedCoefficients).length, 5);
  assert.ok(startSnapshot.shape);

  engine.placeBet('p1', 'bulb_1', 10);
  engine.placeBet('p2', 'bulb_2', 10);
  engine.placeBet('p3', 'bulb_3', 10);
  engine.placeBet('p4', 'bulb_4', 10);
  engine.placeBet('p5', 'bulb_5', 10);
  engine.closeBetting();

  // Track each surviving bulb's offered live coefficient round over round,
  // to check it never decreases — the core UX guarantee of this model.
  const seenCoefficients = new Map<string, number[]>();
  const aliveCountsAtCheckpoints: number[] = [];

  let round = 0;
  while (engine.getState() !== 'cycle_complete') {
    engine.resolveRound();
    round += 1;
    // resolveRound() either opens a decision window (checkpoint round) or,
    // for a bulb count of 5, silently advances straight back into
    // 'round_active' for the next round (non-checkpoint) — either way,
    // looping back to resolveRound() is correct: it's a no-op guarded by
    // state until the engine is actually ready for the next pop.
    if (engine.getState() !== 'decision_window') continue;

    const snapshot = engine.getSnapshot();
    aliveCountsAtCheckpoints.push(snapshot.bulbs.filter((b) => b.status === 'alive').length);
    for (const [bulbId, coefficient] of Object.entries(snapshot.liveCoefficients)) {
      const history = seenCoefficients.get(bulbId) ?? [];
      history.push(coefficient);
      seenCoefficients.set(bulbId, history);
    }

    const survivors = snapshot.players.filter((p) => p.status === 'active');
    if (round % 2 === 0 && survivors.length > 0) {
      // Cash out the first survivor to check the round-by-round payout.
      const [first, ...rest] = survivors;
      engine.cashOut(first.id);
      for (const p of rest) engine.continuePlaying(p.id);
    } else {
      for (const p of survivors) engine.continuePlaying(p.id);
    }
  }

  // 5 bulbs -> exactly one checkpoint, at 3 bulbs remaining (see checkpoints.ts).
  assert.deepEqual(aliveCountsAtCheckpoints, CHECKPOINTS_BY_BULB_COUNT[5]);

  for (const [bulbId, history] of seenCoefficients) {
    for (let i = 1; i < history.length; i++) {
      assert.ok(
        history[i] >= history[i - 1] - 1e-9,
        `${bulbId}: live coefficient decreased across rounds: ${history.join(' -> ')}`,
      );
    }
  }

  const finalSnapshot = engine.getSnapshot();
  assert.equal(finalSnapshot.state, 'cycle_complete');
  assert.ok(finalSnapshot.winningBulbId);

  for (const player of finalSnapshot.players) {
    if (player.status === 'cashed_out') {
      assert.ok(player.result, `${player.id} cashed out but has no result`);
      assert.ok(player.result!.value > 0);
    }
    if (player.status === 'won') {
      const expected = finalSnapshot.fixedCoefficients[player.bulbId] * player.stake;
      assert.ok(
        Math.abs(player.result!.value - expected) < 1e-9,
        `winner ${player.id} paid ${player.result!.value}, expected fixed-coefficient payout ${expected}`,
      );
    }
    if (player.status === 'spectator') {
      assert.equal(player.result, undefined);
    }
  }
});

// -------------------------------------------------------------------------
// 7. Checkpoint restructure + fixed timing
// -------------------------------------------------------------------------

test('checkpoints.ts: thresholds match the spec exactly for every bulb-count mode', () => {
  assert.deepEqual(CHECKPOINTS_BY_BULB_COUNT[5], [3]);
  assert.deepEqual(CHECKPOINTS_BY_BULB_COUNT[7], [5, 3]);
  assert.deepEqual(CHECKPOINTS_BY_BULB_COUNT[10], [6, 3]);
});

function driveCycleAndRecordCheckpoints(bulbCount: 5 | 7 | 10): number[] {
  const engine = new BulbGameEngine({ clock: manualClock, oddsProvider: new FixedOddsEngine() });
  engine.startCycle(bulbCount);
  // Bet on EVERY bulb, not just one: beginDecisionWindow() sees zero
  // eligible deciders once every bettor's bulb has popped and skips the
  // window through synchronously without the state machine ever pausing
  // in 'decision_window' — betting on every bulb guarantees at least one
  // eligible decider (whichever bulbs are still alive) at every checkpoint,
  // regardless of which specific bulbs the sealed elimination order pops
  // first.
  for (const bulbNumber of Array.from({ length: bulbCount }, (_, i) => i + 1)) {
    engine.placeBet(`p${bulbNumber}`, `bulb_${bulbNumber}`, 10);
  }
  engine.closeBetting();

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

test('BulbGameEngine: every phase duration is the fixed constant, never a randomized range', () => {
  const engine = new BulbGameEngine({ clock: manualClock, oddsProvider: new FixedOddsEngine() });

  engine.startCycle(7);
  assert.equal(engine.getSnapshot().timings.bettingWindowMs, 10_000);
  assert.equal(engine.getSnapshot().timings.roundDurationMs, 5_000);
  assert.equal(engine.getSnapshot().timings.decisionWindowMs, 5_000);
  assert.equal(engine.getSnapshot().phaseDurationMs, 10_000); // betting window under way

  engine.placeBet('p1', 'bulb_1', 10);
  engine.closeBetting();
  assert.equal(engine.getSnapshot().phaseDurationMs, 5_000); // round_active

  // Drive to the first checkpoint (5 bulbs remaining, per CHECKPOINTS_BY_BULB_COUNT[7]).
  while (engine.getSnapshot().state !== 'decision_window') {
    engine.resolveRound();
  }
  assert.equal(engine.getSnapshot().phaseDurationMs, 5_000); // decision window, also fixed at 5s now
});
