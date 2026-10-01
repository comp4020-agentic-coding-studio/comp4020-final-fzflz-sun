# Process overview

This describes the project as it stands at crit 8. It will be rewritten, not
appended to, at crits 9 and 10.

## From the brief to this game

The brief asks for a multi-user, real-time website that's good, and says
small is fine. I started from a game I'd want to open for ten minutes: a
top-down map where you choose how many enemies to pull into a fight, then
settle it with a hand of cards. The question that kept coming back in
playtests was *what does the player get to think about, and what takes that
time away from them?* That question became the README's promises and then
the rules in `CLAUDE.md`.

Multi-user and real-time are not in this version. Crit 8 asks for proof of
life: a stranger can play and come back to their progress. Shared play is
crit 9's work, and the README says so.

## Stack, and what it costs

The game is a Kaplay canvas client built with Vite and TypeScript, served by
one small Node process that also stores saves in SQLite on the Fly volume.
The reasons and trade-offs are in
[ADR 0001](docs/adr/0001-stack.md); the save design is in
[ADR 0002](docs/adr/0002-checkpoint-saves.md). In short: the game owns its own
loop, so a page framework would add little, and the server needs four JSON
endpoints, static files and `/readme/`. `node:sqlite` ships with Node 24, so
persistence adds no native dependency, and the image idles at about 44 MB on a
256 MB machine. What it costs is hand-written routing and cookies, which is
why they have their own live tests, and an experimental SQLite module.

One decision changed during the work. The HUD and hand were canvas text on a
fixed 960x540 picture, which on a phone only shrinks, so the HUD, hand and menus moved to HTML over a
full-window canvas, and the formation layout now measures the space the HTML
actually leaves ([`8b1400e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/8b1400e)).

## How I work with the agent

I worked in numbered versions. For each one I wrote a spec in Chinese saying
what to build and what to verify. The agent (Claude Code) built it and
reported, I played it, and the next spec came from what felt wrong.
<!-- CONFIRM (author): is the next sentence true of how you reviewed? -->
I didn't review diffs line by line. I reviewed by playing, and asked the
agent to show evidence for each claim: test runs, screenshots, browser checks.

The early versions (v1 to v4) were built in the working tree and never
committed<!-- CONFIRM (author): keep "which I regret"? -->, which I regret. The first recorded state is the v5 baseline
([`e993867`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/e993867)).
Its message says what came before rather than pretending to be the start.
Since then each piece of work is its own commit: the server and saves
([`fbd8be4`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/fbd8be4)),
restore and phone UI
([`8b1400e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/8b1400e)),
the production image
([`c671e3e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/c671e3e)),
the live checks
([`d4dd13a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/d4dd13a)),
the README
([`cd6e287`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/cd6e287)),
the fight-joining rule
([`cb9104b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/cb9104b))
and ordered save writes
([`faa8144`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/faa8144)).

## Where playing and review corrected the agent

Each correction landed in a rule or a check, not just a retry.

- **v1 let you move during combat.** It played like an action grinder, not a
  card game. Combat now locks you in place, which became the first rule in
  `CLAUDE.md`.
- **v3 kept enemies attacking on a timer while I read my hand.** Thinking
  cost HP. v4 made combat strict turns. The phase machine in `src/turn.ts` is
  the single gate for input, and its tests plus a browser check that two idle
  seconds change nothing hold that line.
- **Crowds stacked bodies, HP and intents on top of each other.** v5 added
  chase separation and a short formation into readable slots.
  `src/formation.test.ts` checks every crowd size at map corners and both
  marking viewports.
- **A lethal card wiped the rest of my hand,** and Focus vanished for good
  after one use. My v5 spec named both, down to the functions involved.
  <!-- CONFIRM (author): did you find these by playing, reading the code, or another review? -->
  The fix settles a card fully before checking for victory and gives exhaust a
  per-fight pile. `src/cards.test.ts` replays both cases and 300 random
  fights.
- **The agent reported v5 as done, and it didn't run.** A custom `radius`
  field clashed with Kaplay's `rect()`, and the game crashed on load. Typecheck
  and build had both passed. The agent then built `tools/playtest.mjs`, which
  drives a real Chrome and fails on any page error. Running it immediately
  caught a second crash: square brackets in on-screen text are Kaplay style
  tags. Both traps, and the rule that client work isn't done until it runs in
  a browser, are now in `CLAUDE.md`.
- **The fight camera was framed before the HUD finished growing,** and a
  player in a map corner made it zoom out to its floor. The browser layout
  checks caught this, not my eyes. The fix re-frames on any layout change.
- **Starting a new run could beat the last save.** My pre-submission spec
  named the race: a victory still in flight lost to New run, and the run was
  archived as abandoned.
  <!-- CONFIRM (author): how did you find this race? -->
  Every write now goes through one ordered queue, and the final checkpoint
  must land before the next run starts. `src/net.test.ts` holds requests in
  each completion order, and a throttled-network browser run repeats it.
- **The words drifted from the code.** The README said every chaser joins a
  fight; the code takes only chasers within 260 px. The words now match, and
  `src/encounter.test.ts` holds the rule.

## What the checks protect

`pnpm check` runs the course's two HTTP checks, my live save checks
(`spec/saves.test.ts`) and the game-rule tests against the running app, as CI
will once the repo is public. Separately:

- `tools/playtest.mjs` plays a stranger's whole session on the real image:
  start, fight with taps, saved, reload, restored. It also checks that a
  second visitor can't overwrite the first, covers 1920x1080 and a 390x844
  touch phone, resizes mid-fight, and starts a new run on a slow or offline
  network.
- `tools/persistence-check.sh` shows saves surviving a container restart and
  a rebuilt image on the same volume.

The tests can't tell me whether a fight is interesting: whether pulling
three grunts is a real choice, or the boss's charge feels answerable. Those
promises are marked *judged* in the README, and I judge them by playing.

## What I chose not to build

No accounts, because a cookie per browser is enough for a game played by a
few friends. No leaderboard, art or extra content yet. I also didn't save
exploration movement between checkpoints. Closing the tab mid-fight undoes
that fight. That's a known soft exploit, and the game says so rather than
hiding it.

## Next

Crit 9 makes the game multi-user and real-time. I haven't decided yet what
another player should mean in this game, and that decision comes before any
code.
