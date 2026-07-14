# Bulb Game — project context for a new chat session

This file exists because a previous conversation ran out of context. It
captures everything a fresh session needs to keep working on this project
without re-deriving history. Read this in full before touching code.

**Last updated:** after the audio rework (commit `f87b125`), plus an
in-progress electricity-flow visual patch **not yet committed** (see
"Uncommitted work" below), plus a live Supabase payout investigation that
turned up and fixed a schema-migration gap (no code changes were involved
in that fix — it was a manual SQL step). The project is live in production
and working — this is not a handoff mid-crisis, just a snapshot for
continuity.

## What this project is

"Bulb Game" is a casino-style elimination mini-game: N bulbs (5, 7, or 10)
compete each cycle. Bulbs pop one at a time on a timer; the last one
standing wins. Players bet on a bulb before the cycle starts, and get a
chance to cash out after **every** round instead of riding it out blind.

Pricing is **pari-mutuel** (pooled-stake), not fixed-odds: nobody
pre-assigns win probabilities. The pool of money staked on bulbs that have
already lost is split (minus a 5% house cut) among the bulbs still alive,
in proportion to stake. House take is therefore an emergent measurement per
cycle, not a guaranteed constant.

**Since a cash-out decision window opens after every round (not just once
per cycle), different players cashing out on the same cycle can legitimately
price against different `eliminated_pool` values** — this is the single
most important mental model to hold when something "looks like" a payout
bug. Always reconstruct the actual round-by-round pool history (or the
bet-placed/popped event timeline if that history is missing — see the
Supabase investigation below) before concluding a number is wrong.

The project has three layers:

1. **`src/`** — the core game engine (state machine + pari-mutuel
   odds/payout math, including the "unclaimed pool" house-take breakdown).
   Pure TypeScript, zero DOM/browser dependencies, unit tested
   (`tests/oddsEngine.test.ts`, 30 tests).
2. **`src/ui/`** — the React client. **Fully wired to the WebSocket
   backend** — no local game logic, it only renders `snapshot`/`event`
   messages from the server and sends `join`/`placeBet`/`cashOut`/
   `continue`. Player identity persists in `localStorage` across reloads.
   Now includes the redesigned "show stage" main event area (hanging
   bulbs, reactive room lighting, layered SFX + background music) — see
   Layer 2 below.
3. **`server/`** — a Node.js + Express + `ws` backend that runs the engine
   server-side (server-authoritative), persists everything to Supabase,
   pushes real-time state to WebSocket clients, and runs simulated bots so
   the pool always has liquidity. **This is the only client that talks to
   the game — it's the real thing, not a demo.**

## Live deployment

- **Production URL:** https://bulb-game-backend.onrender.com — this single
  Render web service serves BOTH the built React client (static files) and
  the WebSocket/API backend on one port. Visiting the URL shows the actual
  game, not a status page.
- **Render service:** `bulb-game-backend` (`srv-d97s58mtrd3s739lc87g`),
  auto-deploys on every push to `origin/main` (`autoDeploy: commit`).
  Build Command: `npm install && npm run build`. Start Command:
  `npm start`. Health check: `/healthz`.
- **A Render API key was provided by the user earlier in-session** (not
  stored anywhere in this repo) and used via `curl` against
  `api.render.com/v1` to inspect/trigger deploys and read logs. If a future
  session needs to redeploy or check logs and no key is available, ask the
  user for one — don't assume it persists across sessions.
- **Supabase**: real project, schema migrated to the pari-mutuel +
  unclaimed-pool shape (see "Database" below — this required a manual
  fix mid-session, already resolved and verified). The `.env` file
  (gitignored) holds `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`/`PORT` — the
  only env vars the server reads (`server/env.ts`). The service-role key
  is enough to run one-off read queries directly against the REST API for
  investigation (see the payout-investigation section below for the
  pattern used) — no Supabase MCP/CLI is configured in this environment.

## Git

- Repo: `https://github.com/okribashvilik-debug/bulb-game-backend.git`,
  branch `main`.
- Git identity/credentials are already configured and working in this
  environment — `git push` just works, no setup needed.
- **Standing instruction changed mid-session — read carefully:** the
  earlier blanket "push and deploy proactively once verified working"
  instruction has been **superseded**. The user now wants investigation/
  small changes done and verified **locally first**, and pushed/deployed
  **only when explicitly asked**, or once a full fix is confirmed ready to
  test live. Don't revert to the old proactive-push habit — ask, or wait
  to be asked.
- **Uncommitted work as of this writing:** the electricity-flow cord
  animation (`src/ui/components/BulbTile.tsx`, `src/ui/styles.css`) is
  implemented and verified live but **not committed** — per the workflow
  instruction above, it's sitting in the working tree until the user asks
  for it to be committed/pushed. Check `git status` before assuming the
  working tree is clean.
- Recent history (oldest → newest):
  1. `8f53b33` Initial backend with Supabase integration
  2. `29db538` Fix backend build/start scripts to compile server before running
  3. `11dd6d1` Wire React client to the WebSocket backend and serve it from one service
  4. `165cb78` Replace fixed-odds engine with pari-mutuel (pooled-stake) pricing
  5. `e29b58b` Add simulated bots so the pari-mutuel pool always has real liquidity
  6. `de4251b` Fix crash on unstaked winning bulb; add error boundary; cash out every round
  7. `fb2db3d` Scope Live Bets to the current cycle only, add a fixed summary header
  8. `60dc503` Log, audit, and simulate the pari-mutuel "unclaimed pool" behavior
  9. `8bce5cd` Implement the Main Event Area redesign: hanging bulbs, reactive room, SFX
  10. `da6fb3f` Add looping background ambience under the SFX layer
  11. `16a6fba` Make bulbs directly clickable to select during betting
  12. `f87b125` Rework audio: session-bound music, exclusive SFX channel, timing fixes
  - (uncommitted) Electricity-flow cord animation — see above

---

## Layer 1: the game engine (`src/`)

### State machine — `src/BulbGameEngine.ts`

```
idle --startCycle--> betting --closeBetting--> calculating --(3s)-->
  round_active --resolveRound--> [round_active again, OR decision_window
                                   after EVERY round now, OR cycle_complete
                                   on the last pop]
  decision_window --advanceToNextRound--> round_active
  calculating --(uncontested: <2 bulbs staked)--> cycle_cancelled
    (refunded in full; GameSession restarts a fresh cycle almost immediately)
cycle_complete | cycle_cancelled --startCycle--> betting
```

Fixed timing constants (`BulbGameEngine.ts`): `BETTING_WINDOW_MS = 10_000`,
`CALCULATING_WINDOW_MS = 3_000`, `ROUND_DURATION_MS = 5_000`,
`CASHOUT_WINDOW_MS = 5_000`.

A cash-out decision window opens after every round — see
`src/checkpoints.ts`. The table (`CHECKPOINTS_BY_BULB_COUNT`) is generated
(`everyRoundAfterFirstPop`) to cover every alive-count from `bulbCount-1`
down to `2`; the very last pop always leaves exactly the winner and ends
the cycle directly.

Bulb counts supported: `BulbCount = 5 | 7 | 10`.

### Odds/payout module — `src/odds/` (pari-mutuel)

- **`parimutuel.ts`** — the one formula everything runs on:
  ```
  eliminated_pool(r)     = total stake on every bulb popped by round r
  distributable_pool(r)  = (1 - houseCutRate) * eliminated_pool(r)
  live_coefficient_i(r)  = 1 + distributable_pool(r) / stake_on_bulb_i
  ```
  Undefined (never 0, never a fallback) when nobody staked on bulb `i` —
  the UI renders this as blank (`—`). This one formula prices BOTH a
  mid-round cash-out and the final win payout.
  - **`computeHouseTake(eliminatedPool, houseCutRate, claimedByWinners)`**
    (added since the last snapshot) splits a completed cycle's take into
    `standardCut` (the flat 5% edge) vs. `unclaimedPool` (the share left
    over because everyone who bet on the winning bulb had already cashed
    out early — a cash-out is final, so nobody remains to claim it). This
    is a FLOOR concept, not a ceiling: the standard 5% always applies, but
    early cash-outs on the winning bulb specifically only ever ADD to the
    house's take, never subtract. See `src/types.ts`'s
    `HouseTakeBreakdown` and `CycleAuditRecord.houseTake`.
  - **Important scope note** (found via live simulation, not fixed —
    flagged to the user, still open): this "unclaimed pool" accounting
    only covers cash-outs on the eventual WINNING bulb. Because a decision
    window opens every round on WHICHEVER bulbs are still alive (not just
    the winner), `computeCoefficients()` prices every alive bulb
    independently off the same distributable pool — so if multiple
    DIFFERENT bulbs' bettors cash out at overlapping checkpoints, actual
    ground-truth house take (real money wagered minus real money paid out,
    simulated via `runCashOutBehaviorSimulation()`) can go well below the
    5% floor, including negative. This is a genuine characteristic of the
    current model, not something introduced or fixed by the unclaimed-pool
    work — see `src/odds/rtpSimulation.ts`'s doc comment and
    `server/README.md` for the full writeup.
- **`outcomePlan.ts`** — decides WHO wins and the elimination order via a
  **uniform random Fisher-Yates shuffle**, completely independent of
  stakes. Decided synchronously at `startCycle()`, before betting opens.
- **`PariMutuelEngine.ts`** — the `OddsProvider` implementation.
- **`config.ts`** — `OddsConfig { houseCutRate: number }`, default `0.05`.
- **`rtpSimulation.ts`** — two simulation modes:
  - `runPariMutuelSimulation()` — original hold-to-resolution scenarios
    (`npm run odds-report`'s first table).
  - `runCashOutBehaviorSimulation()` (added since the last snapshot) —
    actually drives round-by-round cash-out decisions under named
    behaviors (`neverCashOutBehavior`, `alwaysCashOutBehavior`,
    `mixedCashOutBehavior`) and reports a full house-take DISTRIBUTION
    (min/max/median/average), not one averaged number — this is what
    surfaced the "can go negative" finding above.

**Uncontested-round rule**: if fewer than 2 bulbs receive any stake at all
by the time betting closes, the round is cancelled — everyone refunded in
full, no round played, logged distinctly (`cycles.status = 'cancelled'`).

### Audit trail — `CycleAuditRecord` (`src/types.ts`)

`{ cycleId, bulbCount, winningBulbId, eliminationOrder, finalStakeByBulbId,
houseCutRate, roundPoolHistory, cancelled?, houseTake? }`.
`finalStakeByBulbId` is locked the instant betting closes;
`roundPoolHistory` accumulates one `{round, eliminatedPool,
distributablePool}` entry per round resolved; `houseTake` is the
`HouseTakeBreakdown` above, set once the cycle actually resolves with a
winner. All computed inside the engine itself (pure, testable, no DB
dependency), exposed via `getAuditRecord()` for the server to persist.

### Two distinct "reveal" surfaces — don't confuse these

- `getSnapshot()` → `CycleSnapshot` — safe to send to a client. No
  elimination order; `liveCoefficients: Record<string, number>` is sparse.
- `getAuditRecord()` → `CycleAuditRecord` — includes the full elimination
  order + house-take breakdown. **Server/audit only**, never forwarded to
  a client (verified — grep confirms `getAuditRecord` is only ever called
  from `server/game/GameSession.ts` and tests, never from `server/ws/`).

### Tests — `tests/oddsEngine.test.ts` (30 tests, `npm test`, ~1s)

Covers the pari-mutuel formula exactly, uniform-random winner/elimination,
"no coefficients before round 1", "coefficients only increase
round-over-round", uncontested-round cancellation + refund, a full engine
integration test, checkpoints (every round), fixed timing, house-take
sanity across `runPariMutuelSimulation` scenarios (never negative under
hold-to-resolution), the `computeHouseTake` breakdown (nobody-claims /
partial-claims / full-claims cases), and the cash-out-behavior simulation
including a **deliberately pinned test documenting** that ground-truth
house take CAN go negative under multi-bulb cash-out behavior (see above)
— that test exists so the characteristic stays visible, not hidden.

---

## Layer 2: the React client (`src/ui/`)

**Fully wired to the WebSocket backend** — `useBulbGame.ts` connects over
`ws(s)://<host>/ws`, sends `join`/`placeBet`/`cashOut`/`continue`, and
renders whatever `snapshot`/`event`/`balance`/`liveBets` messages arrive.
No local `BulbGameEngine` instance, no client-side bot simulator.

### The Main Event Area redesign (new since the last snapshot)

The flat colored-disc bulb grid was fully replaced with a "show stage":
bulbs hang from cords in a dark room whose lighting reacts to them in real
time, following a **high-fidelity design handoff**
(`design_handoff_main_event_area/README.md` +
`Main Event Area.dc.html` prototype — originally on the Desktop, may or
may not still be present in a future session; the implementation is
self-contained and doesn't depend on the handoff files existing).

Key new files:
- **`src/ui/stage.ts`** — the presentation model. Pure derivation (no
  React): turns a `CycleSnapshot` + the transient pop sequence into one
  `StageBulb` per bulb (visual state + all layout geometry). `LampState =
  'idle' | 'charging' | 'overcharge' | 'popped' | 'win'`. State mapping:
  `idle` (idle/betting/calculating), `charging` (alive during
  round_active OR decision_window — deliberately held through decision
  windows so the room doesn't reset every round), `overcharge` (NEW
  client-side transient, ~1.1s after a `bulbPopped` event before showing
  `popped`), `popped` (`bulb.status === 'popped'`, after the overcharge
  beat), `win` (`cycle_complete` + `winningBulbId` match, itself held back
  at `charging` until the final pop's overcharge+burst beats resolve, ~2s,
  so the server's near-simultaneous `bulbPopped`+`cycleComplete` doesn't
  skip straight to gold). Also owns the ambient-light formula and the
  shared particle generator (`makeParticles`, used for both pop shards and
  win sparks).
- **`src/ui/components/BulbTile.tsx`** — one hanging bulb: cord (now with
  an electricity-flow overlay, see below), screw cap, glass (highlight +
  filament + number), winner rays, transient pop-burst/win-spark overlays,
  and a click/tap/keyboard hit-target button (see click-to-select below).
  All state styling is CSS class families in `styles.css`
  (`bulb--<state>`), values verbatim from the design spec.
- **`src/ui/components/RoomLighting.tsx`** — the reactive room, rendered
  behind the bulbs: static stage shell (curtain wall, floor, gold
  horizon), ambient wash, win climax wash, darkness vignette, and per-bulb
  wall glows / overcharge flares / light cones / floor pools (screen
  blend). A pop dims only that bulb's own glow, over 1s — never a flat
  global fade.
- **`src/ui/components/MainEventArea.tsx`** — composes stage + room +
  bulbs, drives the SFX dispatcher off the derived per-bulb states, and
  owns bulb click-to-select eligibility.
- **Click-to-select (new)**: players can pick their bulb by clicking/
  tapping it directly on stage during betting, not only via the
  `ControlPanel` chips — both surfaces read/write the same
  `selectedBulbId`, so they always agree. Deselects on a second click of
  the same bulb. Hit target is a real `<button>` (Enter/Space,
  `aria-pressed`, "Select bulb N" label), min 44×44px, mounted ONLY while
  selectable (betting open, no bet placed yet) — outside that window
  there's no cursor affordance and clicks fall through.
- **Electricity-flow cord animation (uncommitted, see Git section)**:
  energy visibly travels down each bulb's cord while powered — dashes
  (`cord-energy__dashes`, always mounted, opacity/flow-speed vary by
  state), a travelling spark (`cord-energy__spark`, mounted only while
  charging/overcharge/win), and a jittering SVG arc bolt
  (`cord-energy__arc`, mounted only during overcharge). Class family
  `cord-energy--<state>`, colors via `--energy-color`/`--energy-glow`
  CSS custom properties (bulb's own palette color, or gold for `win`).
  Pure overlay — never touches cord geometry or existing state animations.

### Audio (`src/ui/sfx.ts` + `src/ui/sound.ts`) — substantially reworked

Two audio modules, intentionally separate:
- **`sound.ts`** — the older cue set (cash-out, decision-window
  open/close). Unchanged.
- **`sfx.ts`** (new since the last snapshot) — everything for the main
  event stage, in one `SfxManager` singleton, all through ONE shared
  `AudioContext`:
  - **Charging/overcharge/pop cues** now share **one exclusive stage
    channel** (`setStagePhase('quiet' | 'charging' | 'overcharge')`), not
    a per-bulb loop map — at most one of charging/overcharge/pop is ever
    audible, at any bulb count. Every phase change is a strict sequential
    handoff: fade the previous loop (~80ms) and only start the next once
    that fade has FULLY finished, enforced on the audio clock
    (`channelBlockedUntil`), not a cancellable JS timer — a re-render
    mid-gap must not be able to skip the gap (this was a real bug caught
    live during verification: React re-renders from the countdown ticker
    were re-entering the phase machine and cancelling the pending
    handoff). A pop additionally holds the channel silent for its own
    tail so the next round's charging can't ride over it.
  - **Win / idle / click** — synthesized Web Audio oscillator cues
    (verbatim ports of the design prototype's `sfx*` methods).
  - **Background music** — one ambient track (`public/sfx/background.mp3`,
    replaced once mid-session with a smaller/updated file, same name),
    tied to SESSION boundaries: `startMusicSession()` restarts it from the
    very first note the moment a cycle's betting opens (deduped by
    `cycleId`), `stopMusic()` silences it on `cycle_complete`/
    `cycle_cancelled`. Buffer is fetched + fully decoded at preload so
    session-start playback is instant/unclipped — no decode on the hot
    path. Runs through its own dedicated gain node, independent of every
    SFX gain (`MUSIC_VOLUME = 0.18` vs. SFX `DEFAULT_VOLUME = 0.38`, both
    single tunable constants). Loops via a scheduled ~1.5s crossfade if a
    session outlasts the track, EXCEPT the very first pass of a session,
    which starts at full gain (no fade-in) so the session opens on the
    track's actual first note.
  - **Unlock bug fixed**: the first-gesture unlock listener was
    `{ once: true }` — if that first pointerdown didn't carry real user
    activation (e.g. a synthetic event), `resume()` silently failed and a
    one-shot listener left the AudioContext suspended until the mute
    toggle happened to call `resume()` again (the "no sound until
    mute/unmute" bug). Fixed by making the listener persistent
    (pointerdown + keydown, not `{ once: true }`) — both `unlock()` calls
    are idempotent no-ops once running, so re-firing costs nothing.
  - All of the above obeys the existing master mute toggle
    (`setEnabled()`); `setMusicEnabled()` exists for an independent
    music-only mute if ever wired to UI (no toggle for it yet).
- Assets: `public/sfx/{charging,overcharging,pop,background}.mp3`.

### Other pieces (mostly unchanged from the last snapshot)

- **`ErrorBoundary.tsx`** — wraps `<App/>` in `main.tsx`; last-resort
  render-error recovery + 3s auto-reload.
- **`palette.ts`** — locked per-bulb color palette (10 hues, 1-indexed).
- **`maskUsername.ts`** — `M*****1`-style masking for public feeds.
- **`components/LiveBetsFeed.tsx`** — `LiveBetsFeed` + `LiveBetsSummary`
  (current-cycle-only, via `entry.cycleId === snapshot.cycleId` filtering).
- **`nearMiss.ts` remains deleted** — no longer valid once elimination
  became uniform random. `PopBurst.tsx` was ALSO deleted as part of the
  Main Event Area redesign (its job is now the pop-burst overlay inside
  `BulbTile.tsx`, driven by `stage.ts`'s shared particle generator).

### A note on `noUncheckedIndexedAccess`

`tsconfig.json` has `"noUncheckedIndexedAccess": true`, meant to **stay on
permanently** (see prior incident: a production crash from an unhandled
`undefined` coefficient). Unchanged since the last snapshot.

`npm run build:client` builds it via Vite; `npm run build` builds both
client and server (see Build & deploy below).

---

## Layer 3: the backend server (`server/`)

Full docs: **`server/README.md`** (now also documents the house-take
breakdown fields and the negative-house-take caveat — see Layer 1).
Architecture, WebSocket protocol, and bot behavior are unchanged from the
last snapshot: `server/index.ts` (Express + `ws` on one port, serves the
built client from `dist/`), `server/game/sessionManager.ts` (one
`GameSession` per mode, cycling forever), `server/game/bots.ts`
(`BotController`: 3–8 bots, real pari-mutuel stakes, no Supabase
persistence, `live_bets` rows with `player_id: null`).

### Database — `supabase/schema.sql`

Same pari-mutuel shape as before, PLUS three columns added for the
unclaimed-pool feature: `standard_house_cut numeric(12,2)`,
`unclaimed_pool numeric(12,2)`, `total_house_take numeric(12,2)` on
`cycles`. **This migration was NOT applied when the feature first
shipped** — see the incident below — but **has since been applied and is
now confirmed live and working** (verified by direct Supabase query: the
columns exist, and recently-completed cycles have real, non-null values
in them). The migration block at the bottom of `schema.sql` is idempotent
(`IF EXISTS`/`IF NOT EXISTS`) — same manual-hand-off pattern as before (no
direct Postgres connection in this environment, only the `service_role`
REST/RPC key via `.env`).

### Incident: missing migration silently broke cycle-completion writes

**Symptom reported by the user:** a completed 5-bulb cycle's cash-out
payouts looked inconsistent with the pari-mutuel formula when checked
against a single "the" eliminated pool.

**Investigation (read-only, via direct Supabase REST queries against
`.env`'s service-role key — see git history / prior session transcript
for the exact query pattern, since no MCP/CLI is configured here):**
every payout actually reconciled exactly once the round-by-round timeline
was reconstructed from `live_bets`/`bets` — different cash-outs in the
same cycle legitimately priced against different `eliminated_pool` values
because they landed in different decision windows (see the "every round"
note at the top of this file). Not a bug in payout math.

**A real, separate bug was found along the way:** reading
`cycles.round_pool_history` for that cycle came back `null`, and the
cycle was stuck at `status: 'active'` (never marked `'complete'`).
Root cause: `markCycleComplete()` (in `server/db/cyclesRepo.ts`) had
started writing the three new house-take columns (added when the
unclaimed-pool feature shipped, commit `60dc503`) that didn't exist yet
in the live database — every completion write since had been failing and
the error was only logged, not surfaced. ~1000+ cycles between
2026-07-10 and the fix were stuck `active` with no `round_pool_history`/
`final_stake_by_bulb`/house-take data ever persisted (bets, payouts, and
balances were unaffected — those are separate writes). **The user ran the
migration manually in the Supabase SQL editor mid-session; verified
resolved** — recent cycles now complete with full pool history and real
house-take numbers. The ~1000 stuck rows from before the fix are
permanently missing that data (it only ever lived in engine memory) but
nothing forward-looking is affected.

**Lesson for future schema changes:** a new column referenced by a
`markCycleComplete`/similar write path is a deploy-order hazard in this
project — the code and the migration are two separate hand-offs (git push
vs. manual SQL), and there's no automatic check that the migration ran.
If a future feature adds a column, either verify the migration is live
BEFORE merging the write path, or wrap the write in more visible
error-reporting so a gap doesn't sit silent for two days.

### Build & deploy — unchanged from before, still accurate

Two tsconfigs (`tsconfig.json` root/Bundler for Vite+typecheck,
`tsconfig.server.json` CommonJS for the compiled backend in
`dist-server/`). `package.json`'s `"build"` script runs `vite build` (the
client) **before** `tsc -p tsconfig.server.json` — this ordering matters,
it's why one Render service can serve both.

---

## Outstanding work / natural next steps

1. **Commit/push the electricity-flow cord animation** (uncommitted, see
   Git section) — implemented and verified live, just waiting on explicit
   go-ahead per the new push/deploy workflow.
2. **Negative house-take under multi-bulb cash-out behavior** (see Layer
   1) — a real, measured characteristic of the current model, reported to
   the user but deliberately NOT fixed (it's a payout-model decision, not
   a bug to quietly patch). Revisit if/when the business wants to address
   it — options likely include restricting cash-out to the eventual
   winner-adjacent logic (not possible, winner is secret) or accepting the
   variance and pricing the house edge around the measured distribution.
3. **Near-miss cue** — still dead/removed as of the last snapshot; no new
   decision made.
4. **Leaderboard/`/api/leaderboard`** — still client-session-only, never
   calls the DB-backed leaderboard endpoint. Unchanged.
5. **Bot tuning constants** — unchanged, still hand-picked.
6. **Independent music-only mute toggle** — `sfxManager.setMusicEnabled()`
   exists but nothing in the UI calls it yet; trivial to wire up if wanted.

## Quick verification commands

```bash
npm run typecheck        # whole project, ~instant
npm test                 # 30 tests, ~1s
npm run odds-report      # house-take scenario tables (hold-to-resolution
                         # AND the cash-out-behavior distribution), ~few sec
npm run server:dev       # backend, local, tsx (fast iteration)
npm run build && npm start  # backend, exactly as Render runs it (serves the client too)
npm run dev               # frontend only, Vite — NOT wired to a backend on this port;
                           # useBulbGame.ts auto-targets ws://localhost:8787 in dev,
                           # so run `npm run server:dev` alongside it for a working demo
```

For live-browser verification during development, use the Browser-pane
`preview_start` tool with the `"server"` launch config in
`.claude/launch.json` (runs `npm start` on port 8787, i.e. the exact
compiled build) — `"vite-dev"` is also defined but only serves the client
alone. In this environment the pane has occasionally served stale
page-instance snapshots across `preview_start` calls (looked like the app
was muted/stuck when it wasn't) — if something looks wrong, re-navigate or
restart the preview before trusting the read.

For one-off Supabase investigation (no MCP/CLI configured here): read
`SUPABASE_URL`/`SUPABASE_SERVICE_KEY` out of `.env` and hit the REST API
directly with `fetch`, e.g. via a throwaway Node script — see the payout
investigation above for the exact pattern (query `live_bets`/`bets` by
distinctive payout amounts or stake fingerprints to locate a cycle, then
pull `cycles`/`live_bets`/`bets` by `cycle_id`).

---

## Changelog (per-session, newest last)

- Top history bar (`src/ui/components/TopStrip.tsx` + `.top-strip*` rules in
  `src/ui/styles.css`): added a "Previous Rounds" expander between the logo
  and the chips that opens an overlay panel of the last 30 results (reuses
  `outcomeHistory`, already capped at 30 via `OUTCOME_HISTORY_LIMIT`; no new
  data source). Bar made taller (`min-height: 68px`, padding 16px) and
  `overflow: visible` so the dropdown can extend below it; items stay
  vertically centered.
- Fixed backend not starting (`server/index.ts:54`): root package is
  `"type": "module"`, so `npm run server:dev` (tsx, ESM) crashed on
  `__dirname is not defined` before ever listening — the game never ran
  locally. Replaced `path.join(__dirname, '..', '..', 'dist')` with
  `path.join(process.cwd(), 'dist')`, which resolves correctly under both
  the ESM dev path and the compiled-CommonJS prod path (both launch from
  the repo root). Verified: server listens on 8787, client connects, live
  rounds/bets stream, no console errors.
- Stage status indicator (`src/ui/components/MainEventArea.tsx` +
  `.stage-caption*`/`.main-event__timer-bar` in `src/ui/styles.css`):
  removed the "Main event" title; moved the block from top-left to
  centered at the stage bottom (below the bulbs) as a column: status
  (bold white) → timer bar + round counter → countdown (bold `--gold`
  `#f5c451`, same hex as the bar fill). Bar is now inline in the block
  (span-in-span) instead of absolutely positioned.
- Bottom control bar restructured (CSS-only, `src/ui/styles.css`;
  supersedes the earlier "shift right" balance/chips tweaks): bulb chips
  (`.bulb-picker`) now form their own full-width row on TOP via
  `order: -1; flex-basis: 100%`, with balance → stake stepper → bet
  button on the row below, evenly spaced by the panel's single 20px flex
  gap (balance's extra 4%/12px margins and the chips→bet 4px margin rule
  were removed). All three vertically centered on the same midline.
- Bottom bar rows centered (`src/ui/styles.css`): `justify-content: center`
  on `.control-panel` (centers the balance/stepper/bet flex line) and on
  `.bulb-picker` (centers the chip group inside its full-width row) —
  count-independent, verified at 5 and 10 chips; internal gaps unchanged.
- Stage countdown timer (`.stage-caption__timer`, `src/ui/styles.css`):
  font-size 11px (inherited) → explicit 14.85px (+35%); color/weight/
  position unchanged.
- Name masking (`src/ui/maskUsername.ts`): now always fixed-width 7 chars —
  first char + 5 asterisks + last char (was hash-varied 3–6 stars ±
  trailing char). Shared by Live Bets and Leaderboard; no column CSS
  touched.
- Top bar de-scrolled + relabeled (`TopStrip.tsx`, `styles.css`):
  `.top-strip__chips` now wraps (`flex-wrap: wrap; overflow: visible`)
  instead of `overflow-x: auto`; inline toggle "Last 30" and the expander
  panel title "Last 30 rounds" both renamed to "Previous rounds".
- Viewport-locked layout (`src/ui/styles.css`): html/body/#root and `.app`
  get `overflow: hidden`; `.app` height 100vh→100dvh with rows
  `auto minmax(0,1fr) auto` so the stage row can shrink; `.main-event`
  min-height 520px→0 (restored to 520px inside the ≤900px one-column
  media query, where page scroll returns via `overflow: auto` overrides).
  Only `.right-panel__body` scrolls. Verified at 800px and 700px heights:
  no page scroll, bet button/chips always visible.
- Bar/stage rebalance (`src/ui/styles.css`): `.top-strip` padding 16px→8px
  + dropped `min-height: 68px`; `.control-panel` padding 14px→8px vertical,
  gap 20px→`10px 20px` (tight row gap, same column gap) — freed height
  flows to the stage row. `.stage-bulbs` now `inset: 0 0 100px 0`,
  reserving a bottom band so the status caption never overlaps bulbs
  (percentage geometry scales above the band).
- Removed the "Betting opens again once this cycle ends." note from
  `ControlPanel.tsx` (the whole conditional block). Other notes ("Your
  bet…", "calculating odds…") kept. No spacing compensation needed — the
  note was its own wrapped flex line, so the bar just tightens.
- Full responsive pass (`src/ui/styles.css`): grid columns use
  `minmax(0,1fr)` so tracks can shrink; new 901–1100px tier (300px side
  panel); ≤900px stacks top→stage→controls→feeds with natural page scroll
  (height chain released), stage `clamp(360px,52vh,560px)`, top strip
  wraps, history dropdown pinned to viewport edges, feed list capped 50vh,
  full-width bet CTA, bounded decision modal; `(pointer:coarse)` bumps tap
  targets. IMPORTANT gotcha: component media overrides MUST sit at the
  BOTTOM of styles.css — equal specificity means source order decides, and
  overrides placed above the base rules silently lose. Verified at 320/375/
  667×375/768/1000×700/1024×600/1280×800/1600×900: no horizontal scroll
  anywhere; desktop stays viewport-locked.
