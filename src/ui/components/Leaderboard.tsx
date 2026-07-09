import { useMemo, useState } from 'react';
import { useGame } from '../GameContext';
import { formatCurrency } from '../format';
import { HUMAN_PLAYER_ID } from '../useBulbGame';

type Window = 'day' | 'week' | 'month';

const WINDOW_MS: Record<Window, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

const WINDOW_LABEL: Record<Window, string> = { day: 'Day', week: 'Week', month: 'Month' };

export function Leaderboard() {
  const { resolvedBets } = useGame();
  const [window, setWindow] = useState<Window>('day');

  const ranked = useMemo(() => {
    const cutoff = Date.now() - WINDOW_MS[window];
    const netByPlayer = new Map<string, number>();

    for (const bet of resolvedBets) {
      if (bet.timestamp < cutoff) continue;
      const net = bet.value - bet.stake;
      netByPlayer.set(bet.playerId, (netByPlayer.get(bet.playerId) ?? 0) + net);
    }

    return [...netByPlayer.entries()]
      .map(([playerId, netProfit]) => ({ playerId, netProfit }))
      .sort((a, b) => b.netProfit - a.netProfit)
      .slice(0, 10);
  }, [resolvedBets, window]);

  return (
    <div>
      <div className="leaderboard__filters">
        {(Object.keys(WINDOW_LABEL) as Window[]).map((w) => (
          <button key={w} className={`chip-btn ${w === window ? 'active' : ''}`} onClick={() => setWindow(w)}>
            {WINDOW_LABEL[w]}
          </button>
        ))}
      </div>

      {ranked.length === 0 && <div className="empty-state">No results in this window yet.</div>}

      {ranked.map((entry, index) => (
        <div key={entry.playerId} className="leaderboard-row">
          <span className={`leaderboard-row__rank ${index < 3 ? 'leaderboard-row__rank--top' : ''}`}>
            #{index + 1}
          </span>
          <span className="leaderboard-row__name">
            {entry.playerId === HUMAN_PLAYER_ID ? 'You' : entry.playerId}
          </span>
          <span
            className="leaderboard-row__profit"
            style={{ color: entry.netProfit >= 0 ? 'var(--green)' : 'var(--red)' }}
          >
            {entry.netProfit >= 0 ? '+' : ''}
            {formatCurrency(entry.netProfit)}
          </span>
        </div>
      ))}
    </div>
  );
}
