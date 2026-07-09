/**
 * WebSocket message envelope, both directions. A single connection joins
 * exactly one bulb-count mode at a time (via `join`); switching modes just
 * sends another `join` with a different mode. Every message is a single
 * JSON object with a `type` discriminant.
 *
 * Server -> client messages are the ONLY way client-visible state changes
 * — the client has no local game logic, it only renders what it's sent
 * (see requirement 1). In particular, `snapshot`/`event` payloads come
 * straight from BulbGameEngine's own public CycleSnapshot/BulbGameEvents
 * types (see src/types.ts, src/events.ts) — never from
 * getAuditRecord(), which is server/persistence-only and would leak the
 * future elimination order if it were ever forwarded here.
 */
import type { BulbCount, BulbGameEvents, CycleSnapshot } from '../../src/index';
import type { LeaderboardRow, LiveBetRow } from '../db/types';
import type { LeaderboardWindow } from '../db/leaderboardRepo';

export type ClientMessage =
  | { type: 'join'; mode: BulbCount; playerId?: string }
  | { type: 'placeBet'; bulbId: string; stake: number }
  | { type: 'cashOut' }
  | { type: 'continue' }
  | { type: 'requestLeaderboard'; window: LeaderboardWindow };

export interface EventEnvelope<K extends keyof BulbGameEvents = keyof BulbGameEvents> {
  mode: BulbCount;
  event: K;
  payload: BulbGameEvents[K];
  serverTime: number;
}

export type ServerMessage =
  | { type: 'welcome'; playerId: string; displayName: string; balance: number }
  | { type: 'snapshot'; mode: BulbCount; snapshot: CycleSnapshot; serverTime: number; yourBetId?: string }
  | { type: 'event'; mode: BulbCount; event: keyof BulbGameEvents; payload: unknown; serverTime: number }
  | { type: 'balance'; balance: number }
  | { type: 'liveBets'; mode: BulbCount; entries: LiveBetRow[] }
  | { type: 'leaderboard'; window: LeaderboardWindow; entries: LeaderboardRow[] }
  | { type: 'actionError'; action: string; message: string }
  | { type: 'error'; message: string };

export function isClientMessage(value: unknown): value is ClientMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}
