# ADR 0005: Real-time co-op is one authoritative engine, not synced solo copies

Status: accepted, 2026-10-10. One decision inside it (the attack-target rule) is marked **draft** below and needs the author's confirmation.

## Context

Crit 9 asks for real multi-user, real-time play. The game had no concept of
more than one player anywhere: `src/roam.ts`, `src/encounter.ts` and
`src/combat.ts` all took a single hardcoded player position or player object,
and the server only validated and stored save snapshots — it never ran any
game logic. ADR 0001 already flagged that this would need "a fan-out design
(WebSocket or SSE) inside this process," and `PROCESS.md` said plainly that
"what does another player see and affect" had to be decided before any code.
This ADR is that decision.

The brief is explicit that two independently-simulated single-player clients
kept in sync after the fact is not an acceptable answer — the deliverable is
one shared world both players actually affect.

## Decision

**One shared engine, not two.** The existing pure rule modules
(`src/roam.ts`, `src/encounter.ts`, `src/combat.ts`) are generalized from "one
player" to "a list of players," and that same generalized code runs in two
places: the untouched single-player client (a one-element list) and a new
server-authoritative co-op loop (an N-element list). A guard at its spawn
chases whichever player it actually noticed, not always index 0; an attack
aims at a specific player, shown before it resolves. Solo behavior is
unchanged — every existing test for it still passes against the one-element
shape — because it's the same code, not a parallel copy that could drift.

**Transport: WebSocket**, via the `ws` package, attached to the existing raw
`http.Server` through its `upgrade` event. One process, one port, matching
ADR 0001's own prediction. SSE was ruled out because actions need to flow
client→server too (card plays, movement, end turn); one bidirectional
channel is simpler than a push channel plus a separate write path.

**Identity: a second, separate cookie** (`cc_coop`), hashed the same way as
the existing `cc_visitor` cookie, but its own namespace — joining or creating
a room never touches a visitor's single-player save, and the two systems
share no tables. The same identity reconnecting (same cookie, any tab) always
re-attaches to its existing room-member row; it never creates a second
character, and a second tab's socket replaces the first rather than
co-existing.

**Rooms**: a short, shareable code (`/coop.html?code=XXXXXX`), created or
joined through plain REST endpoints before the socket ever opens (so the
identity cookie is already set when the browser opens the WebSocket, same-
origin). Co-op's own SQLite tables (`rooms`, `members`, `room_state`) live
next to the single-player ones in the same `/data` volume, but are a separate
database file (`coop.sqlite`) — no foreign keys, no shared code path, so a
bug in one can't corrupt the other.

**Auto-join, fixed-radius, server-decided.** `PLAYER_JOIN_RADIUS = 320`: a
fight's anchor is whichever player an enemy was actually chasing when it
reached engage range (not simply "the nearest"), and every other free, alive,
online teammate within 320px of that anchor joins too — by distance to the
anchor alone, never a chain through one teammate to reach another. 320 is
bigger than the enemy-side `JOIN_RADIUS` (260, since teammates are allies you
want pulled in generously) but well under the >480px gap enforced between any
two camps, so it can never bridge two separate fights into one. Because an
enemy has exactly one chase target at a time, "two players trigger the same
enemy simultaneously" can't actually happen — there's one target, one anchor,
one fight — which is a simpler guarantee than deduplicating after the fact.
A roster is fixed the instant it forms (enemies become `engaged`, already
excluded from roam and from being selected into another fight; players get a
`fightId` and stop moving) and never changes afterward, including for anyone
who wanders close later.

**Combat: a common player phase.** Every player in a fight has their own
hand, deck, energy and HP; nobody's card resolves anybody else's state except
through the shared enemies. The enemy turn only runs once every player who
is still present (not downed, not fled) has readied up (End Turn or Flee);
a downed player is automatically excluded from that requirement, so one
death never blocks the others from continuing. **Draft, for the author's
confirmation**: an attack whose pattern doesn't name a target aims at the
active player with the lowest current HP, ties broken by the order they
joined the fight. This is a plausible first answer (it's legible, and it
doesn't let a healthy player "tank" forever by simply out-leveling a
teammate) but hasn't been played yet.

**Concurrency and idempotency.** Every action a client sends carries a
per-player, strictly increasing sequence number; the server rejects a replay,
duplicate, or anything that arrives after a later action has already been
processed, before it touches any state. A card is identified by a server-
generated instance id (`src/cards.ts` itself has no such id — two Strikes in
a hand are literally the same object, which single-player's synchronous,
no-latency index-based play never needed to tell apart), so a client-side
hand reorder between a click and the server receiving it can't play the
wrong card. If a shown attack's target already fell to an earlier action in
the same resolve, the attack voids rather than retargeting — never a free
redirect onto someone else.

**Individual flee and death**, not whole-party. Fleeing finishes the current
round's shown actions first, then leaves only if the fleeing player survived
it; the rest of the party keeps fighting the same enemies at their current
HP. A downed player stops acting and stops being targeted but stays
structurally present (shown as fallen) until the fight ends. The fight itself
ends on a clean win, a full wipe (everyone downed), or everyone having left
(fled); ending it writes each surviving enemy's HP and action-phase back to
the shared room and hands them to `src/roam.ts`'s existing `settleAfterFlee`
to return to roaming — the same rule solo flee already uses, not a second one
invented for co-op.

**Reconnect: a 30-second window, never a free exit.** A disconnect mid-fight
starts a timer; reconnecting before it fires resumes the same identity, same
hand, same board, with no visible consequence. If it lapses, the player is
resolved exactly as if they had clicked Flee themselves — the current
round's shown actions still land on them first — never an instant free
escape and never a silent permanent stall for the rest of the party.

## Costs

- **An active fight's turn/hand/energy state is not persisted.** Shared
  exploration (positions, enemy roam state) is checkpointed to SQLite on a
  debounce, same spirit as single-player's "stable moments" rule. A fight in
  progress is not: a server crash or redeploy mid-fight loses that fight's
  state, and the affected enemies/players simply resume from their last
  pre-fight values once the room reloads — not replayed, not duplicated, just
  dropped. This is consistent with the project's existing refusal to save
  "half a resolve," but it's a real gap against the brief's "confirmed combat
  results must survive a restart" bar, and is the clearest candidate for a
  follow-up.
- **Visual polish is deliberately behind the mechanics.** The co-op client
  (`coop.html`/`src/coop-main.ts`) renders players and enemies as plain
  shapes and runs the fight through a functional but unstyled HTML card dock,
  not the single-player client's formation layout, camera framing or card
  art. The rules it's driven by are the real, server-authoritative ones;
  the presentation is not held to the same bar as `README.md`'s promises for
  solo play yet.
- **One attack-target rule, unconfirmed.** See the draft note above.
- **No horizontal scaling.** Room state lives in one Node process's memory
  (per ADR 0001's existing single-machine constraint); this was already true
  for the whole app and co-op doesn't change it, but it now also bounds how
  many concurrent rooms one instance can usefully tick.

## Verification at the time of the decision

`src/roam.test.ts`, `src/encounter.test.ts` and `src/combat.test.ts` (solo
cases unchanged, new co-op cases: multiple targets, join-radius boundaries,
no chain expansion, an already-downed target voiding rather than
retargeting, one player down not blocking the rest, whole-party wipe);
`server/coop/room.test.ts` and `server/coop/fight-session.test.ts` (fight
formation and occupancy, ready-gating, stale/duplicate sequence numbers,
individual flee, the reconnect-timeout path); every existing single-player
`tools/playtest.mjs` suite (combat, save, viewports, monsters, groups, roam —
229 checks) unchanged on both the dev server and the production Docker image;
live runs with real WebSocket clients and real headless-Chrome browsers
covering two-player auto-join, common-phase gating, individual flee, victory,
and a real 30-second reconnect-window lapse; the production image verified
with `docker build`, `pnpm check`, `pnpm check:browser`, `pnpm check:deploy`,
and a restart-and-rebuild persistence check on a real Docker volume (co-op
room/position state and the existing single-player
`tools/persistence-check.sh` both pass). Not verified: a real multi-day or
high-concurrency load; the attack-target rule has not been played by a human
yet.
