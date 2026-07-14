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

  // SFX: one-shots fire on per-bulb transitions; the charging/overcharge
  // loops are driven by the AGGREGATE stage phase through one exclusive
  // channel in sfx.ts, so only one of charging / overcharge / pop is ever
  // audible at a time — no per-bulb loop stacking, no bleed across the
  // charging → overcharge → pop handoffs. playPop() runs BEFORE
  // setStagePhase() so its quiet-hold is in place when the phase applies.
  const prevStatesRef = useRef<Map<string, LampState>>(new Map());
  useEffect(() => {
    const prevStates = prevStatesRef.current;
    const nextStates = new Map<string, LampState>();
    let popped = false;
    let won = false;
    let poweredDown = false;
    for (const bulb of stage) {
      nextStates.set(bulb.id, bulb.state);
      const prev = prevStates.get(bulb.id);
      if (prev === bulb.state) continue;
      if (bulb.state === 'popped') popped = true;
      else if (bulb.state === 'win') won = true;
      // Power-down only from a live state — popped bulbs resetting to idle
      // for the next cycle stay silent (and fire at most once per batch).
      else if (bulb.state === 'idle' && prev !== undefined && prev !== 'popped' && prev !== 'idle')
        poweredDown = true;
    }
    if (popped) sfxManager.playPop();
    if (won) sfxManager.playWin();
    if (poweredDown) sfxManager.playIdle();

    const phase = stage.some((b) => b.state === 'overcharge')
      ? 'overcharge'
      : stage.some((b) => b.state === 'charging')
        ? 'charging'
        : 'quiet';
    sfxManager.setStagePhase(phase);

    prevStatesRef.current = nextStates;
  });

  // Nothing is priced before round 1 (liveCoefficients is empty during
  // idle/betting/calculating) — hide the whole label row until then.
  const hasCoefficients = Object.keys(snapshot.liveCoefficients).length > 0;

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
            coefficient={snapshot.liveCoefficients[bulb.id]}
            showCoefficient={hasCoefficients}
            isMine={bulb.id === myBulbId}
            selected={selectedBulbId === bulb.id}
            selectable={canSelect && bulb.state !== 'popped'}
            onSelect={() => selectBulb(bulb.id)}
          />
        ))}
      </div>

      <div className="stage-caption">
        <span className="stage-caption__status">{STATE_LABEL[snapshot.state]}</span>
        {(roundLabel || snapshot.phaseDeadlineAt !== undefined) && (
          <span className="stage-caption__bar-row">
            {snapshot.phaseDeadlineAt !== undefined && (
              <span className="main-event__timer-bar">
                <span style={{ width: `${(1 - progress) * 100}%` }} />
              </span>
            )}
            {roundLabel && <span>{roundLabel}</span>}
          </span>
        )}
        {snapshot.phaseDeadlineAt !== undefined && (
          <span className="stage-caption__timer">{(remainingMs / 1000).toFixed(1)}s</span>
        )}
      </div>
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
