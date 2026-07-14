import { useState } from 'react';
import { useGame } from '../GameContext';
import { bulbNumber, formatCoefficient, formatCurrency } from '../format';
import { getBulbColor } from '../palette';
import { sfxManager } from '../sfx';
import { HowToPlayModal } from './HowToPlayModal';
import { PolicyModal } from './PolicyModal';
import type { BulbCount } from '../../types';

const QUICK_AMOUNTS = [1, 2, 5, 10] as const;
const STAKE_STEP = 1;
// Vertical selector, largest on top per the panel design.
const BULB_COUNT_OPTIONS: BulbCount[] = [10, 7, 5];

export function ControlPanel() {
  const {
    snapshot,
    myPlayerId,
    balance,
    selectedBulbId,
    setSelectedBulbId,
    stake,
    setStake,
    placeBet,
    bulbCount,
    setBulbCount,
    muted,
    setMuted,
  } = useGame();
  const [howToPlayOpen, setHowToPlayOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);

  const bettingOpen = snapshot.state === 'betting';
  const humanPlayer = snapshot.players.find((p) => p.id === myPlayerId);
  const alreadyBet = humanPlayer !== undefined;

  const clampStake = (value: number) => Math.max(1, Math.min(Math.floor(balance) || 1, Math.floor(value)));

  const canBet = bettingOpen && !alreadyBet && selectedBulbId !== null && stake > 0 && stake <= balance;

  const pendingChange = bulbCount !== snapshot.bulbCount;
  // Same convention as the stage labels: nothing is priced before round 1,
  // so the chips stay clean during idle/betting/calculating.
  const hasCoefficients = Object.keys(snapshot.liveCoefficients).length > 0;

  return (
    <div className="control-panel chrome">
      {/* .cp-row wrappers are display:contents on desktop (children stay
          direct flex items of the panel, layout unchanged) and become real
          rows in the ≤900px stacked layout — see styles.css. */}
      <div className="cp-row cp-row--money">
      <div className="balance-display">
        <span className="balance-display__label">Balance</span>
        <span className="balance-display__value">{formatCurrency(balance)}</span>
      </div>

      <div className="stake-control">
        <div className="stake-control__row">
          <button
            className="chip-btn stake-control__step"
            disabled={!bettingOpen || alreadyBet}
            onClick={() => setStake(clampStake(stake - STAKE_STEP))}
          >
            −
          </button>
          <input
            className="stake-control__input"
            type="number"
            min={1}
            value={stake}
            disabled={!bettingOpen || alreadyBet}
            onChange={(e) => setStake(clampStake(Number(e.target.value) || 1))}
          />
          <button
            className="chip-btn stake-control__step"
            disabled={!bettingOpen || alreadyBet}
            onClick={() => setStake(clampStake(stake + STAKE_STEP))}
          >
            +
          </button>
        </div>
        <div className="stake-control__quick">
          {QUICK_AMOUNTS.map((amount) => (
            <button
              key={amount}
              className="chip-btn"
              disabled={!bettingOpen || alreadyBet}
              onClick={() => setStake(clampStake(amount))}
            >
              {amount}
            </button>
          ))}
          <button className="chip-btn" disabled={!bettingOpen || alreadyBet} onClick={() => setStake(clampStake(balance))}>
            All In
          </button>
        </div>
      </div>
      </div>

      <div className="bulb-picker">
        {snapshot.bulbs.map((bulb) => {
          const color = getBulbColor(bulb.id);
          const coefficient = snapshot.liveCoefficients[bulb.id];
          const liveCoeff =
            coefficient !== undefined && bulb.status !== 'popped'
              ? formatCoefficient(coefficient)
              : null;
          return (
            <button
              key={bulb.id}
              className={`chip-btn bulb-chip ${selectedBulbId === bulb.id ? 'selected' : ''}`}
              disabled={!bettingOpen || alreadyBet}
              onClick={() => {
                sfxManager.playClick(); // the handoff's bulb-selection tick
                setSelectedBulbId(bulb.id);
              }}
              style={{ '--bulb-color': color } as React.CSSProperties}
            >
              <span className="bulb-chip__swatch" style={{ backgroundColor: color }} />#{bulbNumber(bulb.id)}
              {hasCoefficients && (
                <span className={`bulb-chip__coeff${liveCoeff === null ? ' bulb-chip__coeff--none' : ''}`}>
                  {liveCoeff ?? '—'}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <button className="bet-button" disabled={!canBet} onClick={placeBet}>
        {alreadyBet ? 'Bet placed' : `Bet ${formatCurrency(stake)}`}
      </button>

      <div className="cp-row cp-row--side">
        <div className="panel-utility">
          <button
            className="chip-btn panel-utility__btn"
            onClick={() => setMuted(!muted)}
            aria-label={muted ? 'Unmute sound' : 'Mute sound'}
            title={muted ? 'Unmute sound' : 'Mute sound'}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          <button
            className="chip-btn panel-utility__btn"
            onClick={() => setHowToPlayOpen(true)}
            aria-label="How to play"
            title="How to play"
          >
            ?
          </button>
          <button
            className="chip-btn panel-utility__btn"
            onClick={() => setPolicyOpen(true)}
            aria-label="Game policy and rules"
            title="Game policy and rules"
          >
            ⓘ
          </button>
        </div>

        <div
          className="bulb-count-picker"
          title={pendingChange ? `Applies next cycle (current: ${snapshot.bulbCount})` : 'Bulb count'}
        >
          {BULB_COUNT_OPTIONS.map((count) => (
            <button
              key={count}
              className={`chip-btn ${count === bulbCount ? 'active' : ''}`}
              onClick={() => setBulbCount(count)}
            >
              {count}
            </button>
          ))}
        </div>
      </div>

      {/* Always mounted at a fixed height so the whole bottom bar never
          grows/shrinks when a note appears — only the text toggles.
          ("Calculating odds…" note removed: the stage status already says it.) */}
      <div className="control-panel__note" aria-live="polite">
        {alreadyBet && (
          <>
            Your bet: bulb {bulbNumber(humanPlayer.bulbId)} · {formatCurrency(humanPlayer.stake)}
            {humanPlayer.status !== 'active' && ` · ${humanPlayer.status.replace('_', ' ')}`}
          </>
        )}
      </div>

      <HowToPlayModal open={howToPlayOpen} onClose={() => setHowToPlayOpen(false)} />
      <PolicyModal open={policyOpen} onClose={() => setPolicyOpen(false)} />
    </div>
  );
}
