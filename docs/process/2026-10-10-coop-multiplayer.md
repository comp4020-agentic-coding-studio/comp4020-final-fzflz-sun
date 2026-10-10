# Stage card: real-time co-op multiplayer (crit 9 base)

Status: implemented, awaiting the author's own play review. Date: 2026-10-10,
Australia/Sydney.

Written by the agent while building this stage, per the working loop in
[docs/process/README.md](README.md). The fields below are filled with what
was actually run; "author feedback" and "independent player evidence" are
left as the template says — nobody has played this yet.

## Player problem and evidence

`PROCESS.md`'s own "Next" section: "Crit 9 makes the game multi-user and
real-time... I haven't decided the answer yet, and that comes before any
code." `README.md` listed "anything shared between players" under "Not built
yet." No in-repo code referenced more than one player anywhere.

## Desired improvement

Two people can create or join one expedition (no account), see each other
move on one real shared map within about a second, get pulled into the same
fight by a fixed proximity rule, and fight it together — each with their own
hand and HP, sharing the enemies — with individual flee and death, and a
short reconnect window instead of a silent permanent stall.

## This stage includes

- Shared rooms and identity, separate from single-player saves.
- Real-time shared exploration (shared enemy roam state, server-validated
  movement).
- Fixed-radius auto-join (`PLAYER_JOIN_RADIUS = 320`) and enemy occupancy
  (one fight per enemy, by construction).
- Server-authoritative turn-based combat: per-player hands/energy, a common
  player phase, targeted attacks, individual flee/death, sequence-number
  idempotency.
- A 30-second reconnect window that resolves to a normal, costed flee if it
  lapses.
- A plain, functional co-op client (`coop.html`) — not visually polished.

## Later work (explicitly not in this stage)

- Mid-fight state persistence across a server restart (see ADR 0005's
  costs section).
- Visual polish: formation layout, camera framing, card art for co-op.
- Accounts, loot, talents, art (unchanged from before this stage).
- Playing the draft attack-target rule (ADR 0005) to see if it's actually
  fun, or needs changing.

## Rule boundaries

- Trigger: unchanged single-player rule (`src/encounter.ts`'s `selectRoster`,
  `JOIN_RADIUS`), generalized to resolve its anchor from whichever player an
  enemy is actually chasing (`targetId`), not "the nearest."
- Co-op-only addition: `PLAYER_JOIN_RADIUS` pulls in free/alive/online
  teammates by distance to the anchor alone.
- Edge cases covered by tests (`src/encounter.test.ts`): exact radius
  boundary, offline/dead/busy exclusion, no chain expansion, two players
  triggering two far-apart enemies in one tick forming two fights.
- `docs/adr/0005-coop-multiplayer.md` records the architecture and the one
  still-draft rule (attack targeting).

## Save impact

None to single-player saves (separate database, separate code path). New,
co-op-only: `coop.sqlite` (rooms, members, a periodic world snapshot).
Active-fight state is explicitly not part of that snapshot (see ADR 0005's
costs).

## UI wording impact

New page (`coop.html`), linked from the single-player start/menu/welcome
screens as "Play co-op with a friend (beta)." `README.md`'s "This version"
section has a new co-op paragraph, marked as a draft for the author to
confirm or rewrite, and the "Not built yet" line was updated to drop "shared
between players" and add the mid-fight-persistence gap.

## Acceptance scenarios

| Action | Observable result |
| --- | --- |
| Create a room, share the link, a friend opens it | Both see each other moving within about a second, no page reload |
| Walk together into a camp's aggro range | Both pulled into one fight; a teammate standing far off is not, and can trigger their own fight |
| Two players end their turn | Enemies act exactly once, only after the second End Turn |
| One player clicks Flee | The round's shown enemy actions still land on them; they leave afterward if they survived; the other keeps fighting the same enemies |
| One player's tab is closed mid-fight | After 30s without reconnecting, they're resolved as a normal flee; the other was never blocked |
| The whole party is downed | The fight ends; surviving enemies return to roaming at their current HP |
| All enemies in a fight are killed | The fight ends in victory immediately, without needing an End Turn |

## Checks selected and why

Pure-rule unit tests (`src/roam.test.ts`, `src/encounter.test.ts`,
`src/combat.test.ts`, `server/coop/room.test.ts`,
`server/coop/fight-session.test.ts`) because the roster/targeting/turn rules
are exactly the kind of thing a playtest correction later needs a regression
test for, per `CLAUDE.md`. Every existing single-player `tools/playtest.mjs`
suite, because the shared engine refactor (one-player-list instead of one
player) touches code every solo fight already depends on. Real WebSocket
clients and real headless-Chrome runs against both the dev server and the
actual production Docker image, because `CLAUDE.md`'s own stated lesson is
that type-checking and unit tests don't prove the thing runs.

## Review evidence

- **2026-10-10, agent, local dev server (Node 24, macOS)**: `pnpm typecheck`
  and `pnpm check` (`vitest run`, which includes `spec/`) passed throughout
  all four phases; final count 387 tests passing. `node tools/balance.ts 500`
  reported 98.2% whole-run survival (matching the pre-change ~98.7% baseline
  within normal sample variance), confirming the `combat.ts` generalization
  didn't change single-player damage math.
- **2026-10-10, agent, `tools/playtest.mjs` against the dev server**:
  `combat,save,viewports,monsters,groups,roam` — 229 checks, 0 failures.
- **2026-10-10, agent, real WebSocket clients against the dev server**:
  auto-join (anchor + lockstep teammate join one fight, a third walking away
  stays free and triggers nothing), full solo victory, two-player
  ready-gating, individual flee leaving the session alive for the other
  player, and a real, unshortened 30-second reconnect-window lapse (no flee
  message ever sent; the player was still correctly freed).
- **2026-10-10, agent, real headless Chrome against the dev server**: two
  independent browser profiles joining one room, seeing each other move, zero
  page errors; a separate run walking into a fight, selecting an enemy,
  playing a card (hand shrinks in the DOM), ending the turn, zero page
  errors throughout.
- **2026-10-10, agent, the actual production Docker image** (`docker build`,
  `docker run`): found and fixed a real production-only bug this way — the
  Dockerfile's client-build stage didn't copy `coop.html`, so `pnpm build`
  failed in the image even though it worked locally (the dev server serves
  any `.html` file in the repo root; the production build stage only had the
  files it was explicitly told to copy). After the fix: `pnpm check`,
  `pnpm check:browser`, `pnpm check:deploy` all passed against the running
  container; the real WebSocket combat run passed against the container too;
  room/player position survived both a `docker restart` and a full
  `docker build --no-cache` redeploy on a real named volume (not `--tmpfs`,
  which does not survive a restart — confirmed directly, and corrected a
  wrong assumption in an earlier draft of this check); the existing
  single-player `tools/persistence-check.sh` still passes unchanged against
  the updated Dockerfile.
- **Author feedback**: none yet — this is agent-run verification, not a
  played session.
- **Independent player evidence**: none yet; `docs/process/playtest.md`
  remains a template for this stage.
- **Remaining uncertainty**: whether the auto-join radius and the
  lowest-HP attack-target rule actually feel right in real play; whether two
  people on a slow or lossy real network (not localhost) see the ~1s
  propagation the brief asks for; mid-fight persistence (see "later work").

## Correction record

| Observed problem | Agreed rule | Fix / check | Result |
| --- | --- | --- | --- |
| `node --watch`'s default scope includes `.data/`; co-op's periodic SQLite writes made a restart-loop far easier to trigger than single-player's occasional ones ever did | dev watch mode should only watch source, never data | `package.json`'s `dev` script scoped to `--watch-path=server --watch-path=src` | Confirmed stable (zero restarts) through sustained real coop activity afterward |
| Enemy `targetId` could be unset on a unit whose `state` was set directly (a test fixture, or a future migration path) rather than through noticing | a chasing unit with no resolvable target re-acquires the nearest player present, rather than leashing against nobody | `src/roam.ts`'s reacquire pass before the disengage checks | Existing `src/roam.test.ts` cases (which set state directly) kept passing unchanged |
| An attack's shown target falling earlier in the same enemy-turn resolve (co-op only — can't happen solo) had no defined behavior | the attack voids; it never retargets | new `attackVoid` event in `src/combat.ts`, tested in `src/combat.test.ts` and `server/coop/fight-session.test.ts` | Matches the brief's explicit requirement |
| Dockerfile's build stage didn't copy `coop.html` | the client build stage must copy every HTML entry point, not just `index.html` | `Dockerfile` | Production build succeeds; verified by actually building and running the image |
| `--tmpfs /data` does not survive `docker restart` (confirmed by direct test) | use a real named volume for any restart-persistence check, matching `tools/persistence-check.sh`'s own existing pattern | re-ran the restart/rebuild check on a Docker volume | Room and player state correctly survived both a restart and a full image rebuild |

## Reviewed implementation commits

- `a1d639a` — phase 1: rooms, identity, shared real-time exploration.
- `e5edc9c` — phase 2: fixed-radius auto-join, roster snapshot, enemy
  occupancy.
- `bcfdc9e` — phase 3: server-authoritative multiplayer combat.
- (this stage's phase 4 commit — reconnect window, Dockerfile fix,
  production verification, this card and the ADR — is the commit that adds
  this file; see `PROCESS.md`'s own commit links for the exact hash once
  the author finalizes it.)

## Deployment

Not deployed to Fly as part of this stage. The production Docker image was
built and run locally for verification only (see Review evidence above); a
real deployment and live Fly smoke are a separate release-record step, per
[docs/releases/README.md](../releases/README.md).

## Next decision

Whether the draft attack-targeting rule (ADR 0005) survives contact with
actual play, and whether mid-fight persistence is worth building before the
crit 9 cutoff or is an acceptable, disclosed gap like the existing
close-tab-mid-fight soft exploit `PROCESS.md` already names for solo play.
