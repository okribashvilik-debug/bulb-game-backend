/**
 * Per-connection message routing. A connection joins exactly one mode at
 * a time; all the actual game logic lives in GameSession — this file only
 * parses/validates incoming messages, resolves player identity, and calls
 * through.
 */
import type { WebSocket } from 'ws';
import type { BulbCount } from '../../src/index';
import { fetchLeaderboard } from '../db/leaderboardRepo';
import { fetchRecentLiveBets } from '../db/liveBetsRepo';
import { getOrCreatePlayer } from '../db/playersRepo';
import type { SessionManager } from '../game/sessionManager';
import { isClientMessage, type ServerMessage } from './protocol';

const ALLOWED_MODES: BulbCount[] = [5, 7, 10];

interface ConnectionState {
  playerId: string | null;
  displayName: string | null;
  mode: BulbCount | null;
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

export function handleConnection(socket: WebSocket, sessionManager: SessionManager): void {
  const state: ConnectionState = { playerId: null, displayName: null, mode: null };

  socket.on('message', (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: 'error', message: 'Malformed message — expected JSON.' });
      return;
    }
    if (!isClientMessage(parsed)) {
      send(socket, { type: 'error', message: 'Malformed message — missing "type".' });
      return;
    }

    switch (parsed.type) {
      case 'join':
        void handleJoin(parsed.mode, parsed.playerId);
        return;
      case 'placeBet':
        void handlePlaceBet(parsed.bulbId, parsed.stake);
        return;
      case 'cashOut':
        handleCashOut();
        return;
      case 'continue':
        handleContinue();
        return;
      case 'requestLeaderboard':
        void handleLeaderboard(parsed.window);
        return;
      default:
        send(socket, { type: 'error', message: `Unknown message type.` });
    }
  });

  socket.on('close', () => {
    if (state.mode && state.playerId) {
      sessionManager.get(state.mode).unsubscribe(socket, state.playerId);
    }
  });

  socket.on('error', (err) => {
    console.error('[ws connection] socket error:', err);
  });

  // ---------------------------------------------------------------------

  async function handleJoin(mode: BulbCount, requestedPlayerId?: string): Promise<void> {
    if (!ALLOWED_MODES.includes(mode)) {
      send(socket, { type: 'error', message: `Invalid mode "${mode}" — must be 5, 7, or 10.` });
      return;
    }

    let player;
    try {
      player = await getOrCreatePlayer(requestedPlayerId);
    } catch (err) {
      console.error('[ws connection] getOrCreatePlayer failed:', err);
      send(socket, { type: 'error', message: 'Could not establish your session — please retry.' });
      return;
    }

    // Switching modes on an already-joined connection: leave the old
    // session's subscriber lists before joining the new one.
    if (state.mode && state.mode !== mode && state.playerId) {
      sessionManager.get(state.mode).unsubscribe(socket, state.playerId);
    }

    state.playerId = player.id;
    state.displayName = player.display_name;
    state.mode = mode;

    const session = sessionManager.get(mode);
    session.subscribe(socket, player.id);

    send(socket, { type: 'welcome', playerId: player.id, displayName: player.display_name, balance: Number(player.balance) });

    const snapshot = session.getSnapshot();
    const yourBetId = session.getBetDbId(player.id);
    send(socket, { type: 'snapshot', mode, snapshot, serverTime: Date.now(), ...(yourBetId ? { yourBetId } : {}) });

    try {
      const entries = await fetchRecentLiveBets(mode, 50);
      send(socket, { type: 'liveBets', mode, entries });
    } catch (err) {
      console.error('[ws connection] fetchRecentLiveBets failed:', err);
      // Non-fatal — the live game state already went out above; the feed
      // can arrive late or not at all without blocking play.
    }
  }

  async function handlePlaceBet(bulbId: string, stake: number): Promise<void> {
    if (!state.mode || !state.playerId || !state.displayName) {
      send(socket, { type: 'actionError', action: 'placeBet', message: 'Join a mode before placing a bet.' });
      return;
    }
    const result = await sessionManager.get(state.mode).placeBet(state.playerId, state.displayName, bulbId, stake);
    if (!result.ok) {
      send(socket, { type: 'actionError', action: 'placeBet', message: result.error });
    }
  }

  function handleCashOut(): void {
    if (!state.mode || !state.playerId) {
      send(socket, { type: 'actionError', action: 'cashOut', message: 'Join a mode first.' });
      return;
    }
    const result = sessionManager.get(state.mode).cashOut(state.playerId);
    if (!result.ok) {
      send(socket, { type: 'actionError', action: 'cashOut', message: result.error });
    }
  }

  function handleContinue(): void {
    if (!state.mode || !state.playerId) {
      send(socket, { type: 'actionError', action: 'continue', message: 'Join a mode first.' });
      return;
    }
    const result = sessionManager.get(state.mode).continuePlaying(state.playerId);
    if (!result.ok) {
      send(socket, { type: 'actionError', action: 'continue', message: result.error });
    }
  }

  async function handleLeaderboard(window: 'day' | 'week' | 'month'): Promise<void> {
    try {
      const entries = await fetchLeaderboard(window);
      send(socket, { type: 'leaderboard', window, entries });
    } catch (err) {
      console.error('[ws connection] fetchLeaderboard failed:', err);
      send(socket, { type: 'error', message: 'Could not load leaderboard — please retry.' });
    }
  }
}
