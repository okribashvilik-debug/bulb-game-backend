import { useGame } from '../GameContext';
import { bulbNumber, formatCurrency } from '../format';
import { getBulbColor } from '../palette';
import { sfxManager } from '../sfx';

const QUICK_AMOUNTS = [1, 2, 5, 10] as const;
const STAKE_STEP = 1;

export function ControlPanel() {
  const { snapshot, myPlayerId, balance, selectedBulbId, setSelectedBulbId, stake, setStake, placeBet } = useGame();

  const bettingOpen = snapshot.state === 'betting';
  const humanPlayer = snapshot.players.find((p) => p.id === myPlayerId);
  const alreadyBet = humanPlayer !== undefined;

  const clampStake = (value: number) => Math.max(1, Math.min(Math.floor(balance) || 1, Math.floor(value)));

  const canBet = bettingOpen && !alreadyBet && selectedBulbId !== null && stake > 0 && stake <= balance;

  return (
    <div className="control-panel chrome">
      <div className="balance-display">
        <span className="balance-display__label">Balance</span>
        <span className="balance-display__value">{formatCurrency(balance)}</span>
      </div>

      <div className="stake-control">
        <span className="stake-control__label">Stake</span>
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

      <div className="bulb-picker">
        {snapshot.bulbs.map((bulb) => {
          const color = getBulbColor(bulb.id);
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
            </button>
          );
        })}
      </div>

      <button className="bet-button" disabled={!canBet} onClick={placeBet}>
        {alreadyBet ? 'Bet placed' : `Bet ${formatCurrency(stake)}`}
      </button>

      {alreadyBet && (
        <div className="control-panel__note">
          Your bet: bulb {bulbNumber(humanPlayer.bulbId)} · {formatCurrency(humanPlayer.stake)}
          {humanPlayer.status !== 'active' && ` · ${humanPlayer.status.replace('_', ' ')}`}
        </div>
      )}
      {snapshot.state === 'calculating' && !alreadyBet && (
        <div className="control-panel__note">Betting is closed — calculating odds…</div>
      )}
      {!bettingOpen && snapshot.state !== 'calculating' && !alreadyBet && (
        <div className="control-panel__note">Betting opens again once this cycle ends.</div>
      )}
    </div>
  );
}
