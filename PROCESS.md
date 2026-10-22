# Process overview — Crit 10

Updated 19 October 2026 (Australia/Sydney), from repository state fea280f.
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

I requested explicit scenarios: HTTP for ownership, browsers for text,
restarts for process boundaries. Stage cards preserve failed assumptions
and corrections; the [working process](docs/process/README.md) records the loop.

The performance correction
[ec65456](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/ec65456)
followed local measurements: frame intervals averaged 16.67 ms, while displayed
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
records earlier 444-test passes and an intermittent XSS-check navigation
failure. The earlier
[workflow 39029743347](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/actions/runs/39029743347)
successfully checked and deployed
[3fd04f7](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/3fd04f7).
That workflow does not verify the subsequent fixes. A verifier's
sourceRevision and worktreeDirty describe its local checkout, not the tested
container.

The [18 October review](docs/process/2026-10-18-c10-review.md) recorded 443
passes and one failed random-hand assumption against that deployed build,
not an authorization bypass. Isolated reproductions found bracketed names
breaking canvas text, inaccurate logs, rejected cards consuming sequence
numbers, and zero-HP players moving without a visible continuation.

Follow-up commits address the five findings' basic paths.
[5291631](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/5291631)
escapes canvas names and corrects XSS-check steering.
[50beb47](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/50beb47)
supplies server-confirmed card summaries, checks forced-flee results and
advances sequence numbers only on accepted actions.
[442a36e](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/442a36e)
repairs the permissions fixture and waits for new messages.
[3157699](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/3157699)
gates zero-HP movement and adds a visible expedition ending with a browser
check. The [follow-up record](docs/process/2026-10-19-c10-followup-fixes.md),
committed in
[fea280f](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/fea280f),
attributes verification to Claude Code.

That record reports 462 passing tests, deterministic all-single-hand coverage,
and local production-container checks for browser, save, logging, identity
and desktop/phone wipe flows. Its repeated XSS checks passed after the
steering correction. The separate existing live co-op tool passed four of
five runs; CC attributed the failure to another all-Strike-hand assumption.
These are recorded local results from before the fixes were committed,
not checks rerun while updating this overview or proof of their deployment.

Subsequent source review found queued forced flee logged as already left,
and an ending panel that is not restored after reload or reconnect. The
XSS helper also accepted either profile entering combat, rather than
requiring both.

## A real multi-user test session, then closing the remaining gaps

I ran a real [multi-user test session](multi-user-test-report.md) against
the deployed app at commit
[c8a4b10](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/c8a4b10).
[Workflow 39205736108](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/actions/runs/39205736108)
passed `check` and `deploy` for that exact commit, and the deployed
revision is `c8a4b10` — this confirms CI and deployment for that commit
specifically, not every earlier commit in this file's own history.
`flyctl logs` was exercised directly against the running app and captured
real coop events corresponding to the driven scenarios (the report's §3),
closing what an earlier version of this section called "no Fly
log-stream inspection."

The session found two real gaps the previous follow-up round's own fixes
had not fully closed (forced-flee logging still conflated "accepted" with
"actually left"; the wipe panel didn't survive a reload), confirmed a real,
structural single-machine limitation (scaling to two Fly machines gives
each its own volume: 11 of 20 real room joins returned 404 — a known,
accepted shape, not a bug), and separately passed late-join (13/13) and a
real Fly machine restart mid-fight (7/7). A new
[stage card](docs/process/2026-10-21-c10-post-fix-verification.md)
records the fixes for the two real gaps, their real test results, and the
XSS check's same-fight requirement.

## Next judgment

Verify this latest round's own CI and deployment, then rehearse with two
real people while narrating from logs. That rehearsal — a human playtest,
not an agent-driven HTTP/WebSocket session — remains the one thing not yet
recorded anywhere in this file's history. The
[C10 reflection](reflections/crit-10.md) remains a candidate for author
review, not evidence that observation has happened.
