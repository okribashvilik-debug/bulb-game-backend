# Bulb Game server

Server-authoritative backend for Bulb Game: Node.js + Express + WebSocket
(`ws`), persisted to Supabase. Three independent, continuously-running game
sessions (5, 7, and 10 bulbs) live in this process's memory and keep
cycling in real time whether or not anyone is connected. Clients only ever
render state pushed from here — there is no game logic on the client.

## Architecture

```
server/
  index.ts              Entry point: Express + WebSocketServer on one HTTP
                         server/port, session boot, graceful shutdown.
  env.ts                Reads + validates SUPABASE_URL / SUPABASE_SERVICE_KEY / PORT.
  supabaseClient.ts      The service-role Supabase client (server-only).
  game/
    GameSession.ts       One BulbGameEngine + persistence + broadcast, per mode.
    sessionManager.ts    Owns the three GameSessions (5 / 7 / 10).
  db/                    Thin repositories over the Supabase tables/RPCs
                         in supabase/schema.sql (players, cycles, bets,
                         live_bets, leaderboard views).
  ws/
    protocol.ts          Client<->server message types (see below).
    connection.ts         Per-connection message routing.
    heartbeat.ts          ping/pong keepalive + dead-connection cleanup.
```

The actual game engine (`../src/BulbGameEngine.ts`, `../src/odds/*`,
`../src/checkpoints.ts`) is the same one built and tested earlier in this
project — the server just runs it with real wall-clock timers
(`defaultClock`) instead of a UI-driven one, and there's no client-side
copy of it anymore in the intended architecture: the browser only speaks
the WebSocket protocol below.

## One-time setup

### 1. Run the database schema

Open your Supabase project -> **SQL Editor** -> **New query**, paste the
entire contents of [`../supabase/schema.sql`](../supabase/schema.sql), and
run it. It creates `players`, `cycles`, `bets`, `live_bets`, the
`leaderboard_daily/weekly/monthly` views, and the `place_bet` /
`resolve_bet` / `void_bet` functions the server calls. Safe to re-run.

### 2. Configure environment variables

```bash
cp .env.example .env
```

Fill in `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from your Supabase
project's **Settings -> API** page (the **service_role** secret, not the
anon key — it bypasses Row Level Security, which is intentional here: this
server is the trusted backend, not a browser client). Never commit `.env`
or put the service key in client code.

### 3. Install dependencies

```bash
npm install
```

## Running locally

```bash
npm run server:dev   # tsx watch — restarts on file changes
# or
npm start            # same entry point, no watch (what Render runs)
```

You should see:

```
[server] listening on port 8787 (ws path: /ws)
```

Health check: `curl http://localhost:8787/healthz`
WebSocket endpoint: `ws://localhost:8787/ws`

## Deploying to Render

1. Push this repo to GitHub/GitLab.
2. In Render: **New +** -> **Web Service** (or **Blueprint** if using the
   included `render.yaml`) -> connect the repo.
3. Environment: **Node**. Build command: `npm install`. Start command:
   `npm start`.
4. Add environment variables `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in
   the service's **Environment** tab. Don't set `PORT` — Render injects it,
   and `env.ts` reads `process.env.PORT` automatically.
5. Health check path: `/healthz` (already set in `render.yaml`; set it by
   hand in the dashboard if you didn't use the blueprint).

Render sends `SIGTERM` before stopping/redeploying an instance; `index.ts`
catches it, stops the heartbeat, closes every WebSocket with a proper 1001
("going away") close frame, closes the HTTP server, and exits — no
half-closed connections left behind. Because each cycle lives in this
process's memory, a redeploy does start each mode's next cycle fresh
rather than resuming an exact in-flight one — see the note in
`GameSession.ts` if you need cross-restart resumption later.

## WebSocket protocol

One connection, one mode at a time. Send `join` again with a different
`mode` to switch. Every message is JSON with a `type` field.

**Client -> server**

| type | fields | notes |
|---|---|---|
| `join` | `mode` (5\|7\|10), `playerId?` | Omit `playerId` to get a new player; a returning client should send back the id it got in `welcome`. |
| `placeBet` | `bulbId`, `stake` | Only accepted during the `betting` state. |
| `cashOut` | — | Only accepted during your active decision window. |
| `continue` | — | Explicit "I'm staying in"; optional — timing out has the same effect. |
| `requestLeaderboard` | `window` (`day`\|`week`\|`month`) | Also available as `GET /api/leaderboard?window=day`. |

**Server -> client**

| type | fields | notes |
|---|---|---|
| `welcome` | `playerId`, `displayName`, `balance` | Sent once per successful `join`. Persist `playerId` client-side to reconnect into the same identity. |
| `snapshot` | `mode`, `snapshot`, `serverTime`, `yourBetId?` | The engine's full `CycleSnapshot` — sent on join and on every state transition. This is the entire "current state" a client needs to render (round, bulb statuses, coefficients, `phaseDeadlineAt`/`phaseDurationMs` for a countdown). |
| `event` | `mode`, `event`, `payload`, `serverTime` | One of the engine's own events (`betPlaced`, `roundStarted`, `bulbPopped`, `decisionWindowStarted`, `playerCashedOut`, `playerContinued`, `cycleComplete`) — for animations/sound cues, not state sync (the `snapshot` message already covers state). |
| `balance` | `balance` | Pushed only to the specific player's own connection(s) after a bet, cash-out, or win — never broadcast. |
| `liveBets` | `mode`, `entries` | Recent activity feed, sent on join. |
| `leaderboard` | `window`, `entries` | Response to `requestLeaderboard`. |
| `actionError` | `action`, `message` | A `placeBet`/`cashOut`/`continue` was rejected — the reason is human-readable. |
| `error` | `message` | Protocol-level error (bad JSON, unknown mode, etc). |

`snapshot`/`event` payloads come straight from the engine's own public
types (`CycleSnapshot`, `BulbGameEvents`) — never from
`BulbGameEngine.getAuditRecord()`, which includes the sealed elimination
order and is server/persistence-only. Forwarding that to a client would
leak every future pop in the cycle in advance.

## Integrity notes

- **Server-authoritative**: `GameSession` is the only thing that ever
  calls `engine.startCycle()` / `resolveRound()` / `cashOut()`. A client
  can only ever *ask* (via `placeBet`/`cashOut`/`continue`); it never
  computes or asserts state.
- **Bet placement is atomic**: `place_bet()` (SQL function) debits the
  balance and inserts the bet row in one transaction, so two concurrent
  bets can never overdraw. If the database accepts a bet but the in-memory
  engine then rejects it (an extremely narrow race — see
  `GameSession.placeBet`), the server calls `void_bet()` to refund and
  delete it, keeping balance and bet history consistent with the actual
  game state.
- **Audit trail**: every cycle's shape, per-bulb probabilities, fixed
  coefficients, winning bulb, and full elimination order are written to
  `cycles` the moment the cycle starts (all of it is already sealed by
  then — see `BulbGameEngine`'s integrity ordering). Every bet's full
  lifecycle (placed, resolved outcome, coefficient used, payout) is in
  `bets`. That's enough to independently re-run the RTP simulation harness
  (`npm run odds-report`) against real production data later.

## What this task did *not* include

The existing React client (`../src/ui/*`) still runs its own local
`BulbGameEngine` + simulated bots — it has not been rewired to speak this
WebSocket protocol. That's a natural next step (swap `useBulbGame`'s local
engine instance for a WS client hook using the protocol above) but is a
separate, frontend-side change from the backend built here.
