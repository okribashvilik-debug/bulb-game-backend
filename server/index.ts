/**
 * Server entry point. A single HTTP server hosts both the Express app
 * (health check + a couple of read-only REST endpoints) and the
 * WebSocket server (upgraded on the same port, path `/ws`) — this is one
 * process, one port, deployable on Render as a single persistent web
 * service (requirement 6).
 *
 * Run locally:  npm run server:dev   (tsx, auto env from .env)
 * Run on Render: npm start           (same tsx entry point; PORT comes
 *                                      from Render's own env var)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';

import { env } from './env';
import { fetchCycleHistory } from './db/cyclesRepo';
import { fetchLeaderboard, type LeaderboardWindow } from './db/leaderboardRepo';
import type { BulbCount } from '../src/index';
import { SessionManager } from './game/sessionManager';
import { handleConnection } from './ws/connection';
import { startHeartbeat } from './ws/heartbeat';

const app = express();
app.use(express.json());

// Render (and most PaaS platforms) probes this to know the service is up.
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok', uptimeSeconds: process.uptime() });
});

// A small REST fallback alongside the WebSocket `requestLeaderboard`
// message — handy for anything that'd rather poll than hold a socket open
// just to read the leaderboard.
app.get('/api/leaderboard', async (req, res) => {
  const window = String(req.query.window ?? 'day') as LeaderboardWindow;
  if (!['day', 'week', 'month'].includes(window)) {
    res.status(400).json({ error: 'window must be one of: day, week, month' });
    return;
  }
  try {
    const entries = await fetchLeaderboard(window);
    res.status(200).json({ window, entries });
  } catch (err) {
    console.error('[GET /api/leaderboard]', err);
    res.status(502).json({ error: 'Could not load leaderboard.' });
  }
});

// Serves the built React client (see package.json's "build" script) so
// one Render service hosts both the API/WebSocket backend and the game
// itself at a single URL. Guarded by existsSync so `npm run server:dev`
// still works locally even when the client hasn't been built into dist/.
//
// Resolved from the process working directory (the repo root — where both
// `npm run server:dev` and Render's `npm start` launch from) rather than
// `__dirname`: the root package is `"type": "module"`, so the tsx dev path
// runs this file as ESM where `__dirname` is undefined, while the compiled
// prod build is CommonJS where `import.meta.url` isn't available. `cwd` is
// the one anchor valid under both runtimes.
const clientDistPath = path.join(process.cwd(), 'dist');
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path === '/healthz' || req.path === '/ws') {
      next();
      return;
    }
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.status(200).json({ name: 'bulb-game-server', status: 'running', note: 'client build not found — run `npm run build`' });
  });
}

// Outcome history for the Previous Rounds strip: recent COMPLETED cycles
// for a mode, straight from the cycles/live_bets audit trail, so the strip
// survives a page refresh instead of resetting to empty. Read-only,
// additive — live websocket events still prepend in real time on top of
// this boot-time seed (see useBulbGame.ts).
app.get('/api/history', async (req, res) => {
  const mode = Number(req.query.mode ?? 5);
  if (![5, 7, 10].includes(mode)) {
    res.status(400).json({ error: 'mode must be one of: 5, 7, 10' });
    return;
  }
  const limit = Math.min(Math.max(Number(req.query.limit ?? 30) || 30, 1), 100);
  try {
    const entries = await fetchCycleHistory(mode as BulbCount, limit);
    res.status(200).json({ mode, entries });
  } catch (err) {
    console.error('[GET /api/history]', err);
    res.status(502).json({ error: 'Could not load history.' });
  }
});

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const sessionManager = new SessionManager();

wss.on('connection', (socket) => handleConnection(socket, sessionManager));

const stopHeartbeat = startHeartbeat(wss);

async function main(): Promise<void> {
  // Each mode's session starts its own first cycle here — independently
  // of any client ever connecting (requirement 2).
  await sessionManager.startAll();

  httpServer.listen(env.PORT, () => {
    console.log(`[server] listening on port ${env.PORT} (ws path: /ws)`);
  });
}

void main();

// ---------------------------------------------------------------------
// Graceful shutdown — Render sends SIGTERM before redeploying/scaling
// down. Close things in order: stop taking new work, tell connected
// clients, close sockets with a proper close code, then exit.
// ---------------------------------------------------------------------
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] received ${signal}, shutting down gracefully...`);

  // Force-exit if graceful shutdown hangs (a stuck DB call, a stubborn
  // socket) — Render will send SIGKILL eventually anyway, but this keeps
  // shutdown snappy and predictable.
  const forceExit = setTimeout(() => {
    console.error('[server] graceful shutdown timed out — forcing exit.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  stopHeartbeat();
  sessionManager.shutdown();

  for (const socket of wss.clients) {
    socket.close(1001, 'Server is restarting');
  }

  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));

  clearTimeout(forceExit);
  console.log('[server] shutdown complete.');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT')); // Ctrl+C in local dev
