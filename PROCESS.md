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
