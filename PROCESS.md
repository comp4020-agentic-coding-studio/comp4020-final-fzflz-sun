# Process overview — Crit 10

Updated 18 October 2026 (Australia/Sydney), from repository state 3fd04f7.
Prepared with Codex from recorded requests, commits and verification.
Personal conclusions remain an author-review draft; automated checks are
identified separately from human play.

## From the brief to the game

[Crit 10](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/10-fly-by-instruments/)
asks for distinguishable users, server-enforced permissions and logs that
support narration while two classmates play. Camp Clearer answers through
shared exploration and tactical card encounters. My recorded interest in
Diablo concerns equipment randomness and character growth; encounters should
support decisions and future progression. Loot, talents and art remain later
work.

Earlier feedback established strict turns, visible enemy intentions and
formations that keep crowds readable. Monster roles and roaming followed in
[c592810](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/c592810)
and [8e1ddc9](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/8e1ddc9).
The [C8](reflections/crit-8.md) and [C9 reflections](reflections/crit-9.md)
preserve those stages.

## Stack and shared play

Kaplay, Vite and TypeScript handle presentation; one Node process serves HTTP
and WebSockets. SQLite lives on Fly's persistent volume within the fixed
256 MB machine. [ADR 0001](docs/adr/0001-stack.md) explains the stack, and
[ADR 0005](docs/adr/0005-coop-multiplayer.md) explains authoritative multiplayer.
Pure combat, roaming and encounter modules are reused by solo and co-op.
This concentrates connection ordering, persistence and capacity responsibility
in one process.

I rejected repeated encounter invitations and contribution counters in the
design discussion. Nearby players automatically join one encounter; distant
players continue exploring. The fixed 320-world-unit radius avoids viewport
differences and never chains through teammates. Each player has personal
cards and energy; shared enemies act once after active players finish.
Individual flee retains its cost. The implementation grew through
[a1d639a...12c6e3b](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/compare/a1d639a...12c6e3b).
The lowest-HP targeting rule still needs human play.

## Directing and correcting the agents

I used Codex to inspect choices and prepare implementation prompts, then
Claude Code to implement stages. My actual reports concerned an invisible
multiplayer entrance and choppy movement. Review findings are recorded
separately from my feedback.

Before accepting a change, the selected checks should exercise the
player-visible contract. An HTTP test can challenge ownership, a real
browser can expose text parsing, and a restart check can cover process
boundaries. I asked for prompts to name those cases explicitly. Stage cards
retain failed assumptions and corrections, while the overview links the
decisions that changed the work. This keeps repeated reviews inspectable
without presenting every passing command as equal evidence. The
[working process](docs/process/README.md) records that loop.

The performance correction
[ec65456](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/ec65456)
followed local measurements: rendering averaged 16.67 ms, while displayed
positions changed every 8.78 frames before correction and 1.02 afterward.
[Preserved samples](docs/process/evidence/coop-perf-baseline.json) and
[after samples](docs/process/evidence/coop-perf-after-phaseB.json) support
interpolation and prediction as the response. They do not establish
real-network smoothness.

Repeated source review exposed limits that passing checks had missed.
[b2896df](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/b2896df)
saved HP and readiness;
[3f0335c](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/3f0335c)
added legacy compatibility, reserved fight identifiers, current-member
restoration and transactional endings.
[c4cf206](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/c4cf206)
made important reproductions reusable tools. A later review found HTML
nickname execution, stale fight notifications, card-ID reuse and successful
notifications after failed persistence.
[43409a3](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/43409a3)
addressed them;
[f1c744a](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/f1c744a)
strengthened checks that had named independent card play without actually
playing cards. The [round-four record](docs/process/2026-10-15-coop-reliability-round4.md)
links scenarios and results.

## C10: identity and authority

The C10 prompt required explicit boundaries and observable evidence.
[928d546](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/928d546)
records [ADR 0007](docs/adr/0007-coop-identity-and-permissions.md) and limits
unauthenticated room peeking to existence and member count.

Identity remains an anonymous HttpOnly cookie, stored as a hash, with separate
solo and co-op namespaces. Nicknames are cosmetic. A room code intentionally
permits joining; clearing cookies loses identity. The server derives action
ownership from the connection, checks membership and card ownership, and
sends private hands only to their owner. Real HTTP/WebSocket tests challenge
forged identities, stolen card IDs and private-message isolation.
[59b6dbd](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/59b6dbd)
adds replaced-connection coverage. These checks cover specific scenarios,
not every possible authorization failure.

## Making actions observable

[b769e3f](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/b769e3f)
adds a JSON-line formatter and injectable sink;
[8db22eb](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/8db22eb)
connects room, connection, action, rejection and save events.
Stable actor hashes distinguish identical names; movement summaries reduce
volume. Cookie values and private hands are excluded. Stdout feeds Fly's
logs; retention follows the platform and is not a durable audit guarantee.

[43d501c](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/43d501c)
checks emitted content.
[d1c28ba](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/d1c28ba)
adds a spawned-server check and CI wiring.
[c4e6e42](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/c4e6e42)
uses two independent Chrome profiles for joining, combat and reconnection.
Its own corrections replaced unreliable steering and abrupt browser shutdown
that raced cookie flushing. Automated profiles establish browser mechanics;
they are not two classmates judging the experience.

## Current evidence and its limits

The [C10 stage card](docs/process/2026-10-17-c10-identity-logging.md)
records local and production-container checks, including earlier 444-test
passes and an intermittent XSS-check navigation failure. The current
[workflow 39029743347](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/actions/runs/39029743347)
successfully checked and deployed
[3fd04f7](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/3fd04f7).
This supersedes the card's original pending-deployment status. A verifier's
sourceRevision and worktreeDirty describe its local checkout; they do not
fingerprint the tested container.

The [18 October review](docs/process/2026-10-18-c10-review.md) records a new
result: typechecking passed, but checking against the deployed app produced
443 passes and one failure. A permissions test assumes a random hand contains
an affordable non-single-target card. That assumption can fail; the result
does not establish an authorization bypass. The isolated spawned-server
logging check passed, showing that event presence alone is insufficient.

Review and isolated reproductions also found bracketed nicknames breaking
Kaplay's text parser, unbounded client target text in logs without the
executed card's name, and failed forced flee logged as success. Rejected
cards consume a sequence despite the protocol describing last-accepted
actions. Wiped players can move with zero HP but have no visible continuation.
These remain unresolved; the [follow-up prompt](docs/process/2026-10-18-c10-follow-up-prompt.md)
turns them into explicit acceptance cases.

## Next judgment

Complete those fixes and stabilize meaningful checks, then rehearse with two
people from the deployed URL while narrating only from logs. No independent
human demo, post-fix author play report or Fly log-stream inspection is
recorded for this review. The [C10 reflection](reflections/crit-10.md) is a
finished candidate for author review, not an assertion that those observations
have happened.
