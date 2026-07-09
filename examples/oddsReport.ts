/**
 * Human-readable RTP report for the odds engine. Run with: npm run odds-report
 *
 * Prints the same simulations the automated test asserts on, but as a
 * table you can eyeball — useful when tuning shape parameters or the odds
 * config. Also explicitly flags any row that drifts from houseRtp beyond
 * a sane tolerance, per the "this is a verification step, not a tuning
 * step" requirement: under the survival-curve model, drift here means a
 * bug in computeSurvivalCurves, not an inherent model limitation.
 */
import { CHECKPOINTS_BY_BULB_COUNT } from '../src/checkpoints';
import { DEFAULT_ODDS_CONFIG } from '../src/odds/config';
import { runFixedOddsRtpSimulation, runMixedStrategyRtpSimulation } from '../src/odds/rtpSimulation';

const BULB_COUNTS = [5, 7, 10] as const;
const SHAPES = ['dominant', 'wide_open', 'duel'] as const;
const CYCLES = 20_000;
// Round-by-round cash-out simulation computes the O(n * 2^(n-1)) survival
// curve per cycle (the hold-to-resolution measurement above never touches
// it), so it gets its own, smaller cycle budget to keep this report quick.
const ROUND_BY_ROUND_CYCLES = 5_000;
const DRIFT_TOLERANCE = 0.03; // 3 percentage points

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function flag(rtp: number): string {
  const drift = Math.abs(rtp - DEFAULT_ODDS_CONFIG.houseRtp);
  return drift > DRIFT_TOLERANCE ? `  <-- DRIFT DETECTED (${(drift * 100).toFixed(2)}pp), investigate` : '';
}

console.log(`House RTP target: ${pct(DEFAULT_ODDS_CONFIG.houseRtp)}`);
console.log(`Coefficient clamp: ${DEFAULT_ODDS_CONFIG.minCoefficient}x - ${DEFAULT_ODDS_CONFIG.maxCoefficient}x`);
console.log(`Drift tolerance: ${(DRIFT_TOLERANCE * 100).toFixed(1)}pp`);
console.log(`Cycles per row: ${CYCLES.toLocaleString()}\n`);

console.log('=== Fixed-odds RTP (hold to natural resolution) ===');
console.log(
  ['shape', 'bulbs', 'RTP', 'diff', 'clampHigh', 'clampLow', 'maxCoeff'].map((h) => h.padEnd(10)).join(''),
);
for (const shape of SHAPES) {
  for (const bulbCount of BULB_COUNTS) {
    const r = runFixedOddsRtpSimulation({ bulbCount, cycles: CYCLES, shape });
    const diff = r.rtp - DEFAULT_ODDS_CONFIG.houseRtp;
    console.log(
      [
        shape,
        String(bulbCount),
        pct(r.rtp),
        `${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(2)}pp`,
        String(r.clampedHighCount),
        String(r.clampedLowCount),
        r.maxCoefficientSeen.toFixed(1) + 'x',
      ]
        .map((c) => c.padEnd(10))
        .join('') + flag(r.rtp),
    );
  }
}

console.log('\n=== Mixed random-shape RTP (shape re-rolled every cycle, like real play) ===');
const mixed = runFixedOddsRtpSimulation({ bulbCount: 10, cycles: 50_000 });
console.log(`RTP: ${pct(mixed.rtp)} over ${mixed.cycles.toLocaleString()} cycles${flag(mixed.rtp)}`);

console.log('\n=== Checkpoints (bulbs remaining at each cash-out decision point) ===');
for (const bulbCount of BULB_COUNTS) {
  console.log(`  ${bulbCount} bulbs: ${CHECKPOINTS_BY_BULB_COUNT[bulbCount].join(', ')}`);
}

console.log('\n=== Round-by-round cash-out RTP (survival-curve model, checkpoint-gated) ===');
console.log('Cash-out is only offered at the checkpoints above now — a mathematical guarantee, not an');
console.log('empirical approximation, so every row should still land near houseRtp.');
console.log(['shape', 'cashout%', 'RTP', 'diff'].map((h) => h.padEnd(12)).join(''));
for (const shape of SHAPES) {
  for (const cashoutProbabilityPerRound of [0.1, 0.3, 0.5, 0.9]) {
    const r = runMixedStrategyRtpSimulation({
      bulbCount: 10,
      cycles: ROUND_BY_ROUND_CYCLES,
      shape,
      cashoutProbabilityPerRound,
    });
    const diff = r.rtp - DEFAULT_ODDS_CONFIG.houseRtp;
    console.log(
      [shape, pct(cashoutProbabilityPerRound), pct(r.rtp), `${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(2)}pp`]
        .map((c) => c.padEnd(12))
        .join('') + flag(r.rtp),
    );
  }
}

console.log('\n=== Extreme timing strategies (sanity check the guarantee holds at the edges) ===');
for (const [label, cashoutProbabilityPerRound] of [
  ['cash out ASAP', 1.0],
  ['hold as long as possible', 0.02],
] as const) {
  const r = runMixedStrategyRtpSimulation({ bulbCount: 10, cycles: ROUND_BY_ROUND_CYCLES, cashoutProbabilityPerRound });
  console.log(`${label.padEnd(28)} RTP ${pct(r.rtp)}${flag(r.rtp)}`);
}
