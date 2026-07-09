import { useEffect, useState } from 'react';
import { useGame } from '../GameContext';
import { useCountdown } from '../useCountdown';
import { BulbTile } from './BulbTile';
import { Confetti } from './Confetti';

const FREEZE_FRAME_MS = 220;

const STATE_LABEL: Record<string, string> = {
  idle: 'Starting up…',
  betting: 'Betting open',
  round_active: 'Round in progress',
  decision_window: 'Decide: cash out or continue',
  cycle_complete: 'Cycle complete',
};

function densityClass(bulbCount: number): string {
  if (bulbCount >= 10) return 'bulb-grid--dense';
  if (bulbCount >= 7) return 'bulb-grid--cozy';
  return '';
}

export function MainEventArea() {
  const { snapshot, justPopped, nearMiss, winPulse } = useGame();
  const { remainingMs, progress } = useCountdown(snapshot.phaseDeadlineAt, snapshot.phaseDurationMs);

  // Reserved near-miss "freeze frame": everything holds still for an
  // instant, on top of the flash on the specific bulb (see BulbTile/CSS).
  const [freeze, setFreeze] = useState(false);
  useEffect(() => {
    if (!nearMiss) return;
    setFreeze(true);
    const timer = setTimeout(() => setFreeze(false), FREEZE_FRAME_MS);
    return () => clearTimeout(timer);
  }, [nearMiss?.token]);

  const roundLabel =
    snapshot.state === 'idle' || snapshot.currentRound === 0
      ? null
      : `Round ${snapshot.currentRound}/${snapshot.totalRounds}`;

  return (
    <div className="main-event stage">
      <div className="main-event__status">
        <strong>{STATE_LABEL[snapshot.state]}</strong>
        {roundLabel && <span>· {roundLabel}</span>}
        {snapshot.shape && <span>· {snapshot.shape.replace('_', ' ')}</span>}
        {snapshot.phaseDeadlineAt !== undefined && <span>· {(remainingMs / 1000).toFixed(1)}s</span>}
      </div>
      {snapshot.phaseDeadlineAt !== undefined && (
        <div className="main-event__timer-bar">
          <div style={{ width: `${(1 - progress) * 100}%` }} />
        </div>
      )}
      <div className={`bulb-grid ${densityClass(snapshot.bulbCount)} ${freeze ? 'bulb-grid--freeze' : ''}`}>
        {snapshot.bulbs.map((bulb) => (
          <BulbTile key={bulb.id} bulb={bulb} snapshot={snapshot} justPopped={justPopped} nearMiss={nearMiss} />
        ))}
      </div>
      {winPulse && <Confetti token={winPulse.token} />}
    </div>
  );
}
