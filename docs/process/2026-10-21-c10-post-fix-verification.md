# Stage card: C10 post-multi-user-test fixes

Title / date: C10 post-multi-user-test fixes, 2026-10-21
Status: implemented and verified locally; not yet deployed
Starting commit: `c8a4b10` (the multi-user test report commit; CI run
[39205736108](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/actions/runs/39205736108)
passed `check` + `deploy` and the deployed revision is `c8a4b10`)

## Player problem and evidence

The author ran a real multi-user test session against the deployed app
(`multi-user-test-report.md`) and found the previous C10 follow-up round's
own fixes were not quite complete. Two real gaps, both confirmed by
reading the actual source, not just the report's prose:

1. **Forced-flee logging still wasn't fully honest.** `FightSession.forceFlee`
   (`server/coop/fight-session.ts`) returned `ok: true` whether or not the
   round actually resolved this call — "accepted" and "resolved" were
   conflated. `server/coop/ws.ts`'s `handleReconnectTimeout` logged
   `summary.left: result.ok`, so a forceFlee that only *queued* (a
   teammate not yet readied) was logged as `left: true` at the exact
   moment the player was still structurally in the fight. The existing
   test at the time (`server/coop/ws.test.ts`, "a normal (not downed)
   reconnect-window timeout still logs ... left true") enshrined this
   wrong behavior rather than catching it.
2. **The expedition-ended panel didn't survive reload/reconnect.**
   `CoopHelloMsg` only ever carried `fightId`, which is `null` both for
   "never fought" and "fought and wiped" — a reload or reconnect after a
   real party wipe showed nothing: no panel, no way out, even though the
   player genuinely could no longer move or re-enter combat (the prior
   round's `room.setIntent` HP gate).

Two smaller items, requested alongside the two fixes above:

3. `tools/coop-xss-check.mjs`'s `walkTogether` used `results.some(Boolean)`
   — only one of two tabs reaching combat was enough to report "both
   players enter a shared fight."
4. The evidence docs (`README.md`, `PROCESS.md`, `reflections/crit-10.md`)
   needed syncing to the real multi-user-test results and the real
   deployed/CI state, without claiming human play.

## Desired improvement

A forced-flee or in-fight Flee is only ever logged as "the player actually
left" once resolution genuinely confirms it — never at request time. A
real party wipe is visible after a reload or reconnect, not just live. The
XSS check's "shared fight" claim requires every profile to actually be in
it, and specifically the *same* fight. The evidence docs state the real,
current CI/deployment/test state plainly, distinguishing agent-driven
sessions from a human playtest (still outstanding).

## This stage includes

- `FightSession.forceFlee` returns a new `left: boolean` alongside `ok`,
  derived from `justLeft` (the same signal `afterFightChange` already
  drains for the `leftFight` notification) — `ok` alone never implies
  departure.
- `ws.ts`'s reconnect-timeout log never claims `left` at request time
  (`summary.queued` instead); a new single-fire `coop.fight.left` log,
  emitted in `afterFightChange`'s existing `takeJustLeft()` loop, is the
  one authoritative "they actually left" record — covering a forced-flee
  timeout (queued or immediately resolved) and an ordinary in-fight Flee
  click identically.
- `RoomPlayer.expeditionEnded: "wiped" | null`, set only on a successful
  `"wiped"` `tryFinishFight` commit (rolled back if the store write
  fails), persisted in the room snapshot, restored on a cold load, and
  sent in `hello`. `coop-main.ts`'s `hello` handler shows the existing
  `showExpeditionEndedPanel()` when set — covering both a fresh page load
  and a same-tab reconnect, never for won/abandoned, never mid-fight.
- `tools/coop-xss-check.mjs`'s `walkTogether` now requires `every()` tab
  to reach combat, plus an explicit same-`fightId` assertion.
- This card, plus updates to `README.md`, `PROCESS.md` and
  `reflections/crit-10.md`'s final factual paragraph.

## Rule boundaries

- No new rules: this closes accuracy/visibility gaps in mechanisms that
  already existed (forced flee, party wipe, the identity/permission check
  suite).
- Co-op still has no revive path; `expeditionEnded` is never cleared once
  set (the only way past it is a fresh room via "Start a new expedition",
  unchanged).
- A late joiner to a room that already has a wiped member does not
  themselves get `expeditionEnded` — their own `RoomPlayer` is created
  fresh via `addPlayer`, which never sets the field.

## Save impact

`PersistedRoom`'s player entry gains an optional `expeditionEnded?: "wiped"`
field (additive; absent on an old snapshot, same pattern as the existing
optional `alive` field on enemies). No save-shape version bump needed —
this is co-op room state, not the solo save schema.

## Acceptance scenarios

| Action | Observable result |
| --- | --- |
| A forceFlee queues (teammate not yet ready) | Logged `queued: true`; no `coop.fight.left` record exists yet; the player is still a member |
| A forceFlee resolves within the same call (last unready player) | Logged `queued: false`, AND a separate `coop.fight.left` record fires once |
| An ordinary in-fight Flee click resolves immediately | A `coop.fight.left` record fires once |
| An ordinary in-fight Flee click only queues | No `coop.fight.left` record yet |
| A party wipes | Every still-present member's `RoomPlayer.expeditionEnded` becomes `"wiped"`; a won/abandoned fight never sets it |
| A wiped player reloads the page or reconnects | `hello` reports `expeditionEnded: "wiped"`; the client shows the same panel as a live wipe |
| A wiped player's room survives a real restart | A fresh `CoopServer`/store load still reports `expeditionEnded: "wiped"` |
| A brand-new identity joins the same (already-wiped) room | Their own `hello` reports `expeditionEnded: null` |
| Only one of two browser profiles reaches combat | `coop-xss-check.mjs` now fails "both players enter a shared fight" (confirmed by deliberately sabotaging one tab's steering during verification, then reverting) |

## Checks selected and why

Unit-level (`server/coop/fight-session.test.ts`, `server/coop/ws.test.ts`)
for the forceFlee/logging and expedition-ended-panel mechanics, since both
are deterministic server-state claims provable without a live app — the
wipe tests reuse the existing deterministic "set HP low, end turn" pattern
already used elsewhere in `fight-session.test.ts`, and a new
`testGetOrLoadRoom` hook exercises the real cold-load/restore path (a
fresh `CoopServer` + store handle against the same data dir) rather than
hand-building a `CoopRoom` and assuming it behaves like a restored one.
Real-browser (`tools/coop-wipe-check.mjs`, extended with a reload step)
because only a real page load proves the server's `hello` field actually
reaches and is acted on by the client, at both a desktop and phone
viewport. `tools/coop-xss-check.mjs`'s fix was verified by deliberately
breaking it (steering one tab somewhere unreachable) to confirm it now
genuinely fails rather than silently passing, then reverting that
sabotage before committing.

## Review evidence

- **2026-10-22, agent, local unit tests (Node 24, macOS)**: `pnpm typecheck`
  clean; `pnpm test:unit` 451 tests passing — new: `server/coop/fight-session.test.ts`
  extended with 2 tests asserting `forceFlee`'s new `left` field for all
  branches (solo-resolves-immediately, queued-only, resolves-alongside-
  teammate, forced-as-the-last-unready-player, downed/already-fled
  rejection); `server/coop/ws.test.ts` extended with 4 tests replacing the
  one wrong assertion (queued case never claims `left`; a resolving case
  logs `queued:false` plus one `coop.fight.left`; an ordinary Flee click
  that resolves/queues) and a new "expedition-ended panel survives
  reload/reconnect" describe block (6 tests: a real wipe sets
  `expeditionEnded`; won and abandoned fights do not; a reconnect still
  reports it; a late joiner to the same room is unaffected; a real
  restart — fresh `CoopServer` + store handle against the same data dir —
  restores it from the persisted snapshot alone).
- **2026-10-22, agent, real HTTP/WS against the dev server**: `APP_URL=...
  pnpm check` passed (472 tests); `pnpm check:log` passed (7/7 — this
  round's log changes add a new `coop.fight.left` event type but don't
  remove or rename any event this check already asserts the presence of);
  `node tools/coop-live-check.mjs` and `node tools/coop-identity-demo-check.mjs`
  both passed in full (confirming no regression in the surrounding co-op
  protocol).
- **2026-10-22, agent, real headless Chrome, local rooms only**
  (`tools/coop-xss-check.mjs`): passed in full, including the new
  same-`fightId` assertion, and all 6 bracketed/backslash name scenarios
  from the prior round. Separately verified the `every()`/same-fightId
  fix is real, not cosmetic: temporarily sabotaged the check (steered the
  victim toward an unreachable coordinate so only the attacker reached
  combat), confirmed both "both players enter a shared fight" and "both
  players are in the SAME fight" failed as expected, then reverted the
  sabotage and re-ran to confirm a clean pass again.
- **2026-10-22, agent, real headless Chrome** (`tools/coop-wipe-check.mjs`,
  extended): passed in full at both desktop (1280x800) and phone
  (390x844) viewports, including the new steps — a negative check that
  the panel is NOT shown mid-fight, and a reload (fresh page load, same
  cookie identity, re-clicking Join since a fresh load never silently
  auto-rejoins) that confirms the SAME panel reappears with the same text,
  exercising the server's persisted/hello-restored field end to end, not
  just the live fightEnded path.
- **2026-10-22, agent, the actual production Docker image** (fresh build,
  fresh container, `--tmpfs /data`): `APP_URL=... pnpm check` passed (472
  tests); `pnpm check:browser` and `pnpm check:deploy` both passed in full
  (`verify-deploy`'s `sourceRevision: c8a4b10`, `worktreeDirty: true` —
  correctly describing this checkout's own uncommitted state at
  verification time, not a container fingerprint, per the standing
  correction in `docs/process/2026-10-17-c10-identity-logging.md`);
  `tools/coop-log-check.mjs`, `tools/coop-xss-check.mjs`,
  `tools/coop-live-check.mjs`, `tools/coop-identity-demo-check.mjs`, and
  `tools/coop-wipe-check.mjs` (including its new reload step, both
  viewports) all passed; `docker logs` on the running container confirmed
  real `coop.fight.left` events (`summary.left: true`) and all three real
  states of `coop.fight.flee`'s summary (`left: false` for a rejected
  forceFlee, `queued: true` for one that only queued, `queued: false` for
  one that resolved immediately) actually firing, not just asserted by a
  unit test. Container and image removed after the sweep.
- **`pnpm check:evidence`**: passed (24 cited commits in `PROCESS.md` all
  resolve at the time of this check; all three reflection files found).
- **Not run as part of this round**: a real Fly deploy of these fixes;
  `flyctl logs` exercised against the live app with this round's changes
  present (the production Docker sweep above confirms the same logging
  mechanism `flyctl logs` relies on, but not the actually-deployed app).
  The real two-person narrate-from-logs demo remains outstanding, as it
  has every round.
- **Author feedback**: none yet on this round's fixes specifically.

## Reviewed implementation commits

- `f567620` — honest forced-flee/left logging (`fight-session.ts`,
  `ws.ts`, their tests); also carries `ws.ts`'s server-side half of the
  expedition-ended-panel fix (both files were edited before either commit
  was made — noted explicitly in the next commit's message).
- `0b14516` — the expedition-ended panel survives reload/reconnect
  (`room.ts`, `coop-protocol.ts`, `coop-main.ts`, `coop-wipe-check.mjs`'s
  reload extension).
- `87f617c` — `coop-xss-check.mjs`'s same-fight requirement.
- (this commit) — the stage card itself and the doc sync below.

## Deployment

Not deployed as part of this stage. `c8a4b10` (the commit this stage
started from) is the currently-deployed revision per
`multi-user-test-report.md` and CI run 39205736108; this stage's own
fixes are not yet part of that deployed build.

## Next decision

Whether these fixes, once committed, warrant a fresh deploy + a repeat of
the relevant multi-user-test scenarios (at minimum: a real forced-flee
timeout and a real reload-after-wipe, against the actually deployed app),
and what — if anything — still blocks the real two-person narrated demo.
