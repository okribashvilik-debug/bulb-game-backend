import type { Bulb, CycleSnapshot } from '../../types';
import { bulbNumber, formatCoefficient } from '../format';
import { getBulbColor } from '../palette';
import type { JustPopped, NearMiss } from '../useBulbGame';
import { PopBurst } from './PopBurst';

interface BulbTileProps {
  bulb: Bulb;
  snapshot: CycleSnapshot;
  myPlayerId: string | null;
  justPopped: JustPopped | null;
  nearMiss: NearMiss | null;
}

export function BulbTile({ bulb, snapshot, myPlayerId, justPopped, nearMiss }: BulbTileProps) {
  const isPopped = bulb.status === 'popped';
  const isCharging = !isPopped && snapshot.state === 'round_active';
  const visualState = isPopped ? 'popped' : isCharging ? 'charging' : 'alive';

  const isMine = snapshot.players.some(
    (p) => p.id === myPlayerId && p.bulbId === bulb.id && (p.status === 'active' || p.status === 'won'),
  );
  const isWinner = snapshot.state === 'cycle_complete' && snapshot.winningBulbId === bulb.id;
  const humanWon = isWinner && snapshot.players.some((p) => p.id === myPlayerId && p.status === 'won');

  const isJustPopped = justPopped?.bulbId === bulb.id;
  const isNearMiss = nearMiss?.bulbId === bulb.id;

  const coefficient = isPopped ? undefined : snapshot.liveCoefficients[bulb.id] ?? snapshot.fixedCoefficients[bulb.id];
  const bulbColor = getBulbColor(bulb.id);

  const classes = [
    'bulb-tile',
    `bulb-tile--${visualState}`,
    isMine && 'bulb-tile--mine',
    isWinner && 'bulb-tile--winner',
    humanWon && 'bulb-tile--human-win',
    isJustPopped && `bulb-tile--just-popped-${justPopped!.kind}`,
    isNearMiss && 'bulb-tile--near-miss',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} style={{ '--bulb-color': bulbColor } as React.CSSProperties}>
      <div className="bulb-tile__orb">
        {isJustPopped && justPopped!.kind === 'neutral' && <PopBurst color={bulbColor} token={justPopped!.token} />}
        <span className="bulb-tile__number">{bulbNumber(bulb.id)}</span>
      </div>
      <div className="bulb-tile__coeff">{coefficient !== undefined ? formatCoefficient(coefficient) : '—'}</div>
      <div className="bulb-tile__label">{isWinner ? 'winner' : isNearMiss ? 'close call' : visualState}</div>
    </div>
  );
}
