import { useEffect, useRef } from 'react';
import { useGame } from '../GameContext';
import { useCountdown } from '../useCountdown';
import { bulbNumber, formatCoefficient, formatCurrency } from '../format';
import { soundManager } from '../sound';

export function DecisionModal() {
  const { snapshot, myPlayerId, isDecisionPending, cashOut, continuePlaying } = useGame();
  const { remainingMs, progress } = useCountdown(snapshot.phaseDeadlineAt, snapshot.phaseDurationMs);

  // Distinct open/close cues for the decision window itself, separate from
  // win/loss/cash-out sounds. Tracked via a ref (not derived) so it fires
  // exactly once per transition regardless of render count.
  const wasPendingRef = useRef(false);
  useEffect(() => {
    if (isDecisionPending && !wasPendingRef.current) {
      soundManager.playDecisionOpen();
    } else if (!isDecisionPending && wasPendingRef.current) {
      soundManager.playDecisionClose();
    }
    wasPendingRef.current = isDecisionPending;
  }, [isDecisionPending]);

  if (!isDecisionPending) return null;

  const humanPlayer = snapshot.players.find((p) => p.id === myPlayerId);
  if (!humanPlayer) return null;

  const coefficient = snapshot.liveCoefficients[humanPlayer.bulbId] ?? 0;
  const cashoutValue = humanPlayer.stake * coefficient;

  return (
    <div className="decision-modal" role="dialog" aria-label="Cash out or continue">
      <div className="decision-modal__header">
        <span className="decision-modal__title">Bulb {bulbNumber(humanPlayer.bulbId)} survived!</span>
        <span className="decision-modal__countdown">{(remainingMs / 1000).toFixed(1)}s</span>
      </div>
      <div className="decision-modal__bar">
        <div style={{ width: `${(1 - progress) * 100}%` }} />
      </div>
      <div className="decision-modal__value">
        <div className="amount">{formatCurrency(cashoutValue)}</div>
        <div className="coeff">at {formatCoefficient(coefficient)} right now</div>
      </div>
      <div className="decision-modal__actions">
        <button className="decision-modal__cashout" onClick={cashOut}>
          Cash Out {formatCurrency(cashoutValue)}
        </button>
        <button className="decision-modal__continue" onClick={continuePlaying}>
          Continue
        </button>
      </div>
    </div>
  );
}
