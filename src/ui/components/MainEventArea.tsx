import { useGame } from '../GameContext';
import { useCountdown } from '../useCountdown';
import { BulbTile } from './BulbTile';
import { Confetti } from './Confetti';

const STATE_LABEL: Record<string, string> = {
  idle: 'Starting up…',
  betting: 'Betting open',
  calculating: 'Betting closed — calculating odds…',
  round_active: 'Round in progress',
  decision_window: 'Decide: cash out or continue',
  cycle_complete: 'Cycle complete',
  cycle_cancelled: 'Round cancelled — refunding stakes',
};

function densityClass(bulbCount: number): string {
  if (bulbCount >= 10) return 'bulb-grid--dense';
  if (bulbCount >= 7) return 'bulb-grid--cozy';
  return '';
}

export function MainEventArea() {
  const { snapshot, myPlayerId, justPopped, nearMiss, winPulse, cancelledNotice } = useGame();
  const { remainingMs, progress } = useCountdown(snapshot.phaseDeadlineAt, snapshot.phaseDurationMs);

  const roundLabel =
    snapshot.state === 'idle' || snapshot.currentRound === 0
      ? null
      : `Round ${snapshot.currentRound}/${snapshot.totalRounds}`;

  return (
    <div className="main-event stage">
      <div className="main-event__status">
        <strong>{STATE_LABEL[snapshot.state]}</strong>
        {roundLabel && <span>· {roundLabel}</span>}
        {snapshot.phaseDeadlineAt !== undefined && <span>· {(remainingMs / 1000).toFixed(1)}s</span>}
      </div>
      {snapshot.phaseDeadlineAt !== undefined && (
        <div className="main-event__timer-bar">
          <div style={{ width: `${(1 - progress) * 100}%` }} />
        </div>
      )}
      {cancelledNotice && (
        <div className="main-event__cancelled-notice">
          Round cancelled — nobody else bet against you, so every stake ({cancelledNotice.refundedCount}) was
          refunded in full.
        </div>
      )}
      <div className={`bulb-grid ${densityClass(snapshot.bulbCount)}`}>
        {snapshot.bulbs.map((bulb) => (
          <BulbTile
            key={bulb.id}
            bulb={bulb}
            snapshot={snapshot}
            myPlayerId={myPlayerId}
            justPopped={justPopped}
            nearMiss={nearMiss}
          />
        ))}
      </div>
      {winPulse && <Confetti token={winPulse.token} />}
    </div>
  );
}
