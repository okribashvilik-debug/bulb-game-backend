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
  scripts/
    writeCjsMarker.mjs    Build-step helper — see "Why a separate build" below.

tsconfig.server.json      Backend-only compile config (server/ + the non-UI
                           parts of src/) — see "Why a separate build" below.
```

The actual game engine (`../src/BulbGameEngine.ts`, `../src/odds/*`,
`../src/checkpoints.ts`) is the same one built and tested earlier in this
project — the server just runs it with real wall-clock timers
(`defaultClock`) instead of a UI-driven one, and there's no client-side
copy of it anymore in the intended architecture: the browser only speaks
the WebSocket protocol below.

**`server/index.ts` is the one and only backend entry point.** `src/index.ts`
is a *different* file — the game engine's own public barrel export
(`BulbGameEngine`, the odds module, shared types), meant to be *imported*
by `server/` and by the React client (`src/ui/`), never run directly. If a
deploy ever tries to execute `src/index.ts` as a program, something's
pointed at the wrong entry point — see **Troubleshooting** below.

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

For day-to-day development, run the TypeScript directly (no build step —
`tsx` transpiles on the fly):

```bash
npm run server:dev   # tsx watch — restarts on file changes
```

To rehearse exactly what Render will run — a real compile step, then the
compiled JavaScript, nothing transpiled on the fly:

```bash
npm run build   # tsc -p tsconfig.server.json, then stamps dist-server/
                 # with {"type":"commonjs"} — see below
npm start        # node dist-server/server/index.js
```

Either way you should see:

```
[server] listening on port 8787 (ws path: /ws)
```

Health check: `curl http://localhost:8787/healthz`
WebSocket endpoint: `ws://localhost:8787/ws`

### Why a separate build for the backend

`tsconfig.json` (the project-wide one, used by `npm run typecheck` and by
Vite for the React client) targets **Bundler** module resolution —
extensionless imports, no compiled output, fine for Vite/tsx but not
something plain `node` can execute directly. `tsconfig.server.json`
compiles *only* what the backend needs — `server/**` plus the non-UI parts
of `src/` it imports (the engine, the odds module) — to CommonJS in
`dist-server/`, deliberately excluding `src/ui/**` and `src/main.tsx` (the
React client has its own separate build/deploy via `npm run build:client` /
Vite, untouched by this). Since the root `package.json` has
`"type": "module"` (needed for Vite/tsx elsewhere in the repo) but the
compiled backend is CommonJS, `npm run build`'s second step writes a
`dist-server/package.json` with `{"type":"commonjs"}` so Node interprets
the compiled `.js` files correctly regardless of the root package's type.

## Deploying to Render

1. Push this repo to GitHub/GitLab.
2. In Render: **New +** -> **Web Service** (or **Blueprint** if using the
   included `render.yaml`) -> connect the repo.
3. **Environment**: Node.
   **Build Command**: `npm install && npm run build`
   **Start Command**: `npm start`
   (If you're editing an *existing* service rather than creating a fresh
   one, double-check these two fields explicitly in **Settings** — Render
   does not retroactively re-run auto-detection or apply `render.yaml`
   changes to an already-created service's saved Build/Start Command; see
   Troubleshooting.)
4. Add environment variables `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in
   the service's **Environment** tab. Don't set `PORT` — Render injects it,
   and `env.ts` reads `process.env.PORT` automatically.
5. Health check path: `/healthz` (already set in `render.yaml`; set it by
   hand in the dashboard if you didn't use the blueprint).

## Troubleshooting

**`ERR_MODULE_NOT_FOUND ... imported from .../src/index.ts`** — Render
executed `src/index.ts` (the engine's barrel export, not a program) via
plain `node`, instead of `server/index.ts` via the build above. This means
the service's **Start Command** (and/or **Build Command**) saved in the
Render dashboard doesn't actually match this repo's `package.json`
scripts — most commonly because the service was created (and Render
auto-detected/guessed a command, sometimes from `package.json`'s old
`"main"` field) *before* `server/` existed, and the dashboard's saved
command doesn't update itself just because the repo changed. Fix: open the
service's **Settings** in the Render dashboard and set Build/Start Command
to *exactly* the two commands in step 3 above, then trigger a manual
redeploy ("Clear build cache & deploy" if you want to be extra sure
nothing stale is cached).

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
- **Audit trail**: every cycle's winning bulb and full elimination order
  (decided by a fair uniform shuffle — see `src/odds/outcomePlan.ts`) are
  written to `cycles` the moment the cycle starts. The pari-mutuel pool math
  — final stake per bulb, the house cut rate used, and the round-by-round
  eliminated/distributable pool history — is written once more when the
  cycle finishes (or marked `cancelled` with a reason, for an uncontested
  round that got refunded — see `src/odds/parimutuel.ts`). Every bet's full
  lifecycle (placed, resolved outcome, coefficient used, payout) is in
  `bets`. That's enough to independently re-derive any payout later, or run
  the scenario report (`npm run odds-report`) against real production data.
- **House take is logged as two separate line items, not one blended
  number**: a cash-out is final (see `PlayerStatus` in `src/types.ts`) — a
  player who cashes out has no further claim on the cycle, win or lose. If
  every bettor on the eventual winning bulb cashes out before the cycle
  ends, their share of the final pool has no claimant left and stays with
  the house on top of the standard edge. `cycles.standard_house_cut` (the
  flat 5%-of-eliminated-pool edge) and `cycles.unclaimed_pool` (whatever
  the winning bulb's stake left unclaimed) are written separately at cycle
  completion — see `computeHouseTake()` in `src/odds/parimutuel.ts` — so
  historical data can distinguish "the flat edge" from "unclaimed early
  cash-outs" instead of only ever seeing one blended `total_house_take`.
  `npm run odds-report` now also prints the full house-take DISTRIBUTION
  (min/max/median/average, not just one average) across simulated cash-out
  behavior patterns — see `runCashOutBehaviorSimulation()` in
  `src/odds/rtpSimulation.ts`. That report's own output calls out an
  important caveat: the 5% edge is a floor only for cash-outs concentrated
  on the eventual winning bulb (the case this feature targets). Because a
  decision window is offered after every round, on whichever bulbs happen
  to still be alive — not only the eventual winner — cash-outs landing on
  multiple *different* bulbs at overlapping checkpoints can push actual
  house take below 5%, including negative, since `computeCoefficients()`
  prices every still-alive bulb independently off the same distributable
  pool. That is a real characteristic of the current model, not something
  this change introduces or fixes (no change was made to
  `live_coefficient`/`computeCoefficients` itself) — flagged here so it
  stays visible for whoever next looks at cash-out economics.

## What this task did *not* include

The existing React client (`../src/ui/*`) still runs its own local
`BulbGameEngine` + simulated bots — it has not been rewired to speak this
WebSocket protocol. That's a natural next step (swap `useBulbGame`'s local
engine instance for a WS client hook using the protocol above) but is a
separate, frontend-side change from the backend built here.
