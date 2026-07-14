import { useState } from 'react';
import { useGame } from '../GameContext';
import { formatCoefficient } from '../format';
import { getBulbColor } from '../palette';
import type { OutcomeHistoryEntry } from '../useBulbGame';

const COLLAPSED_COUNT = 10;
const EXPANDED_COUNT = 30;

function coeffTier(coefficient: number | undefined): 1 | 2 | 3 | 4 {
  if (coefficient === undefined) return 1;
  if (coefficient >= 15) return 4;
  if (coefficient >= 5) return 3;
  if (coefficient >= 2) return 2;
  return 1;
}

function OutcomeChip({ entry }: { entry: OutcomeHistoryEntry }) {
  return (
    <div className={`outcome-chip outcome-chip--tier-${coeffTier(entry.coefficient)}`}>
      <span className="outcome-chip__bulb" style={{ backgroundColor: getBulbColor(entry.bulbId) }}>
        {entry.bulbNumber}
      </span>
      {/* Nobody (not even a bot) staked on the winning bulb — a real,
         valid outcome under uniform-random elimination, not an error. */}
      <span className="outcome-chip__coeff">{entry.coefficient !== undefined ? formatCoefficient(entry.coefficient) : '—'}</span>
    </div>
  );
}

export function TopStrip() {
  const { outcomeHistory } = useGame();
  const [expanded, setExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const visible = outcomeHistory.slice(0, expanded ? EXPANDED_COUNT : COLLAPSED_COUNT);
  const canExpand = outcomeHistory.length > COLLAPSED_COUNT;
  // Same source + ordering convention as the inline chips (newest first).
  const previousRounds = outcomeHistory.slice(0, EXPANDED_COUNT);

  return (
    <div className="top-strip chrome">
      <div className="top-strip__brand">
        <span aria-hidden="true">💡</span>
        <span>Bulb Game</span>
      </div>
      <div className="top-strip__history">
        <button
          className="chip-btn top-strip__prev-toggle"
          onClick={() => setHistoryOpen((v) => !v)}
          aria-expanded={historyOpen}
        >
          Previous Rounds {historyOpen ? '▲' : '▼'}
        </button>
        {historyOpen && (
          <div className="top-strip__history-panel" role="dialog" aria-label="Previous rounds">
            <div className="top-strip__history-panel-title">Previous rounds</div>
            <div className="top-strip__history-grid">
              {previousRounds.length === 0 && <span className="empty-state">No rounds yet</span>}
              {previousRounds.map((entry) => (
                <OutcomeChip key={entry.cycleId} entry={entry} />
              ))}
            </div>
          </div>
        )}
      </div>
      <div className={`top-strip__chips ${expanded ? 'expanded' : ''}`}>
        {visible.length === 0 && (
          <span className="empty-state" style={{ padding: '0 8px' }}>
            No rounds yet
          </span>
        )}
        {visible.map((entry) => (
          <OutcomeChip key={entry.cycleId} entry={entry} />
        ))}
      </div>
      {canExpand && (
        <button className="chip-btn top-strip__toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Previous rounds'}
        </button>
      )}
    </div>
  );
}
