import { useGame } from '../GameContext';
import { bulbNumber, formatCurrency, relativeTime } from '../format';
import { getBulbColor } from '../palette';
import { HUMAN_PLAYER_ID, type ResolvedBet } from '../useBulbGame';

const OUTCOME_LABEL: Record<ResolvedBet['outcome'], string> = {
  won: 'Won',
  cashed_out: 'Cashed out',
  popped: 'Popped',
};

function amountClass(outcome: ResolvedBet['outcome']): string {
  if (outcome === 'won') return 'feed-row__amount--won';
  if (outcome === 'cashed_out') return 'feed-row__amount--cashed';
  return 'feed-row__amount--lost';
}

export function BetHistory() {
  const { resolvedBets } = useGame();
  const mine = resolvedBets.filter((bet) => bet.playerId === HUMAN_PLAYER_ID);

  if (mine.length === 0) {
    return <div className="empty-state">Your resolved bets will show up here.</div>;
  }

  return (
    <div>
      {mine.map((bet) => (
        <div key={bet.id} className="feed-row">
          <div className="feed-row__player">
            <span className="feed-row__bulb-dot" style={{ backgroundColor: getBulbColor(bet.bulbId) }} />
            <span className="name">bulb {bulbNumber(bet.bulbId)}</span>
          </div>
          <div className="feed-row__meta">
            {OUTCOME_LABEL[bet.outcome]} · {relativeTime(bet.timestamp)}
          </div>
          <div className={`feed-row__amount ${amountClass(bet.outcome)}`}>
            {bet.outcome === 'popped' ? `-${formatCurrency(bet.stake)}` : `+${formatCurrency(bet.value)}`}
          </div>
        </div>
      ))}
    </div>
  );
}
