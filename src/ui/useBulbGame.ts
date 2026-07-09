/**
 * The single hook that wires the whole UI to BulbGameEngine + the odds
 * module. Everything the components render is either the engine's own
 * CycleSnapshot, or derived, capped, client-side history logs built by
 * listening to the engine's events (the engine itself only ever knows
 * about the *current* cycle — it resets `players` on every startCycle()).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BulbGameEngine } from '../BulbGameEngine';
import { BotSimulator } from './bots';
import { detectNearMissBulbId } from './nearMiss';
import { soundManager } from './sound';
import type { BulbCount, CycleSnapshot } from '../types';

export const HUMAN_PLAYER_ID = 'you';
const STARTING_BALANCE = 1000;
const AUTO_RESTART_DELAY_MS = 4500;
const OUTCOME_HISTORY_LIMIT = 30;
const BETS_FEED_LIMIT = 60;
const RESOLVED_BETS_LIMIT = 500;
const JUST_POPPED_DURATION_MS = 750;
const NEAR_MISS_DURATION_MS = 2200;
const WIN_PULSE_DURATION_MS = 2600;
const WIN_SOUND_DELAY_MS = 150; // let the final round's pop sound resolve first

export interface OutcomeHistoryEntry {
  cycleId: string;
  bulbId: string;
  bulbNumber: number;
  coefficient: number;
  bulbCount: BulbCount;
  timestamp: number;
}

export interface BetFeedEntry {
  id: string;
  cycleId: string;
  playerId: string;
  bulbId: string;
  stake: number;
  timestamp: number;
  isHuman: boolean;
}

export type ResolvedOutcome = 'won' | 'cashed_out' | 'popped';

export interface ResolvedBet {
  id: string;
  cycleId: string;
  round: number;
  playerId: string;
  bulbId: string;
  stake: number;
  outcome: ResolvedOutcome;
  value: number;
  timestamp: number;
}

function capPrepend<T>(list: T[], entry: T, limit: number): T[] {
  return [entry, ...list].slice(0, limit);
}

let transientTokenCounter = 0;
function nextTransientToken(): number {
  transientTokenCounter += 1;
  return transientTokenCounter;
}

/** A bulb that just popped, for a few hundred ms — drives the dramatic
 *  pop-moment animation. `kind` controls how energetic vs. restrained that
 *  animation and its sound are (never celebratory for a loss). */
export interface JustPopped {
  token: number;
  bulbId: string;
  kind: 'neutral' | 'human-loss';
}

export interface NearMiss {
  token: number;
  bulbId: string;
}

export interface WinPulse {
  token: number;
}

export interface UseBulbGameResult {
  snapshot: CycleSnapshot;
  balance: number;
  bulbCount: BulbCount;
  setBulbCount: (count: BulbCount) => void;
  selectedBulbId: string | null;
  setSelectedBulbId: (id: string | null) => void;
  stake: number;
  setStake: (value: number) => void;
  placeBet: () => void;
  cashOut: () => void;
  continuePlaying: () => void;
  isDecisionPending: boolean;
  outcomeHistory: OutcomeHistoryEntry[];
  betsFeed: BetFeedEntry[];
  resolvedBets: ResolvedBet[];
  justPopped: JustPopped | null;
  nearMiss: NearMiss | null;
  winPulse: WinPulse | null;
  muted: boolean;
  setMuted: (muted: boolean) => void;
}

export function useBulbGame(): UseBulbGameResult {
  const engineRef = useRef<BulbGameEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new BulbGameEngine();
  }
  const engine = engineRef.current;

  const [bulbCount, setBulbCountState] = useState<BulbCount>(5);
  const bulbCountRef = useRef(bulbCount);
  const setBulbCount = useCallback((count: BulbCount) => {
    bulbCountRef.current = count;
    setBulbCountState(count);
  }, []);

  const [snapshot, setSnapshot] = useState<CycleSnapshot>(() => engine.getSnapshot());
  const [balance, setBalance] = useState(STARTING_BALANCE);
  const [selectedBulbId, setSelectedBulbId] = useState<string | null>(null);
  const [stake, setStake] = useState(5);
  const [lastDecidedRound, setLastDecidedRound] = useState(0);

  const [outcomeHistory, setOutcomeHistory] = useState<OutcomeHistoryEntry[]>([]);
  const [betsFeed, setBetsFeed] = useState<BetFeedEntry[]>([]);
  const [resolvedBets, setResolvedBets] = useState<ResolvedBet[]>([]);

  const [justPopped, setJustPopped] = useState<JustPopped | null>(null);
  const [nearMiss, setNearMiss] = useState<NearMiss | null>(null);
  const [winPulse, setWinPulse] = useState<WinPulse | null>(null);
  const [muted, setMutedState] = useState(false);

  const setMuted = useCallback((value: boolean) => {
    soundManager.setMuted(value);
    setMutedState(value);
  }, []);

  // Audio needs a user gesture to start in every browser — grab the very
  // first pointer interaction with the page, whatever it is.
  useEffect(() => {
    const unlock = () => soundManager.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  useEffect(() => {
    const bots = new BotSimulator(engine);
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    let winSoundTimer: ReturnType<typeof setTimeout> | undefined;
    let justPoppedTimer: ReturnType<typeof setTimeout> | undefined;
    let nearMissTimer: ReturnType<typeof setTimeout> | undefined;
    let winPulseTimer: ReturnType<typeof setTimeout> | undefined;

    const unsubscribers = [
      engine.on('stateChange', ({ snapshot }) => setSnapshot(snapshot)),

      engine.on('betPlaced', ({ player }) => {
        const isHuman = player.id === HUMAN_PLAYER_ID;
        if (isHuman) {
          setBalance((b) => b - player.stake);
        }
        const cycleId = engine.getSnapshot().cycleId;
        setBetsFeed((feed) =>
          capPrepend(
            feed,
            {
              id: `${cycleId}:${player.id}`,
              cycleId,
              playerId: player.id,
              bulbId: player.bulbId,
              stake: player.stake,
              timestamp: Date.now(),
              isHuman,
            },
            BETS_FEED_LIMIT,
          ),
        );
      }),

      engine.on('bulbPopped', ({ bulb, round, affectedPlayers }) => {
        const cycleId = engine.getSnapshot().cycleId;
        const isHumanLoss = affectedPlayers.some((p) => p.id === HUMAN_PLAYER_ID);

        if (affectedPlayers.length > 0) {
          setResolvedBets((bets) => {
            let next = bets;
            for (const player of affectedPlayers) {
              next = capPrepend(
                next,
                {
                  id: `${cycleId}:${player.id}:${round}`,
                  cycleId,
                  round,
                  playerId: player.id,
                  bulbId: player.bulbId,
                  stake: player.stake,
                  outcome: 'popped',
                  value: 0,
                  timestamp: Date.now(),
                },
                RESOLVED_BETS_LIMIT,
              );
            }
            return next;
          });
        }

        // Dramatic pop-moment animation is transient by design (see
        // styles.css bulb-tile--just-popped) — never a lingering effect.
        clearTimeout(justPoppedTimer);
        setJustPopped({ token: nextTransientToken(), bulbId: bulb.id, kind: isHumanLoss ? 'human-loss' : 'neutral' });
        justPoppedTimer = setTimeout(() => setJustPopped(null), JUST_POPPED_DURATION_MS);

        if (isHumanLoss) {
          soundManager.playPopLoss(); // deliberately muted — never make a loss feel exciting
        } else {
          soundManager.playPopNeutral();
        }

        // Reserved near-miss cue: only for a survivor that was statistically
        // close to being the one that popped this round, and only sometimes.
        const survivorIds = engine
          .getSnapshot()
          .bulbs.filter((b) => b.status === 'alive')
          .map((b) => b.id);
        const nearMissId = detectNearMissBulbId(bulb.id, survivorIds, engine.getSnapshot().fixedCoefficients);
        if (nearMissId) {
          clearTimeout(nearMissTimer);
          setNearMiss({ token: nextTransientToken(), bulbId: nearMissId });
          nearMissTimer = setTimeout(() => setNearMiss(null), NEAR_MISS_DURATION_MS);
          soundManager.playNearMiss();
        }
      }),

      engine.on('playerCashedOut', ({ player }) => {
        if (player.id === HUMAN_PLAYER_ID) {
          setBalance((b) => b + (player.result?.value ?? 0));
          setLastDecidedRound(player.result?.round ?? 0);
          soundManager.playCashOut(); // distinct from decisionClose, which also fires on the modal itself
        }
        const cycleId = engine.getSnapshot().cycleId;
        setResolvedBets((bets) =>
          capPrepend(
            bets,
            {
              id: `${cycleId}:${player.id}:cashout`,
              cycleId,
              round: player.result?.round ?? 0,
              playerId: player.id,
              bulbId: player.bulbId,
              stake: player.stake,
              outcome: 'cashed_out',
              value: player.result?.value ?? 0,
              timestamp: Date.now(),
            },
            RESOLVED_BETS_LIMIT,
          ),
        );
      }),

      engine.on('playerContinued', ({ playerId }) => {
        if (playerId === HUMAN_PLAYER_ID) {
          setLastDecidedRound(engine.getSnapshot().currentRound);
        }
      }),

      engine.on('cycleComplete', ({ winningBulbId, winners }) => {
        const finalSnapshot = engine.getSnapshot();
        const cycleId = finalSnapshot.cycleId;

        if (winningBulbId) {
          const coefficient = finalSnapshot.fixedCoefficients[winningBulbId];
          setOutcomeHistory((history) =>
            capPrepend(
              history,
              {
                cycleId,
                bulbId: winningBulbId,
                bulbNumber: Number(winningBulbId.split('_')[1]),
                coefficient,
                bulbCount: finalSnapshot.bulbCount,
                timestamp: Date.now(),
              },
              OUTCOME_HISTORY_LIMIT,
            ),
          );
        }

        if (winners.length > 0) {
          const humanWon = winners.some((w) => w.id === HUMAN_PLAYER_ID);
          setResolvedBets((bets) => {
            let next = bets;
            for (const winner of winners) {
              if (winner.id === HUMAN_PLAYER_ID) {
                setBalance((b) => b + (winner.result?.value ?? 0));
              }
              next = capPrepend(
                next,
                {
                  id: `${cycleId}:${winner.id}:win`,
                  cycleId,
                  round: winner.result?.round ?? 0,
                  playerId: winner.id,
                  bulbId: winner.bulbId,
                  stake: winner.stake,
                  outcome: 'won',
                  value: winner.result?.value ?? 0,
                  timestamp: Date.now(),
                },
                RESOLVED_BETS_LIMIT,
              );
            }
            return next;
          });

          if (humanWon) {
            // Energetic and celebratory — the one case that earns it. A
            // short delay lets the final round's (someone else's) pop sound
            // resolve first instead of colliding with the fanfare.
            clearTimeout(winPulseTimer);
            setWinPulse({ token: nextTransientToken() });
            winPulseTimer = setTimeout(() => setWinPulse(null), WIN_PULSE_DURATION_MS);
            clearTimeout(winSoundTimer);
            winSoundTimer = setTimeout(() => soundManager.playWin(), WIN_SOUND_DELAY_MS);
          }
        }

        restartTimer = setTimeout(() => {
          if (engine.getState() === 'cycle_complete') {
            engine.startCycle(bulbCountRef.current);
          }
        }, AUTO_RESTART_DELAY_MS);
      }),
    ];

    engine.startCycle(bulbCountRef.current);

    return () => {
      clearTimeout(restartTimer);
      clearTimeout(winSoundTimer);
      clearTimeout(justPoppedTimer);
      clearTimeout(nearMissTimer);
      clearTimeout(winPulseTimer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      bots.dispose();
      engine.stop();
    };
    // Engine + bots are singletons for the component's lifetime; bulbCount
    // changes are read via the ref at restart time, not re-run here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  const placeBet = useCallback(() => {
    if (!selectedBulbId || stake <= 0 || stake > balance) return;
    try {
      engine.placeBet(HUMAN_PLAYER_ID, selectedBulbId, stake);
    } catch {
      // Betting window may have just closed — ignore, button will disable.
    }
  }, [engine, selectedBulbId, stake, balance]);

  const cashOut = useCallback(() => {
    try {
      engine.cashOut(HUMAN_PLAYER_ID);
    } catch {
      // Window may have just ended.
    }
  }, [engine]);

  const continuePlaying = useCallback(() => {
    try {
      engine.continuePlaying(HUMAN_PLAYER_ID);
    } catch {
      // Window may have just ended.
    }
  }, [engine]);

  const humanPlayer = snapshot.players.find((p) => p.id === HUMAN_PLAYER_ID);
  const isDecisionPending =
    snapshot.state === 'decision_window' &&
    humanPlayer?.status === 'active' &&
    lastDecidedRound !== snapshot.currentRound;

  return {
    snapshot,
    balance,
    bulbCount,
    setBulbCount,
    selectedBulbId,
    setSelectedBulbId,
    stake,
    setStake,
    placeBet,
    cashOut,
    continuePlaying,
    isDecisionPending,
    outcomeHistory,
    betsFeed,
    resolvedBets,
    justPopped,
    nearMiss,
    winPulse,
    muted,
    setMuted,
  };
}
