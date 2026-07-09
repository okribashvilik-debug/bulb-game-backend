/**
 * The single hook that wires the whole UI to the server-authoritative
 * backend over WebSocket (see server/ws/protocol.ts for the message
 * contract this mirrors). The client has NO local game logic — every
 * piece of state here is either a message straight off the socket, or a
 * capped, client-side history log built by listening to those messages.
 * This intentionally replaces an earlier version that ran its own local
 * BulbGameEngine + a BotSimulator for fake players — that was a
 * standalone demo built before this backend existed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { detectNearMissBulbId } from './nearMiss';
import { soundManager } from './sound';
import type { Bulb, BulbCount, CycleSnapshot, Player } from '../types';

const PLAYER_ID_STORAGE_KEY = 'bulbgame:playerId';
const STARTING_BULB_COUNT: BulbCount = 5;
const OUTCOME_HISTORY_LIMIT = 30;
const BETS_FEED_LIMIT = 60;
const RESOLVED_BETS_LIMIT = 500;
const JUST_POPPED_DURATION_MS = 750;
const NEAR_MISS_DURATION_MS = 2200;
const WIN_PULSE_DURATION_MS = 2600;
const WIN_SOUND_DELAY_MS = 150; // let the final round's pop sound resolve first
const RECONNECT_DELAY_MS = 2000;

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

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface UseBulbGameResult {
  snapshot: CycleSnapshot;
  myPlayerId: string | null;
  connectionStatus: ConnectionStatus;
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

// ---------------------------------------------------------------------
// Wire protocol — client-side view of server/ws/protocol.ts. Kept as a
// separate, narrower copy rather than importing across the src/ui <->
// server boundary, since the two are deployed and typechecked as
// deliberately separate layers (see context.md).
// ---------------------------------------------------------------------

type ClientMessage =
  | { type: 'join'; mode: BulbCount; playerId?: string }
  | { type: 'placeBet'; bulbId: string; stake: number }
  | { type: 'cashOut' }
  | { type: 'continue' };

interface LiveBetRow {
  id: string;
  cycle_id: string | null;
  mode: BulbCount;
  player_id: string | null;
  display_name: string;
  bulb_id: string;
  stake: number;
  payout: number | null;
  event_type: 'bet_placed' | 'won' | 'cashed_out' | 'popped';
  created_at: string;
}

type ServerMessage =
  | { type: 'welcome'; playerId: string; displayName: string; balance: number }
  | { type: 'snapshot'; mode: BulbCount; snapshot: CycleSnapshot; serverTime: number; yourBetId?: string }
  | { type: 'event'; mode: BulbCount; event: string; payload: unknown; serverTime: number }
  | { type: 'balance'; balance: number }
  | { type: 'liveBets'; mode: BulbCount; entries: LiveBetRow[] }
  | { type: 'leaderboard'; window: string; entries: unknown[] }
  | { type: 'actionError'; action: string; message: string }
  | { type: 'error'; message: string };

/** Same-origin in production (the backend serves the built client itself —
 *  see server/index.ts). In local dev, Vite's own dev server (port 5173)
 *  only serves the client, so the backend's separate local port is used
 *  instead. */
function resolveWsUrl(): string {
  const { protocol, hostname, port, host } = window.location;
  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
  if ((hostname === 'localhost' || hostname === '127.0.0.1') && port !== '8787') {
    return `${wsProtocol}//${hostname}:8787/ws`;
  }
  return `${wsProtocol}//${host}/ws`;
}

const EMPTY_SNAPSHOT: CycleSnapshot = {
  cycleId: '',
  state: 'idle',
  bulbCount: STARTING_BULB_COUNT,
  timings: { bettingWindowMs: 10_000, roundDurationMs: 5_000, decisionWindowMs: 5_000 },
  bulbs: [],
  players: [],
  currentRound: 0,
  totalRounds: 0,
  fixedCoefficients: {},
  liveCoefficients: {},
};

export function useBulbGame(): UseBulbGameResult {
  const [bulbCount, setBulbCountState] = useState<BulbCount>(STARTING_BULB_COUNT);
  const bulbCountRef = useRef(bulbCount);

  const [snapshot, setSnapshot] = useState<CycleSnapshot>(EMPTY_SNAPSHOT);
  const snapshotRef = useRef(snapshot);

  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);
  const myPlayerIdRef = useRef<string | null>(null);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [balance, setBalance] = useState(0);
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

  const wsRef = useRef<WebSocket | null>(null);
  const seededLiveBetsRef = useRef(false);
  const aliveBulbIdsRef = useRef<string[]>([]);

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

  const setBulbCount = useCallback((count: BulbCount) => {
    bulbCountRef.current = count;
    setBulbCountState(count);
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      const message: ClientMessage = { type: 'join', mode: count, playerId: myPlayerIdRef.current ?? undefined };
      socket.send(JSON.stringify(message));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let justPoppedTimer: ReturnType<typeof setTimeout> | undefined;
    let nearMissTimer: ReturnType<typeof setTimeout> | undefined;
    let winPulseTimer: ReturnType<typeof setTimeout> | undefined;
    let winSoundTimer: ReturnType<typeof setTimeout> | undefined;

    function handleGameEvent(event: string, payload: unknown): void {
      const cycleId = snapshotRef.current.cycleId;
      const myId = myPlayerIdRef.current;

      switch (event) {
        case 'betPlaced': {
          const { player } = payload as { player: Player };
          const isHuman = player.id === myId;
          if (isHuman) setBalance((b) => b - player.stake);
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
          break;
        }

        case 'bulbPopped': {
          const { bulb, round, affectedPlayers } = payload as {
            bulb: Bulb;
            round: number;
            affectedPlayers: Player[];
          };
          const isHumanLoss = affectedPlayers.some((p) => p.id === myId);

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

          clearTimeout(justPoppedTimer);
          setJustPopped({ token: nextTransientToken(), bulbId: bulb.id, kind: isHumanLoss ? 'human-loss' : 'neutral' });
          justPoppedTimer = setTimeout(() => setJustPopped(null), JUST_POPPED_DURATION_MS);

          if (isHumanLoss) {
            soundManager.playPopLoss();
          } else {
            soundManager.playPopNeutral();
          }

          // The 'snapshot' broadcast for this pop hasn't arrived yet (the
          // engine emits 'bulbPopped' before its next stateChange) — derive
          // the post-pop survivor list from the last known alive set instead
          // of waiting for it.
          const survivorIds = aliveBulbIdsRef.current.filter((id) => id !== bulb.id);
          aliveBulbIdsRef.current = survivorIds;
          const nearMissId = detectNearMissBulbId(bulb.id, survivorIds, snapshotRef.current.fixedCoefficients);
          if (nearMissId) {
            clearTimeout(nearMissTimer);
            setNearMiss({ token: nextTransientToken(), bulbId: nearMissId });
            nearMissTimer = setTimeout(() => setNearMiss(null), NEAR_MISS_DURATION_MS);
            soundManager.playNearMiss();
          }
          break;
        }

        case 'playerCashedOut': {
          const { player } = payload as { player: Player };
          if (player.id === myId) {
            setBalance((b) => b + (player.result?.value ?? 0));
            setLastDecidedRound(player.result?.round ?? 0);
            soundManager.playCashOut();
          }
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
          break;
        }

        case 'playerContinued': {
          const { playerId } = payload as { playerId: string };
          if (playerId === myId) setLastDecidedRound(snapshotRef.current.currentRound);
          break;
        }

        case 'cycleComplete': {
          const { winningBulbId, winners } = payload as { winningBulbId: string; winners: Player[] };
          const finalSnapshot = snapshotRef.current;

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
            const humanWon = winners.some((w) => w.id === myId);
            setResolvedBets((bets) => {
              let next = bets;
              for (const winner of winners) {
                if (winner.id === myId) {
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
              // short delay lets the final round's (someone else's) pop
              // sound resolve first instead of colliding with the fanfare.
              clearTimeout(winPulseTimer);
              setWinPulse({ token: nextTransientToken() });
              winPulseTimer = setTimeout(() => setWinPulse(null), WIN_PULSE_DURATION_MS);
              clearTimeout(winSoundTimer);
              winSoundTimer = setTimeout(() => soundManager.playWin(), WIN_SOUND_DELAY_MS);
            }
          }
          break;
        }
      }
    }

    function handleMessage(message: ServerMessage): void {
      switch (message.type) {
        case 'welcome': {
          myPlayerIdRef.current = message.playerId;
          setMyPlayerId(message.playerId);
          localStorage.setItem(PLAYER_ID_STORAGE_KEY, message.playerId);
          setBalance(message.balance);
          break;
        }

        case 'snapshot': {
          snapshotRef.current = message.snapshot;
          aliveBulbIdsRef.current = message.snapshot.bulbs.filter((b) => b.status === 'alive').map((b) => b.id);
          setSnapshot(message.snapshot);
          if (message.snapshot.bulbCount !== bulbCountRef.current) {
            bulbCountRef.current = message.snapshot.bulbCount;
            setBulbCountState(message.snapshot.bulbCount);
          }
          break;
        }

        case 'balance': {
          setBalance(message.balance);
          break;
        }

        case 'liveBets': {
          // Only seeds once (first join) — a mode switch's fresh liveBets
          // fetch would otherwise clobber history already built up live
          // from events during this session.
          if (seededLiveBetsRef.current) break;
          seededLiveBetsRef.current = true;
          const myId = myPlayerIdRef.current;
          const placed = message.entries.filter((e) => e.event_type === 'bet_placed');
          const resolved = message.entries.filter((e) => e.event_type !== 'bet_placed');

          setBetsFeed((feed) =>
            feed.length > 0
              ? feed
              : placed.map((e) => ({
                  id: e.id,
                  cycleId: e.cycle_id ?? 'unknown',
                  playerId: e.player_id ?? e.display_name,
                  bulbId: e.bulb_id,
                  stake: e.stake,
                  timestamp: Date.parse(e.created_at),
                  isHuman: e.player_id === myId,
                })),
          );
          setResolvedBets((bets) =>
            bets.length > 0
              ? bets
              : resolved.map((e) => ({
                  id: e.id,
                  cycleId: e.cycle_id ?? 'unknown',
                  round: 0,
                  playerId: e.player_id ?? e.display_name,
                  bulbId: e.bulb_id,
                  stake: e.stake,
                  outcome: e.event_type as ResolvedOutcome,
                  value: e.payout ?? 0,
                  timestamp: Date.parse(e.created_at),
                })),
          );
          break;
        }

        case 'event': {
          handleGameEvent(message.event, message.payload);
          break;
        }

        case 'actionError':
          console.warn(`[bulb-game] action "${message.action}" failed: ${message.message}`);
          break;

        case 'error':
          console.warn(`[bulb-game] server error: ${message.message}`);
          break;
      }
    }

    function connect(): void {
      if (cancelled) return;
      setConnectionStatus('connecting');
      const socket = new WebSocket(resolveWsUrl());
      wsRef.current = socket;

      socket.addEventListener('open', () => {
        if (cancelled) return;
        setConnectionStatus('open');
        const storedPlayerId = myPlayerIdRef.current ?? localStorage.getItem(PLAYER_ID_STORAGE_KEY) ?? undefined;
        const message: ClientMessage = { type: 'join', mode: bulbCountRef.current, playerId: storedPlayerId };
        socket.send(JSON.stringify(message));
      });

      socket.addEventListener('message', (rawEvent) => {
        if (cancelled) return;
        try {
          handleMessage(JSON.parse(rawEvent.data as string) as ServerMessage);
        } catch {
          // Malformed frame — ignore, the connection itself is still fine.
        }
      });

      socket.addEventListener('close', () => {
        if (cancelled) return;
        setConnectionStatus('closed');
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      });

      socket.addEventListener('error', () => {
        socket.close();
      });
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      clearTimeout(justPoppedTimer);
      clearTimeout(nearMissTimer);
      clearTimeout(winPulseTimer);
      clearTimeout(winSoundTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  const placeBet = useCallback(() => {
    if (!selectedBulbId || stake <= 0 || stake > balance) return;
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const message: ClientMessage = { type: 'placeBet', bulbId: selectedBulbId, stake };
    socket.send(JSON.stringify(message));
  }, [selectedBulbId, stake, balance]);

  const cashOut = useCallback(() => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const message: ClientMessage = { type: 'cashOut' };
    socket.send(JSON.stringify(message));
  }, []);

  const continuePlaying = useCallback(() => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const message: ClientMessage = { type: 'continue' };
    socket.send(JSON.stringify(message));
  }, []);

  const humanPlayer = snapshot.players.find((p) => p.id === myPlayerId);
  const isDecisionPending =
    snapshot.state === 'decision_window' &&
    humanPlayer?.status === 'active' &&
    lastDecidedRound !== snapshot.currentRound;

  return {
    snapshot,
    myPlayerId,
    connectionStatus,
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
