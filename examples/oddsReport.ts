/**
 * Human-readable report for the pari-mutuel odds engine. Run with:
 *   npm run odds-report
 *
 * There is no fixed RTP target here — house take is an emergent property of
 * how stakes happen to land across bulbs in a given cycle, not a guaranteed
 * constant (see src/odds/rtpSimulation.ts). This prints the actual house
 * take across a range of representative player-count / stake-distribution
 * scenarios, purely for sanity-checking the formula (e.g. "does it ever pay
 * out more than was staked, net of the house cut?") — variance here is
 * expected, not a bug to chase.
 */
import { CHECKPOINTS_BY_BULB_COUNT } from '../src/checkpoints';
import { DEFAULT_ODDS_CONFIG } from '../src/odds/config';
import { ALL_SCENARIOS, runPariMutuelSimulation } from '../src/odds/rtpSimulation';

const BULB_COUNTS = [5, 7, 10] as const;
const CYCLES = 20_000;

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

console.log(`House cut rate: ${pct(DEFAULT_ODDS_CONFIG.houseCutRate)} of the losing pool only`);
console.log(`Cycles per row: ${CYCLES.toLocaleString()}`);
console.log(
  'NOTE: house take below is a MEASUREMENT, not a target — it is expected to vary by scenario and bulb count. ' +
    'This model has no fixed RTP guarantee; that is the point of pari-mutuel pricing.\n',
);

console.log('=== House take by scenario (hold to natural resolution) ===');
console.log(['scenario', 'bulbs', 'wagered', 'paidOut', 'houseTake', 'cancelled'].map((h) => h.padEnd(16)).join(''));
for (const scenario of ALL_SCENARIOS) {
  for (const bulbCount of BULB_COUNTS) {
    const r = runPariMutuelSimulation({ bulbCount, cycles: CYCLES, scenario });
    console.log(
      [
        scenario.name,
        String(bulbCount),
        r.totalWagered.toFixed(0),
        r.totalPaidOut.toFixed(0),
        pct(r.houseTakePct),
        `${r.uncontestedCycles}/${r.cycles}`,
      ]
        .map((c) => c.padEnd(16))
        .join(''),
    );
  }
}

console.log('\n=== Checkpoints (bulbs remaining at each cash-out decision point — unchanged by this model) ===');
for (const bulbCount of BULB_COUNTS) {
  console.log(`  ${bulbCount} bulbs: ${CHECKPOINTS_BY_BULB_COUNT[bulbCount].join(', ')}`);
}

console.log('\n=== Sanity check: house take should never be negative (never pays out more than staked, net of cut) ===');
let anyNegative = false;
for (const scenario of ALL_SCENARIOS) {
  for (const bulbCount of BULB_COUNTS) {
    const r = runPariMutuelSimulation({ bulbCount, cycles: CYCLES, scenario });
    if (r.houseTakePct < -1e-9) {
      anyNegative = true;
      console.log(`  <-- NEGATIVE HOUSE TAKE: ${scenario.name} bulbCount=${bulbCount} houseTake=${pct(r.houseTakePct)}`);
    }
  }
}
console.log(anyNegative ? 'FAILED — see rows above.' : 'OK — every scenario had a non-negative house take.');
