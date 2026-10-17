# Process overview — Crit 9

Updated 11 October 2026 (Australia/Sydney), from repository state
`104e580`. This is an author-review draft assembled with Codex from the
recorded design discussion, commits and checks. Personal judgments need the
author's review; agent verification is labelled separately.

## From the brief to this game

[Crit 9](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/09-all-at-once/)
asks for real-time shared use and a justified decision about simultaneous
users. Camp Clearer answers with shared exploration and tactical card
encounters. My interest in Diablo is especially random equipment and
character growth. That clarified the direction: encounters should support
tactical choices and future progression, rather than increasing enemy
counts indefinitely. Loot and talents are still future work.

I rejected shared contribution counters because they did not give players
enough influence over each other. Repeated battle invitations would also
interrupt exploration. The accepted rule uses positioning: a nearby friend
automatically fights with you; a distant friend keeps exploring. The
[curated discussion and review](docs/process/2026-10-11-c9-documentation-review.md)
records that direction without claiming it was already validated by players.

## The foundation carried forward

Crit 8 established strict turns, readable enemy intents and persistent
anonymous saves. Play had exposed timed attacks that punished reading and
crowds that obscured intentions. Those corrections became the phase gate,
formation rules and browser checks. The recorded baseline is
[`e993867`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/e993867);
early versions were uncommitted, so their evolution cannot be reconstructed
as a sequence of diffs. Monster roles and roaming followed in
[`c592810`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/c592810)
and [`8e1ddc9`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/8e1ddc9).
The [C8 reflection](reflections/crit-8.md) remains unchanged.

## Stack and the multiplayer decision

Kaplay, Vite and TypeScript handle presentation; one Node process serves
HTTP and WebSockets. SQLite uses the existing Fly volume on the fixed
256 MB machine. This reuses the stack and pure rule modules instead of
adding another backend. The cost is responsibility for connection identity,
ordering, recovery and memory use. [ADR 0001](docs/adr/0001-stack.md) and
[ADR 0005](docs/adr/0005-coop-multiplayer.md) explain those choices.

Each room has one authoritative map and enemy population; each member has
personal HP, energy and cards. Separate co-op storage protects solo saves.
A 320-world-unit radius around the triggering player determines eligible
teammates once, without chaining through other players. Camera visibility
was considered, but viewport size and zoom would make identical positions
behave differently across devices. Distant members can start another
encounter; enemies cannot belong to two fights.

Cards resolve individually on the server. All active participants must
finish their player phase before enemies execute their displayed actions
once. Flee is personal and still costs the shown enemy actions. These
mechanisms grew through
[`a1d639a...12c6e3b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/compare/a1d639a...12c6e3b).
The lowest-HP attack-target rule is a provisional design choice, not
evidence of enjoyable cooperation.

## How the agents were directed and corrected

I used Codex to discuss choices, inspect the repository and prepare
implementation prompts; Claude Code implemented the stages. My feedback
set the next acceptance scenarios. Rule tests, browser checks and production
checks supplied different evidence. The
[working process](docs/process/README.md) separates these jobs and records
unfinished work explicitly.

Two actual reports redirected C9: I could not find multiplayer, and
movement felt like very low framerate. Codex's code review separately
identified refresh sequencing, individual flee notification, replacement
socket handling and orphaned engaged enemies. Those were review findings,
not four bugs I personally reproduced. The resulting prompt required
specific failure scenarios and measurement before tuning.

The performance fix
[`ec65456`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/ec65456)
followed recorded local measurements: rAF intervals averaged 16.67 ms
before and after, but displayed position changed every 8.78 frames before
and 1.02 afterward. The fix added local movement prediction, remote
interpolation and DOM reuse; server updates remained 150 ms apart.
[Preserved samples](docs/process/evidence/coop-perf-baseline.json) and
[after samples](docs/process/evidence/coop-perf-after-phaseB.json) support
that narrower finding. They do not establish smoothness on a phone or
a lossy real network.

[`3c658ca`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/3c658ca)
added fight persistence, sequence recovery, personal exit messages and
connection generations.
[`15d5b39`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/15d5b39)
made entry points prominent and added touch movement, reconnect and shared
formation support. A further restart check found enemies' alive/dead
status was absent from persistence;
[`bbaee09`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/bbaee09)
added it. A passing earlier stage had therefore left a real gap.

## What the evidence establishes

The [reliability stage record](docs/process/2026-10-11-coop-reliability-and-perf.md)
reports 393 passing tests, real connection/restart checks, and desktop and
phone-emulated browser sessions against development and production Docker.
These are earlier agent-run checks, not checks rerun while writing this
overview. Some reproductions remain ignored local scripts; they are not
all reusable CI gates. Performance JSON was preserved during this
documentation review; its original files have no embedded revision metadata.

The first co-op release deployed
[`bb8d93d`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/bb8d93d)
through [workflow 38127922180](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/actions/runs/38127922180).
The [release record](docs/releases/2026-10-11-coop-deploy.md), committed in
[`104e580`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/104e580),
reports live two-browser exploration. Its own subsequent workflow also
succeeded. A local deploy verifier's `sourceRevision` identifies the
checking checkout, not a server-returned build fingerprint. CI provenance
and live behaviour are separate evidence.

## Remaining boundaries and next work

The 11 October source review found two recovery gaps despite the successful
restart scenarios: player HP lives in a periodic room snapshot rather than
the per-action fight snapshot, and restoration clears ready status.
An abrupt crash between writes could restore stale HP; a pending flee
could regain an action. These are code-review risks, not newly reproduced
crash results. They need targeted checks and a persistence correction before
claiming exact recovery.

Formation transitions remain simpler than solo, interpolation uses a fixed
180 ms delay, and multiplayer balance still needs people playing together.
Live Fly restart and live phone/formation checks were not performed in the
recorded release. My original feedback concerns the earlier build; no
post-fix author review or independent player session is recorded.

Next: close the recovery windows, make the critical multiplayer
reproductions durable checks, and test real-network play before extending
loot and character progression.

## Round 3: a further restart-recovery review, the same day

The recovery windows named above were closed the same day they were
written up, not left for a later crit. [`b2896df`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/b2896df)
fixed the two gaps the 11 October review had already found (player HP
living outside the per-action fight snapshot; restoration clearing ready
status). A further, more careful pass over the same restart path — by the
same review process, reading the current source again rather than
trusting the prior "resumes exactly" claim — found four more real gaps,
all specifically in restart/recovery: no legacy-format compatibility for
a fight row written before `b2896df` added `hp`/`ready`; a fight-id
collision after a restart (`CoopRoom.nextFightN` never advanced past a
restored fight's id); a fled player re-locked into the fight they'd
already left (the restore loop used the fight's original fixed roster
instead of its actual current membership); and fight-end persistence that
wasn't atomic and notified clients before either write committed.
[`3f0335c`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/3f0335c)
fixed all four, each backed by a real `docker restart` reproduction, not
a same-process call. [`c4cf206`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/c4cf206)
turned the directly-relevant `.local/`-only scripts into real,
repo-committed tools — `tools/coop-live-check.mjs` (CI-wired, no restart
needed) and `tools/coop-restart-check.sh` (real `docker restart` on a
named volume, local/pre-release only, mirroring
`tools/persistence-check.sh`'s own convention) — and added a co-op
section to `docs/process/playtest.md`. The [round-3 stage card](docs/process/2026-10-11-coop-restart-hardening.md)
records the acceptance scenarios and review evidence for all four; a test
assumption in that round's own fled-player check turned out to be wrong
(it expected the fight view's player list to shrink, when showing a fled
member with `fled: true` is correct, pre-existing behavior) — corrected
in the check, not the product, and recorded in that card's correction
table. This round deployed as [`1b0b10d`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/1b0b10d),
with 409 tests passing and CI green; the real human two-player playtest
remained, and remains, outstanding.

## Round 4: a fourth independent review, no new symptom report

Every check from rounds 2 and 3 stayed green with nothing new reported
from play. The same review discipline was applied again anyway — reading
the current source directly rather than treating passing checks as proof
there was nothing left — and found four further real issues, none caught
by the 409 unit tests or the round-3 live/restart checks:

- **A room member's display name could execute as markup.**
  `src/coop-main.ts`'s `renderFight()` built an enemy button's "→ target
  name" text via `innerHTML`, with the name interpolated raw; the
  server's `cleanName()` only trims and truncates, never escapes. Fixed
  with a new, shared `escapeHtml()` in `src/coop-protocol.ts` (no reusable
  escaping helper existed before this — `src/main.ts` and
  `server/readme.ts` each had their own private copy), applied at the one
  real sink. No character blacklist was added; a normal Chinese/space/
  punctuation name still passes through unchanged.
- **A stale `fightEnded` could wipe an unrelated, newer fight's UI.** The
  server notified a fight's *original* roster when it concluded, not its
  actual final membership, so a player who'd fled that fight earlier and
  since joined a different one could still receive its `fightEnded` —
  and the client applied it unconditionally, with no check that the
  message was even about the fight on screen. Fixed on both ends:
  `FightSession` now captures `finalPlayerIds` at the exact moment
  `finish()` runs, before anything clears membership, so the server
  notifies the right people; the client now checks `msg.fightId` against
  its own current fight before acting on `fightEnded` or `leftFight`. A
  compounding reconnect gap — a fight concluding entirely while a client
  was disconnected left nothing to tell that client so on reconnect — was
  closed by adding the player's current `fightId` to the `hello` message.
- **A card-instance-id could collide after a restart.** The card-id
  counter is a single process-wide counter with no reservation mechanism,
  unlike the existing `reserveFightId()` for fight ids. Fixed with an
  analogous `reserveCardId()`, called for every id in every restored
  hand.
- **A failed database commit at fight-end still reported success.** The
  existing retry loop's success flag only gated the save-debounce
  timestamp; the `fightEnded` broadcast and in-memory session deletion
  both ran regardless of whether the commit actually happened, with
  nothing to retry it later. Fixed with a `pendingFinishes` map: a failed
  commit is retried every tick until it succeeds, nobody is notified and
  no session is discarded until it actually commits, and the affected
  room's own periodic snapshot write is skipped while a finish is
  pending.

This round's own review of the existing checks found them not just
improvable but concretely wrong in places: `tools/coop-live-check.mjs`
never sent a single `playCard` in any scenario (asserting "independent
card play" by scenario name only); its round-advance check was a loose
OR, not an exact count of enemy actions; its reconnect scenario never
asserted a real nonzero prior `lastSeq`, only its type.
`tools/coop-restart-check.mjs`'s victory-restart check would have passed
vacuously if zero `state` messages ever arrived. All four were
strengthened as part of this round, not left noted for later.

The [round-4 stage card](docs/process/2026-10-15-coop-reliability-round4.md)
records the full acceptance scenarios, review evidence and correction
table. In outline: `pnpm typecheck` and `pnpm test:unit` (408 tests
passing, including new tests for `finalPlayerIds`, `reserveCardId`, and a
fault-injection suite in `server/coop/ws.test.ts` forcing `finishFight`
to fail); a real headless-Chrome run (`tools/coop-xss-check.mjs`, new)
confirming a crafted name never executes and a normal Chinese/space name
still displays correctly; `tools/coop-live-check.mjs` extended with two
new scenarios reproducing the exact stale-message repro and the
disconnect-while-concluding-elsewhere reconnect case, both passing
repeatedly across multiple stability reruns; `tools/coop-restart-check.sh`
extended with a card-id-collision scenario across two concurrently
restored rooms. As with round 3, this is agent-run verification against
real browsers, real WebSocket clients and a real restarted process — not
a claim that a human has played any of it yet.

## Crit 10: identity, permissions and server-side logging

C10's theme, "two people your app tells apart, read from its logs," asks
for three things: a documented identity model, a documented and
server-enforced permission boundary, and durable server-side logging of
who-did-what, surviving the crit session. A source review of
`server/coop/ws.ts`, `server/index.ts`, `server/coop/room.ts` and
`server/coop/fight-session.ts` — reading the current code directly, not
assuming the prior rounds' own "server is authoritative" claims still
held in every corner — found the identity and authorization mechanics
already correct, carried over unmodified from ADR 0002 (anonymous
visitors) and ADR 0005 (co-op multiplayer): both `cc_visitor` and
`cc_coop` are server-derived from a hashed cookie, never a client-
suppliable field; every fight action's acting player comes from the
server-resolved connection; card ownership and private views are already
correctly scoped. What was actually missing: the room "peek" endpoint
returned the full member list to an unauthenticated prober who merely
knew the room code; no structured business logging existed anywhere
(only an opt-in, default-off performance log); and no automated check
proved the authorization boundaries the brief cares about — they were
true by code reading, not by a passing test.

[`928d546`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/928d546)
adds [ADR 0007](docs/adr/0007-coop-identity-and-permissions.md), shrinks
the peek endpoint to `{code, memberCount}`, and adds
`spec/coop-auth.test.ts` proving the boundaries directly over real
HTTP/WebSocket connections: distinct identities for the same display
name, identity surviving reconnect, a non-member unable to open a room's
socket, a forged player id or stolen card instance id never affecting
another player's state, a player never receiving another's hand, and a
rejected action never disturbing the legitimate player's next real
action.
[`b769e3f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/b769e3f)
adds a new, purely additive `server/log.ts`: a pure JSON-line formatter
plus an injectable sink, unit-tested (`server/log.test.ts`) for exact
output shape and — reusing the same crafted-payload discipline as round
4's XSS fix — proving a display name shaped like an HTML payload,
embedded newlines/quotes, or a fake adjacent log-line fragment can never
break line-based parsing or forge a second event.
[`8db22eb`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/8db22eb)
wires it into every real action and rejection in `server/coop/ws.ts`
(room create/join/peek, connect/replace/disconnect, throttled movement
summaries — one line per movement spell, never per 150ms tick — encounter
formation, every fight action and every rejection mapped to a small fixed
reason code, a player going down, fight conclusion) and into
`server/index.ts`'s save API, and
[`43d501c`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/43d501c)
extends `server/coop/ws.test.ts` with exact log-content assertions
against a capturing sink — distinct actor ids for distinct identities, a
stable reason code per rejection scenario, never the attempted content in
a rejection line, a crafted name producing exactly one valid JSON line
through the real call site.

[`d1c28ba`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/d1c28ba)
adds `tools/coop-log-check.mjs`, which spawns a real `server/index.ts`
process — the only way to prove its own logging fires, since it has no
constructor to inject a test sink into the way `CoopServer` does — and
drives two real identities through a real action/rejection/flee/
reconnect sequence plus a solo save write, then asserts the server's own
captured stdout contains every required event type with two distinct
actor ids and no raw cookie value or stolen card content anywhere in it.
The same commit wires it, and round 4's already-built but never-wired-in
`tools/coop-xss-check.mjs`, into CI.
[`c4e6e42`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/c4e6e42)
adds `tools/coop-identity-demo-check.mjs`, a real two-Chrome-profile
check standing in for the live demo: an invite-link-only join, a shared
fight, independent card plays, a flee, and a reconnect on the same
profile. Finding and fixing this tool's own bugs was itself real
evidence of this round's standard: a fixed keyboard heading geometrically
missed the target enemy's actual spawn (replaced with live steering), and
a plain process kill raced Chrome's own cookie-database flush to disk,
making a reopened profile see a different identity even with the profile
directory intact — fixed by asking Chrome to shut down cleanly before
killing it, confirmed directly by comparing the raw cookie token across a
close/reopen cycle, not assumed from the profile directory surviving.

In outline, everything above plus
[`59b6dbd`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/59b6dbd)
brought `pnpm check` (typecheck plus the full spec/unit suite) to 444
tests passing against a running dev server, all green, repeatedly. As
with every prior round, this is agent-run verification against real
HTTP/WebSocket connections, a real spawned process and real headless
Chrome — not a claim that a real human two-person demo, narrated live
from `flyctl logs` against the deployed app, has happened yet. That
remains the explicit next step before the crit itself.
