# Process overview — Crit 10

Updated 1 November 2026 (Australia/Sydney), from repository state e1fc82c.
This account is drawn from the repository and my record of the work.
Automated checks are identified separately from human play.

## From the brief to the game

[Crit 10](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/10-fly-by-instruments/)
asks for distinguishable users, server-enforced permissions and logs that
support narration while two classmates play. Camp Clearer answers through
shared exploration and tactical card encounters. My recorded interest in
Diablo concerns equipment randomness and character growth; encounters should
support decisions and future progression. Loot and talents remain later work,
and the art is a first sample.

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
Pure combat, roaming and encounter modules are reused by solo and co-op, so
one tested rule serves both. The trade-off is that one process carries
connection ordering, persistence and capacity: there is no second machine to
fail over to, and scaling out was shown not to work (below).

I rejected repeated encounter invitations and contribution counters in the
design discussion. Nearby players automatically join one encounter; distant
players continue exploring. The fixed 320-world-unit radius avoids viewport
differences and never chains through teammates. Each player has personal
cards and energy; shared enemies act once after active players finish.
Individual flee retains its cost. The implementation grew through
[a1d639a...12c6e3b](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/compare/a1d639a...12c6e3b).
The lowest-HP targeting rule still needs human play.

## Directing and correcting the agents

I used Codex to inspect choices and prepare implementation briefs, then
Claude Code to implement stages. My own reports concerned an invisible
multiplayer entrance and choppy movement; review findings are recorded
separately from that feedback. I asked for explicit scenarios: HTTP for
ownership, browsers for text, restarts for process boundaries. Stage cards
preserve failed assumptions; the [working process](docs/process/README.md)
records the loop. Separating review from implementation cost time, because
each finding had to be written down before it could become a change. That
cost was worth it when a second reader caught what the implementing pass had
marked done, which happened in every co-op round below.

Corrections were meant to land in rules and checks, not retries. The first
build that "passed" did not load: a field name collided with the engine's.
That became CLAUDE.md's rules in
[dfa9320](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/dfa9320),
including that green typecheck does not mean the game runs, and releases are
gated on production browser checks since
[0485d8b](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/0485d8b).
Words were held to the same standard: when the README said every chasing
enemy joins a fight while the code pulled in only nearby ones, the fix was
a rule in CLAUDE.md that words and code change in the same commit, with a
test of the rule itself.

The performance correction
[ec65456](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/ec65456)
followed local measurements: displayed positions changed every 8.78 frames
before correction and 1.02 afterward ([before](docs/process/evidence/coop-perf-baseline.json),
[after](docs/process/evidence/coop-perf-after-phaseB.json)). That does not
establish real-network smoothness.

Repeated source review exposed limits that passing checks had missed.
[b2896df](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/b2896df)
saved HP and readiness;
[3f0335c](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/3f0335c)
added legacy compatibility and transactional endings;
[c4cf206](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/c4cf206)
turned important reproductions into committed tools. A later review found
HTML nickname execution, stale notifications and card-ID reuse;
[43409a3](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/43409a3)
fixed them and
[f1c744a](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/f1c744a)
strengthened checks that had named card play without playing cards
([round-four record](docs/process/2026-10-15-coop-reliability-round4.md)).

## C10: identity, authority and logs

[928d546](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/928d546)
records [ADR 0007](docs/adr/0007-coop-identity-and-permissions.md) and limits
unauthenticated room peeking to existence and member count. Identity is an
anonymous HttpOnly cookie, stored as a hash. Nicknames are cosmetic; a room
code intentionally permits joining. The server derives action ownership from
the connection and sends private hands only to their owner. HTTP/WebSocket
tests challenge forged identities, stolen card IDs and private-message
isolation, and
[59b6dbd](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/59b6dbd)
adds replaced-connection coverage. These cover specific scenarios, not every
possible authorization failure.

[b769e3f](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/b769e3f)
adds a JSON-line logger;
[8db22eb](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/8db22eb)
connects room, action, rejection and save events. Stable actor hashes
distinguish identical names; cookies and hands are excluded. Retention
follows Fly's platform, not a durable audit guarantee.
[d1c28ba](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/d1c28ba)
adds a spawned-server log check, and
[c4e6e42](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/c4e6e42)
uses two Chrome profiles for joining and reconnection. Automated profiles
establish mechanics; they are not two classmates judging the experience.

## Reviews and what they changed

The [18 October review](docs/process/2026-10-18-c10-review.md) found a
failed random-hand assumption, bracketed names breaking canvas text,
inaccurate logs, rejected cards consuming sequence numbers, and zero-HP
players without a continuation.
[5291631](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/5291631),
[50beb47](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/50beb47),
[442a36e](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/442a36e)
and [3157699](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/3157699)
fixed those ([record](docs/process/2026-10-19-c10-followup-fixes.md)).
None of these was a permission bypass, but each was a place where a check
had passed without proving what its name claimed, and the fix included
changing the check, not only the code.

At my request an agent then ran a
[multi-user test session](multi-user-test-report.md) at WebSocket level
against the deployed app, verifying
[ec0fd87](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/ec0fd87).
It passed late join (13/13) and a Fly machine restart mid-fight (7/7), and
captured real events through `flyctl logs`. Scaling to two machines failed:
each got its own volume and 11 of 20 joins returned 404. One machine and one
volume is therefore the accepted limit. The session also found queued forced
flee logged as already left and an ending panel lost on reload;
[f567620](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/f567620)
and [0b14516](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/0b14516)
fixed them ([record](docs/process/2026-10-21-c10-post-fix-verification.md)).

## Current evidence and its limits

The full suite runs 472 tests. A first art sample was merged in
[a2f7a0c](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/a2f7a0c)
([record](docs/process/art.md)). The next CI run then failed on a check that
assumed a lucky hand;
[ba7971b](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/ba7971b)
fixed the check rather than retrying it, and
[workflow 41053381096](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/actions/runs/41053381096)
passed and deployed `ba7971b`. A verifier's `sourceRevision` describes its
local checkout, so deployment was also confirmed from the served assets.

A slow-network check
([a8f8bfa](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/a8f8bfa),
[record](docs/process/2026-11-01-coop-slow-network-check.md)) ran three times
against a local production build: on Fast 3G, movement took about 0.53–0.61 s
and a round about 0.49 s; on Slow 3G, 1.02–1.12 s and 1.00–1.04 s; reconnects
took 3.33–3.90 s. It found no app bug; it is a local simulation, not a real
mobile network, and is not in CI. An art polish
([aedc011](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/aedc011), merged in
[e1fc82c](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/e1fc82c)) added a bolder grunt,
non-repeating ground, a white hit flash and mage and swarmling sprites, and
updated the README screenshots. No author or player has reviewed the art.

## Next judgment

The one thing not recorded anywhere here is a human two-person playtest,
narrated from the logs. Agent-driven sessions show the mechanism works; they
do not show whether playing together is good. The
[C10 reflection](reflections/crit-10.md) remains a candidate for author
review, not evidence that observation has happened.
