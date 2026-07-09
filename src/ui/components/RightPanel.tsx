import { useState } from 'react';
import { BetHistory } from './BetHistory';
import { Leaderboard } from './Leaderboard';
import { LiveBetsFeed } from './LiveBetsFeed';

type Tab = 'live' | 'history' | 'leaderboard';

const TABS: { id: Tab; label: string }[] = [
  { id: 'live', label: 'Live Bets' },
  { id: 'history', label: 'My History' },
  { id: 'leaderboard', label: 'Leaderboard' },
];

export function RightPanel() {
  const [tab, setTab] = useState<Tab>('live');

  return (
    <div className="right-panel chrome">
      <div className="right-panel__tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`right-panel__tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="right-panel__body">
        {tab === 'live' && <LiveBetsFeed />}
        {tab === 'history' && <BetHistory />}
        {tab === 'leaderboard' && <Leaderboard />}
      </div>
    </div>
  );
}
