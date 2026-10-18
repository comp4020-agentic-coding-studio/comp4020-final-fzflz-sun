# Stage card: Crit 10 — identity, permissions and server-side logging

Title / date: Crit 10 "Fly by instruments", 2026-10-17
Status at original verification: implemented and verified locally (including the production Docker image). Update, 18 October: CI and deployment of `3fd04f7` succeeded; Fly log-stream inspection and a real human two-person demo remain unrecorded.
Starting commit: `a13d462` (round 4's final, locally-verified state)

## Player problem and evidence

C10's theme is "two people your app tells apart, read from its logs."
Three things are required: (1) two independent browser identities acting
on shared state that the server actually distinguishes, (2) a documented,
server-enforced permission boundary (a client-only restriction fails the
spec), and (3) durable server-side business logging of who-did-what,
surviving past the crit session. The explicit stated failure mode: "if
you can't tell your two classmates apart in the logs, or one of them can
change what should be the other's, that's the finding."

A source review (not a symptom report — nothing is currently broken for a
real player) of `server/coop/ws.ts`, `server/index.ts`,
`server/coop/room.ts`, and `server/coop/fight-session.ts` found that
identity and authorization are **already correct**, carried over from ADR
0002 (anonymous visitors) and ADR 0005 (co-op multiplayer): both
`cc_visitor` (solo) and `cc_coop` (coop) identities are server-derived
from a hashed HttpOnly cookie, never from any client-suppliable field;
every fight action's acting player comes from the server-resolved
connection, never the message body; card ownership, per-player sequence
numbers, and private-view delivery (`sendTo`) are already correctly
scoped. What's actually missing is three concrete gaps:

1. **One real over-share**: `GET /api/coop/rooms/:code` ("peek") returns
   the full member list (id, name, color) to anyone who merely knows or
   guesses the 6-character room code — no identity check, no join
   required. Confirmed unused by the client today (only the join endpoint
   is called from `src/coop-main.ts`), so this is pure excess exposure.
2. **Zero structured business logging anywhere.** The only existing
   logging is an opt-in, default-off plain-text performance summary
   (`COOP_PERF_LOG`) and two `console.error` lines on a 500 and on a
   `finishFight` retry failure. Nothing records who created a room, who
   joined, who played a card, who was rejected and why, or any save
   operation's actor.
3. **No automated check proves the authorization boundaries the brief
   cares about.** They are true by code reading, not by a passing test —
   there is no regression protecting "A can't act as B" or "A can't read
   B's hand" from a future refactor breaking it silently.

## Desired improvement

Two independent browser identities performing real actions on one shared
room produce distinguishable, durable server log output sufficient to
narrate "who did what" without touching the UI. No endpoint reveals more
than join-time-necessary information to an unauthenticated prober. Every
authorization boundary the brief names has an automated check, not just a
code-reading claim. The identity and permission model is documented in a
new ADR with an explicit boundary table and stated costs.

## This stage includes

- A new ADR (`docs/adr/0007-coop-identity-and-permissions.md`) documenting
  the existing identity model, a permission boundary table, the logging
  approach, and explicit costs.
- Shrinking the peek endpoint's response to `{code, memberCount}`.
- A new shared logging module (`server/log.ts`): a pure, unit-testable
  JSON-line formatter plus an injectable sink, wired into `CoopServer`
  (constructor injection, same precedent as its existing optional `store`
  parameter) and directly into `server/index.ts`'s own handlers.
- Log call sites covering room create/join/peek, WebSocket
  connect/replace/disconnect, movement (throttled, never per-tick),
  encounter formation, every fight action (card/end-turn/flee) and every
  rejection with a stable reason code, fight conclusion, and the solo save
  API's put/conflict/invalid/run-start/erase operations.
- New checks at four layers: an HTTP/WebSocket `spec/coop-auth.test.ts`
  proving the authorization boundaries directly; unit tests for the
  logging module's JSON-line safety and field correctness; extended
  `server/coop/ws.test.ts` fault-injection-style tests asserting exact log
  content for real scenarios; a new `tools/coop-log-check.mjs` spawning a
  real server process and asserting real emitted log lines; a new
  `tools/coop-identity-demo-check.mjs` mechanically verifying the
  two-independent-Chrome-profile, URL-only join flow.
- A drive-by fix: wiring the already-existing, already-passing
  `tools/coop-xss-check.mjs` (built in round 4, never wired in) into
  `package.json`/CI.
- Documentation sync: `PROCESS.md`, this stage card's evidence, a new
  `reflections/crit-10.md`, and a small flagged draft addition to
  `README.md`'s co-op section.

## Later work

- A real human two-person live demo, narrated only from `flyctl logs`
  against the actually deployed Fly app — not performable by an agent.
- A real pre-flight check of `flyctl logs`' actual latency/format against
  the deployed app, which this round cannot verify without deploying.
- Loot, talents, art: separate iterations, unrelated to this round.

## Rule boundaries

- Trigger and allowed actions: unchanged — fixed-radius auto-join,
  server-authoritative turn-based combat, individual flee/death, one
  shared enemy turn per round, independent hands.
- Edge cases: a client-supplied identity-shaped field (playerId,
  ownerId, a stolen card instance id) in any message must never change
  which player an action is attributed to or who it affects. A rejected
  action must never alter any other player's, enemy's, or saved state.
  A rejection response must never reveal another player's hand, save
  data, or credentials.
- Current rule or ADR links affected: new `docs/adr/0007-...md`; no
  changes to ADR 0002/0005/0006's own content.

## Save impact

None to the persisted save shape. `FightSession.applyAction`'s
`ActionResult` gains an optional `downedPlayerIds` field (in-memory
return value only, not persisted) so a downed transition can be logged
without `ws.ts` diffing state externally.

## UI wording and feedback affected

None required. The existing invite-link/copy-link flow in
`src/coop-main.ts` already satisfies "join via URL alone" — confirmed by
direct code reading (`startJoinFlow()` reads `?code=` from the URL;
`copyLinkBtn` constructs and copies the full join link). No client-side
changes are planned for this round.

## Acceptance scenarios

| Action | Observable result |
| --- | --- |
| Two cookie jars join with the same display name | Each gets a distinct, stable actor id |
| A reconnects with the same cookie | Same identity, same room membership |
| An unauthenticated request peeks a room by code | Response has no member identities, only existence/count |
| A client with no room membership attempts the room's WebSocket upgrade | Rejected; no world state is sent |
| B joins using only a copied invite link | Join succeeds; B appears in A's roster |
| A sends a message naming B's player id or one of B's card instance ids | A's own state changes if valid; B's hand/energy/position are unchanged; the action is attributed to A or rejected, never attributed to B |
| A is sent any message during a shared fight | A never receives B's `hand` message |
| A's action is rejected for any reason | A's and B's state are both unaffected; B's next real action still succeeds |
| A crafted nickname (`<img onerror=...>`, or one containing `"`, `\n`, or a fake `}{"event":...` fragment) is used as a display name | Every log line it appears in is still exactly one valid, parseable JSON object |
| Two identities perform a real sequence of actions against a freshly spawned server process | The captured stdout contains one line per required event type, with two distinct actor ids, and no raw cookie value or the other player's card content anywhere in it |

## Checks selected and why

HTTP/WebSocket-level (`spec/coop-auth.test.ts`) for the authorization
boundaries themselves, since these are claims about what the real network
protocol allows — a unit test calling internal functions directly
wouldn't prove the wiring. Unit-level (`server/log.test.ts`) for the
logging format/safety logic, since it's pure and deserves a fast
regression test independent of any server. Extended `server/coop/ws.test.ts`
(same injectable-sink pattern already used for the fault-injection store)
for asserting exact log *content* for real in-process scenarios without
spawning a process. A new spawned-process integration tool
(`tools/coop-log-check.mjs`) specifically because `server/index.ts` is a
top-level script with no test seam the way `CoopServer` has — this is the
only way to prove its own (not just coop's) logging actually fires. A new
real-browser check (`tools/coop-identity-demo-check.mjs`) specifically
because only a real DOM with two genuinely separate browser profiles can
mechanically stand in for "two Chrome profiles, no shared cookies, join
by URL alone."

## Review evidence

- **2026-10-17, agent, local (Node 24, macOS)**: `pnpm typecheck` clean;
  `pnpm test:unit` 423 tests passing (new: `server/log.test.ts` 9 tests
  for `formatLogLine`'s JSON-line safety against normal and crafted
  input; `server/coop/ws.test.ts` extended with 6 new tests asserting
  exact log content — distinct actor ids for distinct identities, a
  stable reason code per rejection scenario, no attempted content or
  stolen card id ever logged, a crafted name producing one valid JSON
  line through the real call site); `pnpm check:evidence` passed (22
  cited commits, all resolve).
- **2026-10-17, agent, real HTTP/WebSocket against the dev server**
  (`spec/coop-auth.test.ts`, new, 10 tests): two identities sharing a
  display name get distinct stable ids; reconnect keeps identity; a
  replaced socket (same identity, second tab) cannot act while the live
  one still can; the peek endpoint's response has no member identities;
  a non-member cannot open the room's socket; a code-only invite-link
  join succeeds; a forged player id in a move message never moves
  another player; a stolen card instance id is rejected and leaves the
  victim's hand/energy untouched; a player never receives another's
  hand; a rejected action never disturbs the legitimate player's next
  real action. `pnpm check` (typecheck + full spec/unit suite) passed at
  444 tests.
- **2026-10-17, agent, a real spawned server process**
  (`tools/coop-log-check.mjs`, new): drove two real identities through
  create/join/connect, a rejected cross-player card attempt, a real card
  play, a flee, B finishing the fight, A's disconnect/reconnect, and a
  solo save write. The server's own captured stdout contained every
  required event type with two distinct actor ids, and neither player's
  raw cookie token nor the stolen card's instance id ever appeared
  anywhere in the output. Stable across repeated local runs.
- **2026-10-17, agent, real headless Chrome, two separate profiles**
  (`tools/coop-identity-demo-check.mjs`, new): tab A creates a room and
  reads its own invite link from the rendered page; tab B joins using
  only that link; both reach a shared fight via live keyboard steering;
  each plays a real card with no cross-contamination of hand/energy
  state; one flees (after B also ends their turn — readying up only
  resolves once every active player has) while the other's fight
  concludes normally; A's tab is closed and reopened on the same profile
  and resumes the same identity. Two real bugs were found and fixed in
  the check itself during development (see the correction record below),
  not in the product; stable across 5+ repeated runs after both fixes.
- **2026-10-17, agent, the actual production Docker image** (fresh
  container, `--tmpfs /data`): `APP_URL=... pnpm check` passed (444
  tests); `pnpm check:browser` passed in full (real fight, save round
  trip, visitor isolation, phone touch, resize mid-fight); `pnpm check:deploy`
  passed (`ok: true`, real save round trip, visitor isolation, test
  visitors erased); `tools/coop-identity-demo-check.mjs` and
  `tools/coop-log-check.mjs` (base-URL mode) both passed;
  `tools/coop-live-check.mjs` passed 5/5 repeated runs; `docker logs`
  against the running container confirmed real business log lines
  (`coop.room.create`, `coop.fight.ended`, etc.) appear exactly as
  `tools/coop-log-check.mjs`'s spawn-mode assertions expect — this is
  the same mechanism `flyctl logs` relies on in production.
- **Known pre-existing flake, not a regression**: `tools/coop-xss-check.mjs`
  (built in round 4, unchanged by this round — confirmed via `git diff`
  against `a13d462` showing zero changes) intermittently fails its
  "both players enter a shared fight" step, roughly 1 run in 3, both on
  the dev server and the production container, both before and
  unaffected by this round's work. Root cause: its fixed w+d diagonal
  heading can walk the pair toward a farther camp (observed: `north`'s
  three-enemy pack, ~13s away) instead of the intended, much closer
  `west-1`, exceeding its 10-second fight-formation wait budget — the
  same class of issue round 3's own correction record already documented
  for a different check (`coop-formation-2p-check.mjs`'s fixed diagonal
  geometrically missing a spawn by design). Not fixed as part of this
  round, since it's orthogonal to C10's own scope; worth a future pass
  reusing this round's live-steering fix from `coop-identity-demo-check.mjs`.
- **2026-10-17, agent, independent re-verification after this card's own
  commit** (`4d00ee7`), fresh container from the already-built `app:latest`
  image. Correction, 18 October: `verify-deploy`'s `sourceRevision` and
  `worktreeDirty` identify the checking checkout (`4d00ee7`, clean), not
  the image. Those fields cannot establish which revision the container
  was built from; no image fingerprint was recorded here. The reported
  outcomes of the earlier checks are retained: `APP_URL=...
  pnpm check` 444/444; `pnpm check:browser` full pass; `pnpm check:deploy
  -- ...` `{"ok": true, ...}`; `node tools/coop-live-check.mjs <url>` 5/5
  scenarios in one run (no flake this time); `node tools/coop-xss-check.mjs
  <url>` run 3x back-to-back against the same container: 1 fail / 2 pass,
  the failure being exactly the documented "both players enter a shared
  fight" step — consistent with the ~1-in-3 pre-existing rate recorded
  above, not a new or worse symptom; `node tools/coop-log-check.mjs <url>`
  passed in base-URL mode; `node tools/coop-identity-demo-check.mjs <url>`
  passed in full, including the reconnect-same-profile step; a direct
  `vitest run spec/coop-auth.test.ts` against this container passed all 10
  tests standalone (not just as part of the `pnpm check` bundle above).
  `docker logs` on this container, filtered to one event-type-per-line,
  showed all required event types firing with real counts across the
  session (`coop.room.create` x25, `coop.room.join` x16, `coop.room.peek`
  x2, `coop.ws.connect` x39, `coop.ws.disconnect` x38, `coop.ws.replace`
  x1, `coop.encounter.formed` x13, `coop.fight.card` x11, `coop.fight.flee`
  x17, `coop.fight.ended` x11, `coop.action.rejected` x33,
  `coop.move.summary` x33, `save.run.start` x13, `save.put.ok` x11,
  `save.put.conflict` x1, `save.put.invalid` x2, `save.erase` x3) — and the
  two-Chrome-profile demo check's own room code was directly traceable in
  this output with two distinct, stable `actorId`s across
  `coop.room.create` → `coop.room.join` → `coop.ws.connect` →
  `coop.encounter.formed` → `coop.fight.card` → `coop.fight.ended`, exactly
  the narration sequence the demo notes below describe. Container removed
  after the sweep; no state left running.
- **Not run as part of this round**: a real Fly deploy, and `flyctl logs`
  exercised against it — both require an actual deploy, which is pending
  the user's go-ahead (see Deployment below).
- **Author feedback**: none yet. **Independent/real two-person
  evidence**: none; the live crit-10 demo (two real people, narrated from
  `flyctl logs` alone) remains the explicit next step.

## Correction record

| Observed problem | Agreed rule | Fix / check | Result |
| --- | --- | --- | --- |
| `tools/coop-identity-demo-check.mjs`'s fixed w+d keyboard heading could geometrically miss the target enemy's actual spawn point, same class of issue as round 3's `coop-formation-2p-check.mjs` finding | A demo-flow check must reliably reach a fight, not rely on luck | replaced the fixed heading with live per-step steering toward the real spawn coordinate, recomputed from the tab's own reported position each iteration | stable across 5+ repeated runs |
| The same tool's plain `chrome.kill()` on "close and reopen the same profile" raced Chrome's own cookie-database flush to disk — a reopened profile could see a vanished or different `cc_coop` cookie even though the profile directory itself was kept intact | A reconnect check must prove identity survives via the real cookie, not assume it from the profile directory surviving | ask Chrome to shut down cleanly via CDP's `Browser.close` before killing the process, confirmed by comparing the raw cookie token across a close/reopen cycle directly | reconnect check passes consistently afterward |
| `tools/coop-identity-demo-check.mjs`'s flee step assumed a single click would close the fight dock instantly | Fleeing only readies up; the round (and the actual flee) only resolves once every active player has readied — the same real multiplayer rule, not a bug | the check now has B end their own turn too before asserting A's dock closed | check passes once the real resolution timing is respected |

## Reviewed implementation commits

- `928d546` — ADR 0007, the peek-endpoint fix, `spec/coop-auth.test.ts`.
- `b769e3f` — `server/log.ts` and `server/log.test.ts` (not yet wired in).
- `8db22eb` — wires logging into every real coop/solo call site.
- `43d501c` — extends `server/coop/ws.test.ts` with log-content assertions.
- `d1c28ba` — `tools/coop-log-check.mjs`; wires it and `coop-xss-check.mjs` into CI.
- `c4e6e42` — `tools/coop-identity-demo-check.mjs`.
- `59b6dbd` — adds the replaced-socket spec test.
- `78214a9` — PROCESS.md, `reflections/crit-10.md`, README.md draft addition.

## Deployment

Not deployed during the original local verification recorded above.
Read-only verification on 18 October confirmed that
[workflow 39029743347](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/actions/runs/39029743347)
subsequently checked and deployed `3fd04f7` successfully, including the
post-deploy page/assets/README/save check. This is workflow provenance,
not an application-returned build fingerprint. No deployment was performed
during the 18 October documentation review.

No inspection of the real Fly log stream or human two-person narration
exercise is recorded. The [18 October review](2026-10-18-c10-review.md)
also records new failures and source findings; this card's earlier passing
checks do not close them.

## Demo narration notes (for the live crit demo)

Once deployed, tail logs scoped to one room with:

```
mise exec -- flyctl logs -a <app-name> | grep '"roomId":"<CODE>"'
```

Event names to watch for at each demo beat: `coop.room.create` /
`coop.room.join` (both people enter); `coop.ws.connect` (both sockets
open, two distinct `actorId`s); `coop.encounter.formed` (the shared fight
starts); `coop.fight.card` / `coop.fight.endTurn` (each person's own
actions, distinguishable by `actorId`); `coop.action.rejected` (the
planned "watch what happens if one tries to act as the other" moment);
`coop.fight.flee` / `coop.fight.ended` (closing the loop). Verify the
exact `flyctl logs` output format and latency against the real deployed
app at least once before the live demo — not verified as part of this
stage, since it requires a real deploy.

## Next decision

Whether the chosen log event granularity reads clearly to a live audience
under demo time pressure, and whether a real two-person session surfaces
any boundary this round's scripted checks didn't think to cover.
