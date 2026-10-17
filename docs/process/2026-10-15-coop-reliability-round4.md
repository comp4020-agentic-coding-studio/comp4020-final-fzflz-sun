# Stage card: co-op reliability round 4 (XSS, stale messages, card-id collision, finishFight failure)

Title / date: Co-op reliability round 4, 2026-10-15
Status: implemented and verified locally, uncommitted; awaiting the author's own play review
Starting commit: `1b0b10d` (round 3's final, deployed state)

## Player problem and evidence

Round 3 (`3f0335c`, `c4cf206`, `1b0b10d`) hardened fight-restart recovery
and shipped to production. A further review — confirmed by reading the
current source directly, not inferred from any symptom report — found
four more real issues, none caught by the 409 passing unit tests or the
round-3 live/restart checks:

1. **Nickname XSS**: `src/coop-main.ts`'s `renderFight()` builds an enemy
   button's "→ &lt;target name&gt;" text via `innerHTML`, with the room
   member's display name interpolated raw. The server's `cleanName()`
   only trims/truncates — no escaping anywhere. A crafted nickname like
   `<svg/onload=...>` would execute in any client viewing a fight where
   that player is targeted.
2. **A stale `fightEnded` wipes an unrelated new fight's UI**: the server
   notifies a fight's *original* roster (`session.initialPlayerIds`,
   never shrinks) when it ends, not its *current* membership. A player who
   fled fight f1 and is legitimately fighting in a new f2 still gets f1's
   `fightEnded`, and the client applies it unconditionally — no `fightId`
   check — wiping their real f2 state.
3. **Card-instance-ID collision after a restart**: the card-id counter is
   a single process-wide counter that resets on restart, with no
   reservation mechanism analogous to the existing `reserveFightId()` for
   fight ids. A restored hand's ids can collide with a freshly-generated
   one, and `playCard`'s `indexOf` lookup would silently resolve to the
   wrong card.
4. **A failed `finishFight` commit still reports success**: the retry
   loop's `committed` flag only gates the debounce timestamp update — the
   `fightEnded` broadcast and in-memory session deletion both run
   unconditionally even if the database commit never happened, with no
   pending/retry mechanism and a real path to a room-state/fight-table
   inconsistency via the separate periodic debounced snapshot write.

Existing checks were also found to have real gaps, not just room for
improvement: `tools/coop-live-check.mjs` never sends an actual `playCard`
in any scenario; its "enemy acts once" check is a loose OR, not an exact
count; its reconnect-seq scenario never validates a real nonzero prior
seq. `tools/coop-restart-check.mjs`'s `verifyVictory` would pass vacuously
if zero `state` messages ever arrived.

## Desired improvement

A crafted nickname never executes in any client. A message about one
fight never mutates a client's view of a different, unrelated fight —
including across a disconnect/reconnect. A restored hand's card ids never
collide with newly-generated ones, even across concurrent rooms. A failed
database commit at fight-end is never reported to players as success, and
recovers correctly once the underlying fault clears.

## This stage includes

- An escaping fix for the one real innerHTML sink, with a shared,
  exported escape helper (none currently exists reusable by both solo and
  co-op).
- Server + client fightId-scoped handling for `fightEnded`/`leftFight`,
  plus closing the related reconnect-while-fight-already-concluded gap.
- A `reserveCardId()` mirroring the existing `reserveFightId()` pattern.
- A pending/retry mechanism for `finishFight` failures that never
  falsely notifies, protects the debounced snapshot write from diverging
  while pending, and recovers once the underlying fault clears.
- Strengthened `tools/coop-live-check.mjs` and `tools/coop-restart-check.mjs`
  assertions, plus new scenarios for fixes 2 and 3.
- A real headless-Chrome check for the XSS fix.

## Later work

- A real human two-player playtest session (still "awaiting playtest").
- A real Fly-level restart check (only the local production image has
  been restart-tested, same as prior rounds).
- Loot, talents, art: separate iterations, out of scope here.

## Rule boundaries

- Trigger and allowed actions: unchanged — fixed-radius auto-join,
  server-authoritative turn-based combat, individual flee/death, one
  shared enemy turn per round.
- Edge cases: a message about fight X must never mutate a client's view
  of fight Y, even if X was that same client's own previous fight. A
  pending (uncommitted) fight-end must block further actions against that
  specific fight and must not be overwritten by the room's own periodic
  snapshot debounce until it resolves.
- Current rule or ADR links affected: a further addendum to
  `docs/adr/0006-coop-perf-and-reliability.md` (no new ADR number).

## Save impact

None to the persisted shape beyond what round 3 already established
(`version`, `hp`, `ready` on `PersistedFight`). The card-id fix changes
only in-memory counter state, not the persisted schema. A finish-pending
fight is represented in memory only (the fight row simply isn't deleted
yet) — no new column.

## UI wording and feedback affected

None expected for normal play. A player whose fight-end is pending a
retry may briefly see a "finishing…" status rather than an instant
confirmation — to be worded during implementation if actually needed.

## Acceptance scenarios

| Action | Observable result |
| --- | --- |
| A room member's name contains `<img src=x onerror=...>` | Displayed as literal text everywhere, including as an attack-intent target name; no element is created, no script executes |
| A, B share f1; A flees into f2; B finishes f1 | A's f2 fight view, hand, and selected target are untouched |
| A disconnects mid-fight; B finishes it while A is away; A reconnects within the window | A's client shows no stale fight dock; A can move/explore |
| A hand with a Focus card is saved; the process is genuinely restarted; Focus is played | The newly-drawn card has an id distinct from every restored card's id, in this room and in any other concurrently-restored room |
| `finishFight` is forced to fail twice | No `fightEnded` is sent; the session survives; the room's periodic snapshot write does not diverge from the still-present fight row |
| The underlying fault clears | The next retry commits and notifies exactly once |

## Checks selected and why

Real headless-Chrome for the XSS fix, since only a real DOM proves no
injection occurred. Real two-client WebSocket scenarios for fix 2 (needs
genuine fight-formation/membership transitions a unit test can't drive
end-to-end). A real cross-process restart for fix 3 (same reasoning as
round 3: a same-process `serialize`/`restore` call proves the logic, not
that the server actually wires it this way, and the counter's
process-wide scope specifically needs a real restart to exercise). A
fault-injection test for fix 4 at the integration level, explicitly not a
real-restart test (a real restart can't easily force a mid-commit SQLite
failure).

## Review evidence

- **2026-10-15, agent, local (Node 24, macOS)**: `pnpm typecheck` clean;
  `pnpm test:unit` 408 tests passing in 16 files (new: `src/coop-protocol.test.ts`
  for `escapeHtml`, `server/coop/ws.test.ts` with 4 fault-injection tests for
  `finishFight` failure, plus `reserveCardId` and `finalPlayerIds` tests in
  `server/coop/fight-session.test.ts`); `pnpm check:evidence` passed.
- **2026-10-15, agent, real WebSocket clients against the dev server**
  (WebSocket-integration level, not a browser): `tools/coop-live-check.mjs`,
  now 5 scenarios, all passed. A and B each play a real card with exact
  hand/energy/block assertions; a real nonzero `lastSeq` (2) is recovered on
  reconnect and a replayed stale seq is rejected without side effect; the
  stale-`fightEnded` repro (A flees f1 into f2, B finishes f1) leaves A's f2
  view, hand and actions intact; a fight concluding while A is disconnected
  gives `hello.fightId === null` on reconnect. Earlier stability scans of
  20, 8 and 5 repeated runs found and fixed several flaws in the check
  itself (see the correction record).
- **2026-10-15, agent, real headless Chrome** (browser level):
  `tools/coop-xss-check.mjs` passed 8 of 8: a crafted name containing an
  `<img onerror>` payload is never created as an element and never
  executes on either client, and a normal Chinese/space name displays
  as typed. The payload only logs a page-local marker; everything ran
  against a local server and discarded identities.
- **2026-10-16, agent, the actual production Docker image, real
  `docker restart` and a full `--no-cache` rebuild+fresh-container cycle on
  a named volume** (`tools/coop-restart-check.sh`): all five scenarios
  passed against a real restart — fight-id collision (A's fight resumed as
  `f1`, B's genuinely new post-restart encounter got `f2`, neither session
  overwritten), fled-player (A, who'd fled before the restart, came back
  with `fightId: null` and could move immediately; B's fight resumed
  correctly), victory-restart (the killed enemy `west-1` stayed dead),
  legacy compatibility (a fight row stripped of `version`/`hp`/`ready`
  restored with valid HP/energy and continued play; a second variant with a
  mid-flight `pendingFlee` restored `ready: true` and correctly rejected a
  further card play), and the new **card-instance-id collision scenario**:
  two separately-restored rooms' hands both kept their exact pre-restart
  card instance ids after a genuine process restart. (Room A's restored
  hand happened to hold no Focus card to draw with afterward — Focus
  exhausts rather than discards, so this sub-check didn't get to run this
  time — but the exact-id-match assertions above it still exercise the
  `reserveCardId` fix directly, across two concurrent rooms, which is what
  proves the counter isn't accidentally single-room scoped.) The
  victory-restart scenario was re-verified again after the full
  `docker build --no-cache` + fresh container on the same volume, matching
  what a Fly redeploy does.
  An earlier attempt at this same check hung for over two hours, then
  Docker Desktop itself crashed outright, both traced to Docker Desktop's
  credential helper (`docker-credential-desktop`) becoming unresponsive —
  an environment fault requiring a full Docker Desktop restart, not a test
  result, and not a defect in the fixes themselves.
- **2026-10-16, agent, the actual production Docker image (fresh container,
  `--tmpfs /data`)**: `APP_URL=http://localhost:8090 pnpm check` passed
  (419 tests: 408 unit + the `spec/` suite against the running app);
  `pnpm check:browser` (`tools/playtest.mjs --headless --suite=prodguard,viewports`)
  passed in full, including the real-fight, save-round-trip, second-visitor-
  isolation, phone-touch and resize-mid-fight scenarios; `pnpm check:deploy`
  passed (`ok: true`, real save round trip, visitor isolation, test visitors
  erased). `tools/coop-live-check.mjs` and `tools/coop-xss-check.mjs` were
  also re-run against this same production container specifically (closing
  the gap flagged in an earlier draft of this card, where only the dev
  server had been checked) — all scenarios and all 8 XSS checks passed
  unchanged.
- **Not run as a real-restart test**: the `finishFight` failure path.
  A real restart cannot force a mid-commit SQLite failure, so it is covered
  only by the integration-level fault-injection test.
- **Author feedback**: none yet. **Independent player evidence**: none;
  the co-op section of `docs/process/playtest.md` remains awaiting a real
  two-person session.

## Correction record

| Observed problem | Agreed rule | Fix / check | Result |
| --- | --- | --- | --- |
| My first server filter for stale `fightEnded` checked `room.players.get(pid)?.fightId === fightId`, which is always false because `finish()` has already nulled every member's `fightId` | Notify exactly who was present when the fight concluded | Added `FightSession.finalPlayerIds`, captured as the first statement in `finish()`; caught before committing | unit test for `finalPlayerIds`; live scenario 4 passes |
| `tools/coop-live-check.mjs`'s `steerToward` was satisfied by A's own old f1 `fight` message still in history | A new fight must differ from the fight just left | added an `avoidFightId` parameter | scenario 4 no longer passes vacuously |
| Card-picking helper sometimes chose an unaffordable card, or a single-target card with no target, so the server rejected it and exact hand/energy deltas broke | Assertions stay exact, not inequalities | helper filters by energy and supplies a real target; a lethal Strike on the 6 HP `west-1` is skipped or tolerated where the fight must stay open | 20-, 8- and 5-run stability scans clean |
| `ws.test.ts` setup omitted `store.createRoom` in two tests, and one test's own retry pass consumed the single injected failure | Tests must keep the fault alive through the tick's own retry | added `createRoom`; call `failNext(1)` again before the tick | 4 of 4 pass |

## Reviewed implementation commits

(filled in once committed; no commits made yet as of writing)

## Deployment

Not deployed as part of writing this card; see the end-of-stage report.

## Next decision

Whether a real human two-player session confirms these fixes hold up in
practice, and whether this is sufficient reliability hardening to stop
hunting for further restart/message-ordering edge cases before the next
crit, versus continuing another pass.
