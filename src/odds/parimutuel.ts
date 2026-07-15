/**
 * The pari-mutuel pool model, built around one hard business invariant:
 *
 *   THE HOUSE NEVER RISKS ITS OWN MONEY. Players bet against each other.
 *   Each round, the stakes of players eliminated that round form a pool;
 *   the house keeps a flat `houseCutRate` (5%) of that pool, uncondition-
 *   ally, and the remaining 95% belongs to the surviving players. Across a
 *   whole cycle, everything ever paid out of the pool (mid-cycle cash-outs
 *   plus the final win) can never exceed that 95% — because it is all
 *   drawn from ONE shared, depleting ledger (PoolLedger below), never from
 *   independent per-bulb copies of the same money.
 *
 * How the 95% is divided (see the PoolLedger.coefficients() comment for
 * the full reasoning):
 *
 *   - Each alive bettor's pool share is proportional to their own ACTIVE
 *     (not cashed-out) stake:  share_i = remainingPool × S_i / ΣS, where
 *     ΣS is the total active stake across ALL alive staked bulbs.
 *   - So live_coefficient_i = 1 + share_i / S_i = 1 + remainingPool / ΣS —
 *     the SAME value for every alive staked bulb. Dollar payouts still
 *     scale with stake (payout = stake × coefficient), and the sum of
 *     every bettor's maximum possible claim is exactly the remaining pool
 *     — never more.
 *   - With one alive staked bulb ΣS = S_winner, so the winner's
 *     coefficient degenerates to 1 + remainingPool / S_winner — the same
 *     shape as the historical win payout formula.
 *
 * Two further consequences of "the pool is real money, not a formula":
 *
 *   - A cash-out removes the player's stake from the game along with their
 *     pool claim. If their bulb later pops, that stake does NOT enter the
 *     eliminated pool (the money already left in their payout) — only the
 *     stakes of players still in the game when their bulb pops do.
 *   - Every claim (cash-out or win) immediately depletes `remainingPool`,
 *     so later claimants — same window or later rounds — price against
 *     what is actually left, not against a static snapshot.
 *
 * If nobody has active stake on a bulb, its coefficient is undefined —
 * callers must treat `undefined` as "blank," never coerce it to 0 or any
 * fallback number.
 */
import type { Bulb, HouseTakeBreakdown, Player } from '../types';

/** Coefficient for a bulb whose active stake is `activeStakeOnBulb` and
 *  whose reserved share of the remaining pool is `bulbPoolShare`:
 *  1 + share/stake. Undefined (never 0, never a fallback) when the bulb has
 *  no active stake to price against. */
export function computeCoefficient(
  activeStakeOnBulb: number,
  bulbPoolShare: number,
): number | undefined {
  if (activeStakeOnBulb <= 0) return undefined;
  return 1 + bulbPoolShare / activeStakeOnBulb;
}

/** Total stake, across ALL players regardless of status, on every bulb —
 *  keyed by bulb id. This is the audit-trail record of what was wagered;
 *  pricing uses activeStakeByBulbId() instead. */
export function totalStakeByBulbId(players: Player[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const player of players) {
    totals.set(player.bulbId, (totals.get(player.bulbId) ?? 0) + player.stake);
  }
  return totals;
}

/** Stake still IN the game per bulb — only players with status 'active'.
 *  A cashed-out player's stake left with them; a popped player's stake has
 *  moved into the pool. Pricing and pool contributions both run on this. */
export function activeStakeByBulbId(players: Player[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const player of players) {
    if (player.status !== 'active') continue;
    totals.set(player.bulbId, (totals.get(player.bulbId) ?? 0) + player.stake);
  }
  return totals;
}

/**
 * Splits a completed cycle's house take into the flat edge versus the
 * portion of the pool nobody was left to claim. All `claimed*` figures are
 * POOL money only — returned stakes are the player's own money coming
 * back, never part of the pool, so they don't appear here.
 *
 * `claimedByWinners` is the pool money paid to still-active bettors on the
 * winning bulb at final settlement; `claimedEarlier` is the pool money
 * already paid out via mid-cycle cash-outs (on any bulb). Whatever's left
 * of the distributable pool after both has no remaining claimant — a
 * cash-out is final (see PlayerStatus) — and stays with the house.
 */
export function computeHouseTake(
  eliminatedPool: number,
  houseCutRate: number,
  claimedByWinners: number,
  claimedEarlier = 0,
): HouseTakeBreakdown {
  const standardCut = houseCutRate * eliminatedPool;
  const distributablePool = eliminatedPool - standardCut;
  // Floors a hairline-negative float artifact to 0 — total claims can
  // never legitimately exceed distributablePool: every claim came out of
  // the depleting PoolLedger, which never goes below zero.
  const unclaimedPool = Math.max(0, distributablePool - claimedEarlier - claimedByWinners);
  return {
    eliminatedPool,
    standardCut,
    distributablePool,
    claimedByWinners,
    unclaimedPool,
    totalHouseTake: standardCut + unclaimedPool,
  };
}

/**
 * The per-cycle shared money ledger — the fix for the double-payout bug.
 *
 * Previously every alive bulb was priced as `1 + fullPool / ownStake`,
 * each against an independent full copy of the distributable pool; if
 * bettors on two different alive bulbs both cashed out, the same pool
 * dollars were paid twice and the house covered the difference. This
 * ledger makes the pool a single depleting balance: contributions come in
 * only from stakes actually still in the game when their bulb pops, every
 * claim immediately subtracts, and pricing always divides what genuinely
 * remains. `remainingPool` can never go negative under any interleaving of
 * cash-outs, because the per-bulb shares handed out at any moment sum to
 * exactly `remainingPool` — see coefficients().
 */
export class PoolLedger {
  readonly houseCutRate: number;

  /** Cumulative EFFECTIVE eliminated stakes: only money still in the game
   *  when its bulb popped. (A cashed-out player's stake already left with
   *  their payout — re-adding it here would pay the same dollars twice.) */
  private eliminated = 0;
  /** houseCutRate × eliminated, accrued per pop — flat and unconditional. */
  private standardCut = 0;
  /** The live 95% balance available to survivors right now. */
  private remaining = 0;
  /** Cumulative pool money already paid out via claims (excludes returned
   *  stakes — those are the players' own money). */
  private claimed = 0;

  constructor(houseCutRate: number) {
    this.houseCutRate = houseCutRate;
  }

  get eliminatedPool(): number {
    return this.eliminated;
  }

  get standardCutTotal(): number {
    return this.standardCut;
  }

  get remainingPool(): number {
    return this.remaining;
  }

  get claimedFromPool(): number {
    return this.claimed;
  }

  /** A bulb popped: `activeStakeOnBulb` is the total stake of players who
   *  were still active on it (they're now popped/losers). The house cut is
   *  taken here, per round, unconditionally; the rest joins the shared
   *  pool. */
  recordElimination(activeStakeOnBulb: number): void {
    if (activeStakeOnBulb <= 0) return;
    this.eliminated += activeStakeOnBulb;
    this.standardCut += this.houseCutRate * activeStakeOnBulb;
    this.remaining += (1 - this.houseCutRate) * activeStakeOnBulb;
  }

  /**
   * Live coefficient for every alive bulb with active stake.
   *
   * DESIGN DECISION (how simultaneously-alive bulbs share one pool):
   * each alive bettor's pool share is proportional to their own active
   * stake — share_i = remaining × S_i/ΣS, where ΣS is the total active
   * stake across ALL alive staked bulbs — giving every alive staked bulb
   * the identical coefficient
   *
   *     c = 1 + remaining / ΣS
   *
   * Why proportional-to-stake rather than the old equal-per-bulb split
   * (1/N slice per bulb): equal-per-bulb handed a $1 bettor the same
   * dollar-sized pool slice as a $10 bettor, so betting LESS produced a
   * dramatically higher multiple — an exploit that rewarded splitting
   * into many tiny bets on thin bulbs. Proportional-to-stake removes
   * that: every alive player sees the same coefficient, but the dollar
   * payout (stake × coefficient) still scales with their own stake. The
   * no-overpayment invariant is preserved unchanged: Σ claims =
   * ΣS × (remaining/ΣS) = remaining exactly, so even if every active
   * player on every alive bulb cashes out in the same window, total
   * claims = remainingPool, never a dollar more.
   */
  coefficients(bulbs: Bulb[], players: Player[]): Map<string, number> {
    const activeStakes = activeStakeByBulbId(players);
    const aliveStakedBulbs = bulbs.filter(
      (b) => b.status === 'alive' && (activeStakes.get(b.id) ?? 0) > 0,
    );

    const result = new Map<string, number>();
    if (aliveStakedBulbs.length === 0) return result;

    let totalAliveActiveStake = 0;
    for (const bulb of aliveStakedBulbs) {
      totalAliveActiveStake += activeStakes.get(bulb.id)!;
    }

    const coefficient = computeCoefficient(totalAliveActiveStake, this.remaining)!;
    for (const bulb of aliveStakedBulbs) {
      result.set(bulb.id, coefficient);
    }
    return result;
  }

  /** Pays one player at `coefficient`: returns the full payout value
   *  (their own stake back + their pool claim) and PERMANENTLY subtracts
   *  the pool-claim portion from the shared balance, so every later claim
   *  — same decision window or later rounds — prices against what is
   *  actually left. */
  claim(stake: number, coefficient: number): number {
    const poolClaim = stake * (coefficient - 1);
    // Floor guards float dust only; by construction the shares handed out
    // at any pricing moment sum to <= remaining, so a genuine overdraw is
    // impossible. Not a business-rule clamp — see coefficients().
    this.remaining = Math.max(0, this.remaining - poolClaim);
    this.claimed += poolClaim;
    return stake + poolClaim;
  }

  /** Final-settlement breakdown. `claimedByWinners` = pool money paid to
   *  the winning bulb's still-active bettors (their returned stakes
   *  excluded); everything claimed before that was mid-cycle cash-outs. */
  houseTakeBreakdown(claimedByWinners: number): HouseTakeBreakdown {
    const claimedEarlier = this.claimed - claimedByWinners;
    return computeHouseTake(this.eliminated, this.houseCutRate, claimedByWinners, claimedEarlier);
  }
}
