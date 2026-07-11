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
import {
  ALL_CASHOUT_BEHAVIORS,
  ALL_SCENARIOS,
  runCashOutBehaviorSimulation,
  runPariMutuelSimulation,
} from '../src/odds/rtpSimulation';

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
console.log('(hold-to-resolution only — see the cash-out distribution section below for what changes once cash-outs are in play)');
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

// ---------------------------------------------------------------------------
// Cash-out behavior distribution — the "unclaimed pool" report.
//
// The 5% edge is only a hard floor when nobody cashes out early. The moment
// real cash-out behavior enters the picture, house take per cycle becomes a
// genuine DISTRIBUTION, not a single number — reported here as min/max/
// median/average across many simulated cycles, per behavior pattern, so it
// can be eyeballed instead of hidden behind one averaged headline figure.
// ---------------------------------------------------------------------------
const CASHOUT_CYCLES = 5_000;

console.log('\n=== House-take distribution by cash-out behavior ===');
console.log(`Cycles per row: ${CASHOUT_CYCLES.toLocaleString()}`);
console.log(
  ['behavior', 'scenario', 'bulbs', 'aggTake', 'min', 'median', 'avg', 'max', 'stdCut', 'unclaimed']
    .map((h) => h.padEnd(12))
    .join(''),
);
for (const behavior of ALL_CASHOUT_BEHAVIORS) {
  for (const scenario of ALL_SCENARIOS) {
    for (const bulbCount of BULB_COUNTS) {
      const r = runCashOutBehaviorSimulation({ bulbCount, cycles: CASHOUT_CYCLES, scenario, behavior });
      console.log(
        [
          behavior.name,
          scenario.name,
          String(bulbCount),
          pct(r.aggregateHouseTakePct),
          pct(r.distribution.min),
          pct(r.distribution.median),
          pct(r.distribution.average),
          pct(r.distribution.max),
          pct(r.standardCutShareOfVolume),
          pct(r.unclaimedPoolShareOfVolume),
        ]
          .map((c) => c.padEnd(12))
          .join(''),
      );
    }
  }
}

console.log(
  '\nNOTE: this project offers a cash-out decision window after EVERY round (see checkpoints.ts), on whichever\n' +
    "bulbs are still alive at that point -- not only the eventual winner. computeCoefficients() prices every\n" +
    'still-alive bulb independently off the SAME distributablePool, which is only non-overlapping once payout\n' +
    "happens for exactly one bulb (the final winner, hold-to-resolution). Once multiple DIFFERENT bulbs' bettors\n" +
    'cash out at overlapping checkpoints (rather than only the winning bulb\'s bettors cashing out), the rows\n' +
    'above can -- and empirically do -- go well BELOW the flat 5% edge, including negative (paying out more than\n' +
    'was wagered). The "5% is a floor" framing holds only for the specific case this task named (early cash-outs\n' +
    'concentrated on the eventual winning bulb); it is not a general floor once cash-outs on OTHER, later-losing\n' +
    'bulbs are included. See CycleHouseTakeSample / computeHouseTake() docs for the exact boundary between the two.',
);
