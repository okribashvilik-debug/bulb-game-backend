import { useEffect, useRef } from 'react';
import { useGame } from '../GameContext';
import { useCountdown } from '../useCountdown';
import { sfxManager } from '../sfx'; // sfxFor dispatcher + the selection tick
import { computeStage, type LampState } from '../stage';
import { BulbTile } from './BulbTile';
import { Confetti } from './Confetti';
import { RoomLighting } from './RoomLighting';

const STATE_LABEL: Record<string, string> = {
  idle: 'Starting up…',
  betting: 'Betting open',
  calculating: 'Betting closed — calculating odds…',
  round_active: 'Round in progress',
  decision_window: 'Decide: cash out or continue',
  cycle_complete: 'Cycle complete',
  cycle_cancelled: 'Round cancelled — refunding stakes',
};

/**
 * The main event stage: bulbs hanging from cords in a dark show room whose
 * lighting reacts to them in real time (design_handoff_main_event_area).
 *
 * Everything on stage derives from one model — computeStage(snapshot,
 * popTransition) — consumed three ways:
 *   RoomLighting  — the reactive room, rendered behind the bulbs
 *   BulbTile      — each hanging bulb, rendered on top
 *   sfx dispatcher — the effect below feeds every per-bulb state
 *                    TRANSITION to sfxManager.sfxFor(), the same contract
 *                    the visuals run on, so sound and light stay in step.
 */
export function MainEventArea() {
  const { snapshot, myPlayerId, popTransition, winPulse, cancelledNotice, selectedBulbId, setSelectedBulbId } =
    useGame();
  const { remainingMs, progress } = useCountdown(snapshot.phaseDeadlineAt, snapshot.phaseDurationMs);

  const stage = computeStage(snapshot, popTransition);

  const myBulbId =
    snapshot.players.find(
      (p) => p.id === myPlayerId && (p.status === 'active' || p.status === 'won'),
    )?.bulbId ?? null;

  // Bulbs are directly clickable to pick one — same selectedBulbId the
  // ControlPanel chips drive, so the two selection surfaces always agree.
  // Same eligibility rule as the chips: betting open, no bet placed yet.
  const alreadyBet = snapshot.players.some((p) => p.id === myPlayerId);
  const canSelect = snapshot.state === 'betting' && !alreadyBet;

  const selectBulb = (bulbId: string) => {
    sfxManager.playClick(); // the handoff's selection tick
    setSelectedBulbId(selectedBulbId === bulbId ? null : bulbId); // click again to deselect
  };

  // SFX: fire the dispatcher once per actual state change, per bulb. Keyed
  // by bulb id (not array index) so a mode switch mid-listen can't hand one
  // bulb's loop to another; the numeric index sfx.ts keys its loop map by
  // comes from the bulb's own number.
  const prevStatesRef = useRef<Map<string, LampState>>(new Map());
  useEffect(() => {
    const prevStates = prevStatesRef.current;
    const nextStates = new Map<string, LampState>();
    for (const bulb of stage) {
      nextStates.set(bulb.id, bulb.state);
      sfxManager.sfxFor(bulb.num - 1, bulb.state, prevStates.get(bulb.id));
    }
    // Bulbs that vanished entirely (mode switch) must not leave loops behind.
    for (const [id] of prevStates) {
      if (!nextStates.has(id)) sfxManager.stopAllLoops();
    }
    prevStatesRef.current = nextStates;
  });

  const roundLabel =
    snapshot.state === 'idle' || snapshot.currentRound === 0
      ? null
      : `Round ${snapshot.currentRound}/${snapshot.totalRounds}`;

  return (
    <div className="main-event stage">
      <RoomLighting bulbs={stage} />

      <div className="stage-bulbs">
        {stage.map((bulb) => (
          <BulbTile
            key={bulb.id}
            bulb={bulb}
            isMine={bulb.id === myBulbId}
            selected={selectedBulbId === bulb.id}
            selectable={canSelect && bulb.state !== 'popped'}
            onSelect={() => selectBulb(bulb.id)}
          />
        ))}
      </div>

      <div className="stage-caption">
        <span className="stage-caption__title">Main event</span>
        <span>{STATE_LABEL[snapshot.state]}</span>
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

      {winPulse && <Confetti token={winPulse.token} />}
    </div>
  );
}
