# ADR 0006: Co-op's first real play surfaced sync, state and discovery bugs — fixed at the cause, not documented as gaps

Status: accepted, 2026-10-11.

## Context

[ADR 0005](0005-coop-multiplayer.md) shipped co-op as four commits that were
never played by an actual person before this round. The user's own report
after a real session: the co-op entry was hard to find, and movement felt
like "very low framerate." The brief that followed also named four concrete
state-correctness bugs to find and fix, not just list as known limitations.
This ADR records the causes found and the fixes made, each backed by a real
measurement or a real server-restart/two-browser reproduction — never an
assumption.

## Decision

**The stutter was a sync problem, not a frame-rate problem.** A new
measurement harness (`tools/coop-perf-check.mjs`, real headless Chrome, an
independent `requestAnimationFrame` probe injected before any page script)
showed Chrome's actual render loop was a flawless 60fps throughout — zero
frames over 50ms, even during combat UI churn. The real cause:
`src/coop-main.ts` hard-set every position straight from the server's
`state` snapshots, which only arrive every `TICK_MS` (150ms) — so the
displayed position changed value once every ~8.8 rendered frames, not every
frame. Fix: remote players/enemies are rendered by interpolating between
their last two snapshots, ~180ms in the past (never extrapolating past the
newest one); the local player predicts its own movement every frame from
input and is nudged toward the server's authoritative position each
snapshot, snapping only on a real discontinuity (spawn, a fight
starting/ending, or a >80px correction). After the fix, the same harness
shows position changing on essentially every rendered frame (avg 1.02 rAF
ticks between changes, was 8.78) with frame timing unchanged — `TICK_MS` was
never touched, because the measurement showed it didn't need to be. Render
work was also genuinely wasteful and is now keyed-DOM-reuse instead of
clear-and-rebuild, and the server's paired `fight`+`hand` messages for one
action are coalesced into a single scheduled render instead of two.

**Fight state is now fully persisted, closing ADR 0005's biggest disclosed
gap.** A new `fights` store table holds `FightSession.serialize()`'s output
(round, per-player hands/energy/card-instance-ids, enemy hp/intent/downed,
pending-flee) and is written after every action that fully completes (one
atomic write per action, never mid-effect) and immediately on a fight's
opening deal. Room load reconstructs any in-progress fight via a
restore-aware `FightSession` constructor — no re-dealing, no re-damaging, no
re-confirmed kills — and arms the existing 30-second reconnect timer for
every participant, since nobody has an open socket yet right after a cold
start; a legacy snapshot or a corrupted fight row that still claims
`"engaged"` with nothing to resume is freed back to roaming instead of
leaving it stuck forever or wiping the room. A related gap found during this
verification (not one of the four named bugs, but caught by the brief's own
"victory + immediate restart" check): the room-level snapshot never
persisted `alive` at all, so a confirmed kill came back after any restart.
Fixed the same way — added to the persisted shape, defaulting to alive for
data written before the field existed.

**Three more bugs, each with a root cause distinct from the others, despite
looking similar on the surface:**
- *Refreshing mid-fight got your next action rejected as stale.* The
  client's action-sequence counter always restarts at 0 on reload; the
  server's remembered count doesn't. Fixed by having the per-player `hand`
  view report the server's real `lastSeq`, which the client adopts (never
  backwards) before its next send; a rejected action also now gets the
  authoritative view pushed back automatically, so a client can't get wedged
  needing a lucky guess to resync.
- *Fleeing while your party kept fighting left your own screen stuck.*
  There's a `fightEnded` message for when the whole fight ends, but nothing
  told the one player who personally left (and whose `FightSession` entry
  was already deleted) that they'd left. Added a dedicated `leftFight`
  message sent only to that player.
- *A second tab could knock the first tab's connection "offline" after the
  second tab was already live.* `onConnect` already closes a stale socket
  for the same identity, but that socket's own `close` handler fired
  asynchronously and could still run after the replacement was already
  marked online, racing it. Fixed with a per-player connection-generation
  counter: a close only changes online status if it's still the generation
  that was current when it fired.

**Entry points are now visible, not a footnote.** All five screens
(no-save, save-found, run-finished, in-game menu, death/victory) show a
real button-styled co-op entry next to the primary action — not a
`<p class="note">` link after the how-to-play text, and not missing
entirely from two of the five screens as before.

**`src/formation.ts` is generalized from one player anchor to a list of
anchors**, the same one-to-many pattern already used for
`roam.ts`/`encounter.ts`/`combat.ts` — a one-element list is identical to
the old behavior (every existing test passes unchanged against the new
signature). Co-op's fight view uses this for real enemy slot placement and
camera framing instead of raw, potentially-overlapping world positions; the
HTML side list remains the actual interactive surface, consistent with
"formation position is display-only."

**Movement input gained tap/click-to-move and a bounded, backed-off
auto-reconnect**, reusing `src/main.ts`'s own "set a target, walk toward it,
clear on arrival/blur/fight-start/disconnect" idea and distinguishing a real
disconnect (retried) from a deliberate "replaced by another tab" close
(never retried). A real input bug was also fixed: the movement keydown
listener had no focused-input guard, so typing a name containing w/a/s/d
also moved the (not-yet-existing) player.

## Costs

- **The attack-target rule is still unplayed.** Unchanged from ADR 0005.
- **Formation transition is a simple ease, not `src/main.ts`'s full
  forming/formed/unforming phase machinery.** It looks reasonable (verified
  with zero page errors across real single- and two-browser runs, including
  a resize mid-fight) but wasn't built to the same depth as solo's camera
  system — a deliberate scope cut, not an oversight.
- **No horizontal scaling.** Unchanged from ADR 0005.
- **Interpolation delay (180ms) is a fixed constant**, not adaptively tuned
  to observed jitter. Fine on localhost and should be fine on a real network
  given the brief's own ~1s propagation bar, but hasn't been measured over a
  real lossy connection.

## Verification

Real measurements, not assumptions: `tools/coop-perf-check.mjs` before/after
(frame-time stats, position-change-rate stats) against a real dev server.
Real server restarts (not simulated) for every persistence claim: a mid-fight
kill via `docker restart` on a named volume confirms both "stays dead" and
"fight resumes exactly" together. Real two-browser and real mobile-emulated
(390×844, touch events) headless-Chrome runs for the four bugs, the entry
points, and the two-anchor formation path, each checked for zero page
errors. `pnpm typecheck`, `pnpm test` (393 passing, 9 new since ADR 0005),
every existing single-player suite, and the full set again against the
actual production Docker image (`pnpm check`, `pnpm check:browser`,
`pnpm check:deploy`, `tools/persistence-check.sh`) — all unchanged and
passing. Not verified: a real non-localhost network's jitter against the
180ms interpolation constant; multi-day or high-concurrency load; the
attack-target rule has still not been played by a human.
