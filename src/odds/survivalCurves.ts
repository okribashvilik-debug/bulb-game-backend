/**
 * Exact, analytical survival-probability curves for the round-by-round
 * cash-out formula.
 *
 * survivalCurve(bulbId)[r-1] = P(bulb i is still alive going into round r),
 * for r = 1 .. totalRounds+1 (totalRounds+1 meaning "having survived every
 * round" — i.e. being the winner).
 *
 * This is UNCONDITIONAL: it does not know or care which bulb actually wins
 * this cycle. It only uses each bulb's assigned probability. That's the
 * whole point — a bulb's cash-out value must be a fair price for "a bulb
 * with probability p that has survived r-1 rounds," not a price that
 * secretly knows the answer. (Conditioning on the real winner is exactly
 * the bug the previous renormalization-based model had: the actual winner
 * would look "obviously safe" and its cash-out value would collapse.)
 *
 * ---- The model ------------------------------------------------------
 * The real game generates its outcome in two steps (see outcomePlan.ts):
 *   1. Winner w is drawn with probability p_w.
 *   2. The other N-1 bulbs ("losers") are eliminated one per round, via
 *      weighted sampling without replacement over the loser pool, weight
 *      = 1/p_j (so lower-probability bulbs tend to pop earlier).
 *
 * To get bulb i's UNCONDITIONAL probability of surviving to round r, we
 * average over every possible winner w (weighted by p_w):
 *
 *   P(i alive at r) = sum_w  p_w * P(i alive at r | winner = w)
 *
 * When w = i, that conditional probability is 1 (the winner never pops).
 * When w != i, i is one of the losers in that scenario, and
 * P(i alive at r | winner = w) is the survival probability of item i
 * under weighted-elimination-without-replacement (Plackett-Luce) over the
 * loser pool for that scenario.
 *
 * That per-scenario survival probability doesn't have a simple closed
 * form (later draws depend on exactly which earlier items were removed),
 * but for bulb counts this game supports (max 10, so max 9 losers) it's
 * cheap to compute EXACTLY via a subset dynamic program: walk every
 * possible surviving-pool state from "everyone left" down to "empty",
 * accumulating how much probability mass reaches each state. This is
 * O(2^(n-1)) per winner scenario, trivially fast for n <= 10 — but this
 * runs on every simulated cycle in the RTP test harness (hundreds of
 * thousands of them), so the implementation below is written for speed:
 * typed arrays and integer indices throughout, and every buffer that's
 * shared shape across winner scenarios (mask groupings, DP scratch space)
 * is allocated once per call and reused, not once per scenario.
 *
 * Two invariants this must satisfy, checked in the test suite:
 *   - sum_i survivalCurve(i)[r-1] == n - r + 1 for every r (exactly n-r+1
 *     bulbs are alive entering round r, always — it's the population
 *     count, not random, even though WHICH bulbs make up that count is).
 *   - survivalCurve(i)[0] == 1 and survivalCurve(i)[totalRounds] == p_i,
 *     both exactly (no accumulated floating-point summation involved at
 *     either boundary).
 */

/**
 * Per-loser-pool-size (m) scratch state: mask groupings and DP buffers
 * depend only on m, not on any cycle's actual probabilities, and this game
 * only ever has m = bulbCount - 1 in {4, 6, 9}. Caching by m (module-level,
 * lazily populated) means this scratch space is allocated once per distinct
 * m for the process's whole lifetime instead of once per cycle — this
 * function runs on every simulated cycle in the RTP harness (hundreds of
 * thousands of them), so that allocation churn was the dominant cost.
 *
 * Safe because computeSurvivalCurves is synchronous and never reentrant
 * (JS is single-threaded and this function doesn't call itself) — if that
 * ever changes, this cache needs to move to per-call allocation instead.
 */
interface ScratchForM {
  masksByPopcount: number[][];
  /** setBitsByMask[mask] = the set-bit indices of `mask`, precomputed once
   *  so the DP's inner loops iterate exactly popcount(mask) times instead
   *  of scanning and skipping across all m bits every time. */
  setBitsByMask: Int32Array[];
  g: Float64Array;
  loserWeight: Float64Array;
  loserGlobalIndex: Int32Array;
}
const scratchByM = new Map<number, ScratchForM>();

function getScratch(m: number): ScratchForM {
  let scratch = scratchByM.get(m);
  if (scratch) return scratch;

  const totalMasks = 1 << m;
  const masksByPopcount: number[][] = Array.from({ length: m + 1 }, () => []);
  const setBitsByMask: Int32Array[] = new Array(totalMasks);
  for (let mask = 0; mask < totalMasks; mask++) {
    masksByPopcount[popcount(mask)].push(mask);
    const bits: number[] = [];
    for (let lj = 0; lj < m; lj++) {
      if (mask & (1 << lj)) bits.push(lj);
    }
    setBitsByMask[mask] = Int32Array.from(bits);
  }
  scratch = {
    masksByPopcount,
    setBitsByMask,
    g: new Float64Array(totalMasks),
    loserWeight: new Float64Array(m),
    loserGlobalIndex: new Int32Array(m),
  };
  scratchByM.set(m, scratch);
  return scratch;
}

export function computeSurvivalCurves(
  bulbIds: string[],
  probabilityByBulbId: Map<string, number>,
): Map<string, number[]> {
  const n = bulbIds.length;
  const totalRounds = n - 1;
  const m = totalRounds; // loser pool size in every winner scenario

  // Work in plain typed arrays / integer indices internally — this runs
  // on every simulated cycle in the RTP harness, so Map.get() + string
  // keys in the hot loop would dominate the cost.
  const probability = new Float64Array(n);
  const weight = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    probability[i] = probabilityByBulbId.get(bulbIds[i])!;
    weight[i] = 1 / probability[i];
  }

  const curves: Float64Array[] = Array.from({ length: n }, () => new Float64Array(totalRounds + 1));

  const totalMasks = 1 << m;
  const fullMask = totalMasks - 1;
  const { masksByPopcount, setBitsByMask, g, loserWeight, loserGlobalIndex } = getScratch(m);

  for (let winnerIdx = 0; winnerIdx < n; winnerIdx++) {
    const pWinner = probability[winnerIdx];

    // The winner never pops in this scenario — survives every round with
    // certainty, contributing pWinner to every entry of its own curve.
    const winnerCurve = curves[winnerIdx];
    for (let r = 0; r <= totalRounds; r++) winnerCurve[r] += pWinner;

    // This scenario's loser pool: every other bulb, local index 0..m-1.
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (i === winnerIdx) continue;
      loserGlobalIndex[j] = i;
      loserWeight[j] = weight[i];
      j++;
    }

    g.fill(0);
    g[fullMask] = 1; // before any elimination, the whole pool is present

    // Process from the full pool down to empty — every subset's
    // probability mass is fully settled before it's used to compute the
    // next level down.
    for (let pc = m; pc >= 0; pc--) {
      const k = m - pc; // eliminations elapsed to reach this popcount level
      const masks = masksByPopcount[pc];

      for (let mi = 0; mi < masks.length; mi++) {
        const mask = masks[mi];
        const prob = g[mask];
        if (prob === 0) continue;

        const bits = setBitsByMask[mask];

        // Record survival for every loser present, and (in the same pass)
        // total up this pool's weight for the transition step below.
        let poolWeight = 0;
        for (let bi = 0; bi < bits.length; bi++) {
          const lj = bits[bi];
          curves[loserGlobalIndex[lj]][k] += pWinner * prob;
          if (pc > 0) poolWeight += loserWeight[lj];
        }

        if (pc === 0) continue; // nothing left to eliminate

        for (let bi = 0; bi < bits.length; bi++) {
          const lj = bits[bi];
          g[mask & ~(1 << lj)] += (prob * loserWeight[lj]) / poolWeight;
        }
      }
    }
  }

  const result = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    result.set(bulbIds[i], Array.from(curves[i]));
  }
  return result;
}

function popcount(x: number): number {
  let count = 0;
  while (x) {
    x &= x - 1;
    count++;
  }
  return count;
}
