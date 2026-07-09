/**
 * Headless demo: runs one full Bulb Game cycle end-to-end and logs every
 * state transition. No UI — this just proves the state machine works.
 *
 * Run with: npm run simulate
 *
 * Uses a compressed clock so the demo finishes in ~1s instead of the real
 * ~40-90s a cycle would take; the engine itself is unaware of the
 * compression, it just asks the injected Clock for timeouts.
 */
import { BulbGameEngine, type Clock, type TimerHandle } from '../src/index';

const COMPRESSION_FACTOR = 40; // 1s of "game time" -> 25ms of real time

const fastClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms / COMPRESSION_FACTOR),
  clearTimeout: (handle: TimerHandle) => clearTimeout(handle),
};

const engine = new BulbGameEngine({ clock: fastClock });

engine.on('stateChange', ({ snapshot }) => {
  console.log(`[state] -> ${snapshot.state} (round ${snapshot.currentRound}/${snapshot.totalRounds})`);
});

engine.on('betPlaced', ({ player }) => {
  console.log(`[bet]   ${player.id} staked ${player.stake} on ${player.bulbId}`);
});

engine.on('calculatingStarted', () => {
  console.log('[calc]  betting closed, stakes locked — computing odds…');
});

engine.on('cycleCancelled', ({ refundedPlayers }) => {
  const names = refundedPlayers.map((p) => p.id).join(', ') || '(nobody)';
  console.log(`[cancel] uncontested round — refunded in full: ${names}`);
});

engine.on('bulbPopped', ({ bulb, round, affectedPlayers }) => {
  const names = affectedPlayers.map((p) => p.id).join(', ') || '(no players on it)';
  console.log(`[pop]   round ${round}: ${bulb.id} popped — affected: ${names}`);
});

engine.on('playerCashedOut', ({ player }) => {
  console.log(`[cash]  ${player.id} cashed out for ${player.result?.value}`);
});

engine.on('cycleComplete', ({ winningBulbId, winners }) => {
  const names = winners.map((p) => `${p.id} (+${p.result?.value})`).join(', ') || '(no bets on winning bulb)';
  console.log(`[done]  winning bulb: ${winningBulbId} — winners: ${names}`);
});

// --- Kick off a 5-bulb cycle -------------------------------------------------
engine.startCycle(5);

engine.placeBet('alice', 'bulb_1', 10);
engine.placeBet('bob', 'bulb_2', 25);
engine.placeBet('carol', 'bulb_3', 5);

// Simulate players reacting during each decision window: whoever is still
// active, on a short random delay, either cashes out or continues.
engine.on('decisionWindowStarted', ({ eligiblePlayerIds }) => {
  for (const playerId of eligiblePlayerIds) {
    const thinkingMs = Math.random() * 100; // well inside the compressed window
    setTimeout(() => {
      if (engine.getState() !== 'decision_window') return; // window already moved on
      if (Math.random() < 0.3) {
        try {
          engine.cashOut(playerId);
        } catch {
          /* window may have just closed — safe to ignore in this demo */
        }
      } else {
        try {
          engine.continuePlaying(playerId);
        } catch {
          /* same as above */
        }
      }
    }, thinkingMs);
  }
});

setTimeout(() => {
  console.log('\nFinal snapshot:', JSON.stringify(engine.getSnapshot(), null, 2));
}, 5000);
