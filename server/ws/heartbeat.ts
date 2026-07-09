/**
 * WebSocket keepalive via protocol-level ping/pong frames (requirement 6),
 * following the pattern from the `ws` library's own documentation for
 * detecting broken connections: every interval, ping everyone; if a
 * client hasn't ponged back since the last ping, it's dead — terminate it
 * rather than leaking a half-open socket (e.g. a laptop that went to
 * sleep, or a network path that silently dropped packets without either
 * side seeing a close frame).
 *
 * A WeakMap (not a property on the socket) tracks liveness so this stays
 * decoupled from the `ws` library's own types.
 */
import type { WebSocket, WebSocketServer } from 'ws';

const PING_INTERVAL_MS = 30_000;

const aliveState = new WeakMap<WebSocket, boolean>();

export function markAlive(socket: WebSocket): void {
  aliveState.set(socket, true);
}

/** Starts the heartbeat loop for a WebSocketServer. Returns a stop
 *  function — call it during graceful shutdown so the interval doesn't
 *  keep the process alive after the HTTP server has closed. */
export function startHeartbeat(wss: WebSocketServer): () => void {
  const interval = setInterval(() => {
    wss.clients.forEach((socket) => {
      if (aliveState.get(socket) === false) {
        socket.terminate();
        return;
      }
      aliveState.set(socket, false);
      socket.ping();
    });
  }, PING_INTERVAL_MS);

  wss.on('connection', (socket) => {
    markAlive(socket);
    socket.on('pong', () => markAlive(socket));
  });

  return () => clearInterval(interval);
}
