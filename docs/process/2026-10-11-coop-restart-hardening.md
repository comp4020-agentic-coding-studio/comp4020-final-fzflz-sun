# Stage card: co-op fight-restart hardening (round 3)

Title / date: Co-op fight-restart hardening, 2026-10-11
Status: implemented, awaiting the author's own play review
Starting commit: `8dbcd94`

## Player problem and evidence

Round 2 (`ec65456`..`bb8d93d`, plus the follow-up `b2896df`) shipped real
fight persistence across a server restart and fixed a player-HP/ready gap
Codex's source review found. A further, more careful look at the same
restore path — reading the current source directly, not assuming the prior
"resumes exactly" claim still holds in full — found four more real gaps,
all specifically in restart/recovery:

1. No legacy-format compatibility: a fight row written by the code that
   existed between `3c658ca` and `b2896df` has no `hp`/`ready` fields;
   restore reads them unconditionally, writing `undefined` into live state.
2. Fight-ID collision: `CoopRoom.nextFightN` resets to 1 on every cold load
   and never advances past a restored fight's id, so the next genuinely new
   encounter after a restart can collide with an already-resumed fight id.
3. A fled player can be re-locked: the room-restore loop sets `fightId` and
   arms a reconnect timer for every id in the fight's original fixed
   roster, not the fight's actual current membership (which already
   correctly excludes anyone who'd fled).
4. Fight-end persistence isn't atomic and notifies before persisting:
   `deleteFight` and the final room snapshot write are two independent,
   unwrapped SQLite statements, and `fightEnded` is sent to clients before
   either happens.

## Desired improvement

A restart mid-fight recovers correctly regardless of which code version
wrote the last persisted fight row; a restart never produces two different
fights sharing one id; a player who successfully fled before a crash comes
back free, not re-locked into the fight they left; and a fight's terminal
state (win/wipe/abandon) is durable as one atomic unit before anyone is
told it happened.

## This stage includes

- Explicit versioning + a real migration path for persisted fight data.
- A fight-id collision guard across restarts.
- Correcting the restore loop to use actual current fight membership, not
  the original fixed roster, for re-locking players and arming timers.
- Atomic fight-end persistence (`CoopStore.finishFight`), with client
  notification moved to after that commit succeeds.
- Turning the directly-relevant `.local/`-only checks into real,
  repo-committed tools: `tools/coop-live-check.mjs` (CI-wired, no restart
  needed) and `tools/coop-restart-check.sh` (real `docker restart` on a
  named volume, local/pre-release only, mirroring
  `tools/persistence-check.sh`'s own convention).
- A co-op section in `docs/process/playtest.md` for an actual two-person
  session.

## Later work

- A real human two-player playtest session (left as "awaiting playtest").
- A real Fly-level restart check (only the production Docker image locally
  has been restart-tested, matching this project's existing practice).
- Any further multiplayer balance/UX work is out of scope for this round.

## Rule boundaries

- Trigger and allowed actions: unchanged — fixed-radius auto-join,
  server-authoritative turn-based combat, individual flee/death, one
  shared enemy turn per round.
- Edge cases / rejected actions / interruption behavior: a migrated legacy
  player who had committed to flee (`pendingFlee`) is restored `ready:
  true` and cannot act again; one who hadn't is restored `ready: false` —
  an explicit, documented limit (a real historical End Turn can't be
  reconstructed from data that never recorded it). A downed (not fled)
  player is never mistakenly freed by the roster-membership fix.
- Current rule or ADR links affected: `docs/adr/0006-coop-perf-and-reliability.md`
  gets a hardening addendum, not a new ADR number (no new architectural
  decision, just correctness hardening of the existing one).

## Save impact

`PersistedFight` gains an explicit `version` field. Rows written before
this round (no `version`) are migrated on read, never rejected outright
unless structurally broken (in which case the affected fight's enemy is
freed back to roaming via the existing orphan-cleanup path — the room is
never wiped). No single-player save impact.

## UI wording and feedback affected

None expected — these are restart-recovery internals with no new
player-visible behavior in the normal (non-crash) case.

## Acceptance scenarios

| Action | Observable result |
| --- | --- |
| Restore a hand-crafted legacy-shaped fight row (no `version`/`hp`/`ready`) | Player state is valid (no `undefined`/`NaN`); the room stays usable |
| ...where that player had committed to flee (`pendingFlee`) | Restored `ready: true`; cannot play another card |
| A new-format player who'd already ended their turn | Restored `ready: true` (unchanged from `b2896df`); cannot act again |
| A structurally broken fight row | That fight's enemy is freed to roaming; the rest of the room is untouched |
| A restarts in `f1`; B, far away, triggers a new encounter after the restart | The new fight gets a different id; neither session is overwritten |
| A and B share a fight; A successfully flees; restart | A's `fightId` is `null`, can move/trigger a new fight, gets no stale fight view or reconnect timer; B's fight continues unaffected |
| A downed (not fled) player, restart | Still shown as part of the fight, still can't act, not freed |
| A fight ends (win, wipe, or abandon); restart immediately after | Either the complete pre-end or complete post-end state is observed — never deleted-fight-row-but-stale-room or the reverse |

## Checks selected and why

Unit tests for the migration function, the fight-id reservation, and
`finishFight`'s atomicity/error-propagation, because these are pure-enough
logic that a fast regression test is the right tool (`CLAUDE.md`'s own
rule). Real two-client live scenarios (`tools/coop-live-check.mjs`) for
anything involving actual WebSocket dispatch/room wiring, which a
constructor-level unit test can't exercise. Real `docker restart` on a
named volume (`tools/coop-restart-check.sh`) for every claim that depends
on an actual process boundary — a unit test calling `new FightSession(...,
restore)` directly proves the restore *logic* but not that `ws.ts`/
`store.ts` actually wire it correctly end to end.

## Review evidence

- **2026-10-11, agent, local (Node 24, macOS)**: `pnpm typecheck` and
  `pnpm test` passed throughout; final count 409 tests passing (16 new:
  6 migration tests, 1 downed-vs-fled restore test, 2 `reserveFightId`
  tests, 3 `finishFight` tests, all in `server/coop/*.test.ts`).
  `pnpm check:evidence` passed.
- **2026-10-11, agent, real server restarts against the dev server**:
  fix 2 (fight-id collision) — A's fight resumed as `f1`; B, genuinely far
  away, triggered a brand-new encounter after the restart and got `f2`,
  never colliding; A's session was unaffected by B's new fight forming.
  fix 3 (fled player) — A, who'd successfully fled before the restart,
  came back with `fightId: null`, no fight view, could move immediately;
  B's fight resumed with the same id, correctly still showing B active.
  fix 4 (atomic finish) — the existing victory-restart check
  (`.local/coop-victory-restart-check.mjs`) still passes unchanged after
  the `finishFight` refactor: a real kill stays dead across a restart.
  fix 1 (legacy compat) — a real fight row, played normally then stripped
  of `version`/`hp`/`ready` directly in the SQLite file (simulating one
  genuinely written by pre-`b2896df` code), loaded with valid HP/energy/
  hand after a restart and continued play with zero errors; a second
  variant with a mid-flight `pendingFlee` (A clicked flee, B deliberately
  never acted, so the round never resolved before the restart) came back
  with that player correctly restored `ready: true` and rejected on a
  further card-play attempt.
- **2026-10-11, agent, the actual production Docker image, real
  `docker restart` and a full rebuild+fresh-container cycle on a named
  volume** (`tools/coop-restart-check.sh`, consolidating the above into one
  repeatable script): all five scenarios (fight-id collision, fled-player,
  victory-restart, legacy compat, legacy compat with mid-flight
  `pendingFlee`) passed against a real restart, and the victory-restart
  scenario was re-verified again after a full `docker build --no-cache` +
  fresh container on the same volume (what a Fly redeploy does).
  `tools/coop-live-check.mjs` (the non-restart scenarios: independent
  cards/common end-turn, reconnect-seq continuity, individual flee) was
  also run against this same production container and passed, matching
  exactly how CI now runs it.
- **2026-10-11, agent, existing regression suites re-run against the new
  code**: `.local/coop-browser-check.mjs`, `.local/coop-formation-2p-check.mjs`,
  `.local/coop-mobile-check.mjs` (round 2's two-browser/mobile/formation
  checks), and `node tools/playtest.mjs --headless --suite=combat,save`
  (single-player) all passed unchanged.
- **Author feedback**: none yet — this is agent-run verification.
- **Independent player evidence**: none yet; `docs/process/playtest.md`'s
  new co-op section remains a template for this stage.
- **Remaining uncertainty**: whether a real human two-player session
  confirms these fixes hold up outside scripted scenarios; a real Fly-level
  restart (only the local production image has been restart-tested, same
  as this project's existing single-player practice).

## Correction record

| Observed problem | Agreed rule | Fix / check | Result |
| --- | --- | --- | --- |
| `fightView()`'s player list always includes the full original roster (with `fled: true`), not just active members — my own first draft of the fled-player restart check wrongly asserted it should shrink to one player | this is correct, pre-existing, intentional behavior (so the UI can show "so-and-so fled"), not a round-3 regression — a test assumption, not a product bug | reread `fight-session.ts`'s `fightView()`, fixed the check's assertion to verify `fled: true`/`false` per player instead of array length | `tools/coop-restart-check.sh`'s fled-player scenario passes correctly |
| A two-browser CDP test (`coop-formation-2p-check.mjs`, round 2) intermittently failed to trigger a fight against a fresh server for this round's regression pass | a fixed 45° w+d diagonal heading geometrically misses `west-1`'s actual position by design, not a flake — same root cause already documented in round 2's own stage card | no change needed this round: the test already uses adaptive steering toward the real spawn coordinates (round 2's own fix) | reran cleanly; confirmed not a round-3 regression |

## Reviewed implementation commits

- `3f0335c` — the four fight-restart hardening fixes, with unit tests.
- `c4cf206` — `tools/coop-live-check.mjs` (CI-wired) and
  `tools/coop-restart-check.sh`/`.mjs` (local/pre-release), plus the
  `docs/process/playtest.md` co-op section.
- (this stage's docs commit — ADR 0006 addendum, the Codex review
  cross-reference, and this card — is the commit that adds this file; see
  the repository's own commit log for the exact hash.)

## Deployment

Not deployed as part of this stage. See the end-of-stage report for actual
push/deploy status.

## Next decision

Whether a real human two-player session confirms these fixes hold up in
practice, and whether a real Fly-level restart (not just the local
production image) is worth doing before the next crit.
