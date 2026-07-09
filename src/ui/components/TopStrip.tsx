import { useState } from 'react';
import { useGame } from '../GameContext';
import { formatCoefficient } from '../format';
import { getBulbColor } from '../palette';
import type { BulbCount } from '../../types';
import type { OutcomeHistoryEntry } from '../useBulbGame';

const COLLAPSED_COUNT = 10;
const EXPANDED_COUNT = 30;
const BULB_COUNT_OPTIONS: BulbCount[] = [5, 7, 10];

function coeffTier(coefficient: number): 1 | 2 | 3 | 4 {
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
      <span className="outcome-chip__coeff">{formatCoefficient(entry.coefficient)}</span>
    </div>
  );
}

export function TopStrip() {
  const { outcomeHistory, bulbCount, setBulbCount, snapshot, muted, setMuted } = useGame();
  const [expanded, setExpanded] = useState(false);

  const visible = outcomeHistory.slice(0, expanded ? EXPANDED_COUNT : COLLAPSED_COUNT);
  const canExpand = outcomeHistory.length > COLLAPSED_COUNT;
  const pendingChange = bulbCount !== snapshot.bulbCount;

  return (
    <div className="top-strip chrome">
      <div className="top-strip__brand">
        <span aria-hidden="true">💡</span>
        <span>Bulb Game</span>
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
          {expanded ? 'Show less' : `Last ${EXPANDED_COUNT}`}
        </button>
      )}
      <button
        className="chip-btn top-strip__mute"
        onClick={() => setMuted(!muted)}
        aria-label={muted ? 'Unmute sound' : 'Mute sound'}
        title={muted ? 'Unmute sound' : 'Mute sound'}
      >
        {muted ? '🔇' : '🔊'}
      </button>
      <div
        className="top-strip__bulb-count"
        title={pendingChange ? `Applies next cycle (current: ${snapshot.bulbCount})` : 'Bulb count'}
      >
        {BULB_COUNT_OPTIONS.map((count) => (
          <button key={count} className={`chip-btn ${count === bulbCount ? 'active' : ''}`} onClick={() => setBulbCount(count)}>
            {count}
          </button>
        ))}
      </div>
    </div>
  );
}
