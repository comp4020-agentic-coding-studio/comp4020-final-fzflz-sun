# Stage card: Crit 10 — identity, permissions and server-side logging

Title / date: Crit 10 "Fly by instruments", 2026-10-17
Status: proposed
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

(Filled in as each piece lands.)

## Correction record

| Observed problem | Agreed rule | Fix / check | Result |
| --- | --- | --- | --- |
| (filled in during implementation) | | | |

## Reviewed implementation commits

(filled in once committed)

## Deployment

Not deployed as part of writing this card; see the end-of-stage report.
`flyctl logs` has not yet been exercised against the real deployed app —
required once before the live demo, not performable locally.

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
