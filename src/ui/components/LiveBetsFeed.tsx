import { useMemo } from 'react';
import { useGame } from '../GameContext';
import { bulbNumber, formatCurrency } from '../format';
import { maskUsername } from '../maskUsername';
import { getBulbColor } from '../palette';
import type { BetFeedEntry, ResolvedBet } from '../useBulbGame';

interface LiveFeedRow {
  id: string;
  displayName: string;
  bulbId: string;
  stake: number;
  isMine: boolean;
  /** undefined until resolved; stays undefined forever for a popped (lost) bet. */
  payout: number | undefined;
  payoutOutcome: ResolvedBet['outcome'] | undefined;
}

/** Bets belong to this view only while they're the CURRENT cycle — scoping
 *  by snapshot.cycleId (server-pushed, already driving every other piece of
 *  live state) means a new betting window empties this list for free, with
 *  no separate reset to track: entries from the previous cycle simply stop
 *  matching the moment the id changes. Past cycles still live on in
 *  betsFeed/resolvedBets for "My History" and the Leaderboard — this is a
 *  presentation-level filter, not a change to what's tracked. */
function currentCycleOnly<T extends { cycleId: string }>(entries: T[], cycleId: string): T[] {
  return entries.filter((entry) => entry.cycleId === cycleId);
}

/** Fixed summary bar above the live feed list — total bets, total staked,
 *  and distinct bulbs contested, all for the current cycle only. Updates
 *  live as 'betPlaced' broadcasts arrive during the betting window, then
 *  naturally stops changing once betting closes (the server stops
 *  accepting bets, so no more events arrive) — landing on exactly the same
 *  total the pari-mutuel engine locks in as final_stake_by_bulb. */
export function LiveBetsSummary() {
  const { betsFeed, snapshot } = useGame();

  const stats = useMemo(() => {
    const current = currentCycleOnly(betsFeed, snapshot.cycleId);
    const totalStaked = current.reduce((sum, entry) => sum + entry.stake, 0);
    const bulbsContested = new Set(current.map((entry) => entry.bulbId)).size;
    return { betCount: current.length, totalStaked, bulbsContested };
  }, [betsFeed, snapshot.cycleId]);

  return (
    <div className="live-bets-summary">
      <div className="live-bets-summary__stat">
        <span className="live-bets-summary__value">{stats.betCount}</span>
        <span className="live-bets-summary__label">bets</span>
      </div>
      <div className="live-bets-summary__stat">
        <span className="live-bets-summary__value">{formatCurrency(stats.totalStaked)}</span>
        <span className="live-bets-summary__label">staked</span>
      </div>
      <div className="live-bets-summary__stat">
        <span className="live-bets-summary__value">{stats.bulbsContested}</span>
        <span className="live-bets-summary__label">bulbs</span>
      </div>
    </div>
  );
}

export function LiveBetsFeed() {
  const { betsFeed, resolvedBets, snapshot } = useGame();

  // Resolution (win / cash-out / pop) arrives as a separate event from the
  // original bet placement, so the two are merged here by (cycle, player)
  // — the same row updates in place as its outcome becomes known, rather
  // than appending a second row.
  const rows = useMemo<LiveFeedRow[]>(() => {
    const currentBets: BetFeedEntry[] = currentCycleOnly(betsFeed, snapshot.cycleId);
    const currentResolved = currentCycleOnly(resolvedBets, snapshot.cycleId);

    const resolutionByKey = new Map<string, ResolvedBet>();
    for (const bet of currentResolved) {
      resolutionByKey.set(`${bet.cycleId}:${bet.playerId}`, bet);
    }

    return currentBets.map((entry) => {
      const resolution = resolutionByKey.get(`${entry.cycleId}:${entry.playerId}`);
      // A popped (lost) bet resolves too, but must show a blank payout,
      // never "$0" — so only won/cashed_out ever populate `payout`.
      const payout =
        resolution && (resolution.outcome === 'won' || resolution.outcome === 'cashed_out')
          ? resolution.value
          : undefined;

      return {
        id: entry.id,
        displayName: entry.isHuman ? 'You' : maskUsername(entry.playerId),
        bulbId: entry.bulbId,
        stake: entry.stake,
        isMine: entry.isHuman,
        payout,
        payoutOutcome: resolution?.outcome,
      };
    });
  }, [betsFeed, resolvedBets, snapshot.cycleId]);

  if (rows.length === 0) {
    return <div className="empty-state">No bets yet this round — be the first.</div>;
  }

  return (
    <div>
      {rows.map((row) => (
        <div key={row.id} className={`live-feed-row ${row.isMine ? 'live-feed-row--mine' : ''}`}>
          <span className="live-feed-row__name">{row.displayName}</span>
          <span className="live-feed-row__bulb">
            <span className="live-feed-row__bulb-dot" style={{ backgroundColor: getBulbColor(row.bulbId) }} />
            {bulbNumber(row.bulbId)}
          </span>
          <span className="live-feed-row__stake">{formatCurrency(row.stake)}</span>
          <span
            className={`live-feed-row__payout ${
              row.payoutOutcome === 'won' ? 'live-feed-row__payout--won' : ''
            } ${row.payoutOutcome === 'cashed_out' ? 'live-feed-row__payout--cashed' : ''}`}
          >
            {row.payout !== undefined ? formatCurrency(row.payout) : ''}
          </span>
        </div>
      ))}
    </div>
  );
}
