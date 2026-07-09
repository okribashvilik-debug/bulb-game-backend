import { useMemo } from 'react';
import { useGame } from '../GameContext';
import { bulbNumber, formatCurrency } from '../format';
import { maskUsername } from '../maskUsername';
import { getBulbColor } from '../palette';
import type { ResolvedBet } from '../useBulbGame';

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

export function LiveBetsFeed() {
  const { betsFeed, resolvedBets } = useGame();

  // Resolution (win / cash-out / pop) arrives as a separate event from the
  // original bet placement, so the two are merged here by (cycle, player)
  // — the same row updates in place as its outcome becomes known, rather
  // than appending a second row.
  const rows = useMemo<LiveFeedRow[]>(() => {
    const resolutionByKey = new Map<string, ResolvedBet>();
    for (const bet of resolvedBets) {
      resolutionByKey.set(`${bet.cycleId}:${bet.playerId}`, bet);
    }

    return betsFeed.map((entry) => {
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
  }, [betsFeed, resolvedBets]);

  if (rows.length === 0) {
    return <div className="empty-state">No bets yet this session — be the first.</div>;
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
