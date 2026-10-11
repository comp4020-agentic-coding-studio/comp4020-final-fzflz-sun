# Stage card: co-op reliability, performance, and discoverability

Title / date: Co-op reliability and performance pass, 2026-10-11
Status: implemented, awaiting the author's own play review
Starting commit: `12c6e3b` (end of the previous co-op stage)

## Player problem and evidence

The user actually played the co-op build from the previous stage and
reported, in their own words: the co-op entry was hard to find, and
movement was "明显卡顿、感觉帧率非常低" (visibly stuttering, feels like very
low framerate). They also asked for four specific state-correctness bugs to
be found and fixed rather than documented as known limitations, and for
the production deployment gap (co-op commits never pushed, live site still
404ing on `/coop.html`) to be corrected.

## Desired improvement

Movement looks smooth for real, not just "tests pass." A server restart or
a page refresh during a fight resumes it exactly, never loses it, never
double-applies anything. Fleeing or a second tab never leaves a stuck or
misleading screen. The co-op entry is as easy to find as "Start a run."

## This stage includes

- A real before/after performance measurement and the actual fix (client-
  side snapshot interpolation + local prediction, not a frequency change).
- All four named bugs: fight persistence across a restart, a refresh
  resetting the action-sequence counter, an individual flee not closing the
  fleeing player's own screen, a second tab racing the first tab's close
  event.
- An additional bug found while verifying the brief's own "victory +
  immediate restart" scenario: a killed enemy was never persisted as dead,
  so it came back after any restart.
- Visible co-op entry points on all five screens; tap/click-to-move; a
  bounded auto-reconnect; a persistent room-code/copy-link UI; the
  input-focus movement-key leak on the join form.
- `src/formation.ts` generalized to multiple player anchors, used for real
  enemy-slot placement and camera framing in co-op's fight view.

## Later work

- Playing the draft attack-target rule (ADR 0005) to see if it's fun.
- A full formation phase machine (forming/formed/unforming) to match solo's
  depth, instead of the current simple ease-into-slot.
- Tuning the 180ms interpolation delay against a real non-localhost network.
- `PROCESS.md`'s crit-9 write-up and `reflections/crit-9.md`: left for the
  author, per `CLAUDE.md`.

## Rule boundaries

- Trigger and allowed actions: unchanged from ADR 0005 — fixed-radius
  auto-join, server-authoritative turn-based combat, individual flee/death.
- Edge cases / rejected actions / interruption behavior: see
  [ADR 0006](../adr/0006-coop-perf-and-reliability.md) for the exact cause
  and fix of each of the four bugs plus the alive-persistence gap.
- Current rule or ADR links affected: ADR 0005's Costs section updated
  (two of its three listed costs are fixed, not gaps anymore); ADR 0006
  added for the new mechanisms.

## Save impact

Single-player: none (separate database, untouched code path). Co-op: a new
`fights` table in `coop.sqlite` holding one row per in-progress fight
(deleted when the fight ends); the existing `room_state` snapshot's enemy
rows gained an `alive` field (missing on old rows defaults to `true`, the
only safe reading of data written before this existed).

## UI wording and feedback affected

README's co-op paragraph corrected: card resolution is immediate per play,
only the enemy turn waits for everyone ready (the previous wording implied
cards themselves waited). The "Not built yet" line's mid-fight-persistence
clause is removed, since that gap is now closed. Co-op entry wording
simplified to "Play co-op with a friend →" and promoted to a real button on
every screen instead of a footnote on two of them.

## Acceptance scenarios

| Action | Observable result |
| --- | --- |
| Walk in a real browser, before and after the fix | Position changes value on ~every rendered frame instead of once per ~150ms server tick (measured: `tools/coop-perf-check.mjs`) |
| Play several cards, refresh the page | Hand, energy and round resume exactly; the first post-refresh action succeeds |
| Open a second tab with the same identity | The old tab is cleanly replaced and shown a distinct "opened elsewhere" message; the new tab works, stays online |
| One player flees while the other keeps fighting | The fleeing player's own dock closes immediately; the other's fight is untouched |
| Kill an enemy, restart the server | The enemy stays dead; no double-kill confirmation |
| Restart the server mid-fight | The fight resumes with the same hands/energy/round; neither player's cards are re-dealt |
| A legacy/corrupted "engaged" enemy with no fight record loads | It's freed back to roaming, not stuck forever; the room isn't wiped |
| Open the solo start/menu/death/victory screens | A real, visible co-op button sits next to the primary action on every one |
| Type a name containing "w"/"a"/"s"/"d" on the join screen | Nothing moves (there's no player yet, and never will be from typing) |
| Tap-to-move on a phone-emulated browser into a fight, play a card, flee | All via touch, no keyboard/mouse |

## Checks selected and why

A real measurement harness (`tools/coop-perf-check.mjs`) because the
brief explicitly forbids "tests passed" standing in for a performance
result. Dedicated real-server, real-restart reproductions for each of the
five bugs (four named plus the alive-persistence one found during
verification) because a bug about state surviving a process boundary can't
be proven by a unit test alone. Real two-browser and real mobile-emulated
(390×844, touch) headless-Chrome runs for combat, formation, and entry
points, because `CLAUDE.md`'s own lesson is that type-checking and unit
tests don't prove the thing runs. The full existing regression suite,
because this round touches `src/formation.ts`,
`server/coop/{ws,fight-session,room,store}.ts` and `src/coop-main.ts`,
all of which existing solo and co-op behavior depends on.

## Review evidence

- **2026-10-11, agent, local dev server (Node 24, macOS)**: `pnpm typecheck`
  and `pnpm test` passed throughout; final count 393 tests passing (9 new:
  3 in `server/coop/fight-session.test.ts`, 3 in `src/formation.test.ts`
  for the multi-anchor case, plus the existing suite extended).
- **2026-10-11, agent, `tools/coop-perf-check.mjs` against the dev server**:
  before the fix, rendered position changed value once every 8.78 rAF
  ticks while walking (frame timing itself a flawless avg/p95 ~16.7ms, zero
  frames over 50ms — confirming the cause was sync, not render rate); after
  the fix, position changes on essentially every frame (avg 1.02 ticks,
  211/222 samples changed). Server-side tick/persist/event-loop-lag
  instrumentation (`COOP_PERF_LOG=1`) showed sub-2ms tick durations and
  sub-1ms persistence writes throughout — never the bottleneck.
- **2026-10-11, agent, real server restarts against the dev server**: a
  mid-fight restart resumed the exact same fight id/round/enemy HP/energy/
  hand-card-ids/lastSeq, and the round genuinely advanced once both
  players readied up afterward; a legacy snapshot with an orphaned
  `"engaged"` enemy and no fight record came back freed, and could be
  engaged in a brand-new fight (impossible under the old bug); a real kill
  followed by a restart left the enemy dead (first found this broken, then
  confirmed fixed).
- **2026-10-11, agent, real WebSocket and real headless-Chrome runs against
  the dev server**: a second tab with the same identity replaces the first
  cleanly (distinct close code, generation-guard holds under both a single
  cycle and 25 rapid connect/disconnect cycles, +16KB server RSS growth —
  not proof of zero leak, but a gross one would show here); an individual
  flee delivers a dedicated `leftFight` message only to the fleeing player,
  with no `fightEnded` sent to anyone; two real browsers walking together
  (adaptive steering toward the actual camp coordinates, not a fixed
  heading) share one fight with zero page errors through the two-anchor
  formation/camera path, including a resize mid-fight; a mobile-emulated
  (390×844, touch events) browser creates a room, tap-moves into a fight,
  selects an enemy, plays a card, ends the turn, and flees — all via touch,
  zero page errors; typing "wasd" into the join screen's name field moves
  nothing (no player exists yet) and page-errors stay at zero; the solo
  start screen's co-op entry is visible, correctly linked, and appears
  before the how-to-play text.
- **2026-10-11, agent, the actual production Docker image** (`docker build`,
  `docker run` on a real named volume): `pnpm check`, `pnpm check:browser`
  (including the `prodguard` check specifically confirming `?fight=` is
  really disabled in the production build, unlike the dev server where it's
  intentionally active), and `pnpm check:deploy` all passed against the
  running container; every co-op check above re-run against the container
  (browser, combat, formation, mobile, personal-leave, dual-tab) all
  passed; a real `docker restart` on the container confirmed both the
  killed-enemy-stays-dead and mid-fight-resumes-exactly scenarios together;
  the existing `tools/persistence-check.sh` (single-player restart,
  rebuild, and v1-save migration) passed unchanged.
- **Author feedback**: none yet — this is agent-run verification, not a
  played session.
- **Independent player evidence**: none yet.
- **Remaining uncertainty**: whether the fix actually feels smooth to a
  human on a real (non-localhost) network; whether the formation/camera
  polish is good enough, or needs the fuller phase machine noted under
  Later work; the attack-target rule is still unplayed.

## Correction record

| Observed problem | Agreed rule | Fix / check | Result |
| --- | --- | --- | --- |
| The reported stutter was assumed to need a server-side fix (tick rate) | measure before changing anything; the brief explicitly forbids "tests passed" as a performance result | built `tools/coop-perf-check.mjs` first, found the real cause was client-side rendering, not server frequency | `TICK_MS` untouched; the actual fix (interpolation/prediction) is the one the measurement pointed at |
| `room.enemies.filter(e => e.alive)` quietly assumed `alive` was being persisted | any field a game-over invariant depends on must actually be checked, not assumed, when extending persistence | ran the brief's own "victory + immediate restart" scenario for real; found the enemy came back; added `alive` to the persisted shape | confirmed fixed by the same real-restart reproduction |
| A fixed w+d diagonal heading in two of my own two-browser test scripts missed the target camp by ~100px at closest approach — looked like a production-only bug the first time it failed | a test's movement heading should aim at the actual target coordinates, not an arbitrary direction that happens to work most of the time | rewrote the affected check to steer adaptively toward the real enemy spawn point (`src/world.ts`) | passes reliably against both the dev server and the production container |
| 50+ orphaned headless-Chrome processes accumulated across many check runs in one session | kill browser processes the check script spawned, and verify none are left before trusting a timing-sensitive result | `pkill -9` swept before re-diagnosing the flaky formation check (it turned out not to be the cause this time, but is a real operational risk for any long verification session) | confirmed zero stray Chrome processes before the final passing run |

## Reviewed implementation commits

- `ec65456` — performance fix: client-side interpolation/prediction.
- `3c658ca` — the four named state-correctness bugs.
- `15d5b39` — entry points, mobile input, reconnect, formation reuse.
- `bbaee09` — the additional alive-persistence bug found during verification.

## Deployment

Not deployed as part of this stage. The previous stage's co-op commits were
also still unpushed to `origin/main` as of this stage's start — confirmed
via `git fetch` (`origin/main` was 4 commits behind local `HEAD`), explaining
why the live Fly site returned 404 on `/coop.html` despite `/` being live.
Pushing and deploying is a separate, explicit decision for the author to
make, per this project's own risk posture for shared-state actions; see
`PROCESS.md`/[release records](../releases/README.md) for the actual
push/deploy step once it happens.

## Next decision

Whether to push this work (and the previous stage's) to `origin/main` and
let CI deploy it — and, once live, whether a human's actual play session
confirms the stutter is really gone and the attack-target rule feels right.
