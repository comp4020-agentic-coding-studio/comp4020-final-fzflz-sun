# Process overview

This describes the project at crit 8; it is rewritten, not appended to, at
crits 9 and 10.

## From the brief to this game

The brief asks for a multi-user, real-time website that's good, and says
small is fine. I started from a game I'd want to open for ten minutes: a
top-down map where you choose how many enemies to pull into a fight, then
settle it with a hand of cards. The question that kept recurring in playtests
was *what does the player get to think about, and what takes that away from
them?* That became the README's promises and then the rules in `CLAUDE.md`.

Multi-user and real-time aren't in this version. Crit 8 asks for proof of
life: a stranger can play and return to find their progress. Shared play is
crit 9's work.

## Stack, and what it costs

The game is a Kaplay canvas client built with Vite and TypeScript, served by
one small Node process that also stores saves in SQLite on the Fly volume.
Reasons and trade-offs: [ADR 0001](docs/adr/0001-stack.md) (stack),
[ADR 0002](docs/adr/0002-checkpoint-saves.md) (saves),
[ADR 0003](docs/adr/0003-monster-roles-and-packs.md) (monster roles) and
[ADR 0004](docs/adr/0004-roaming-and-places.md) (roaming). In short: the game
owns its own loop, so a page framework would add little, and `node:sqlite`
(Node 24) needs no native dependency, keeping the image at about 50 MB on a
256 MB machine. The cost is hand-written routing and cookies, which is why
they have their own live tests.

One decision changed mid-work: the HUD and hand were canvas text on a fixed
960x540 picture, which only shrinks on a phone, so they moved to HTML over a
full-window canvas, and formation now measures the space the HTML actually
leaves
([`8b1400e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/8b1400e)).

## How I work with the agent

I worked in numbered versions, each from a spec (in Chinese) saying what to
build and verify. The agent (Claude Code) built it and reported, I played
it, and the next spec came from what felt wrong. I didn't review diffs line
by line; I reviewed by playing, and asked for evidence per claim: test
runs, screenshots, browser checks.

The early versions (v1 to v4) were built in the working tree and never
committed, which I regret: there's no diff showing how v1-v2's real-time
combat became the turn-based system that followed. The first recorded state
is the v5 baseline
([`e993867`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/e993867)),
whose message says what came before rather than pretending to be the start.
Since then each piece of work is its own commit: server and saves
([`fbd8be4`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/fbd8be4)),
restore and phone UI
([`8b1400e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/8b1400e)),
the production image
([`c671e3e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/c671e3e)),
live checks
([`d4dd13a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/d4dd13a)),
the README
([`cd6e287`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/cd6e287)),
the fight-joining rule
([`cb9104b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/cb9104b)),
ordered save writes
([`faa8144`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/faa8144)),
monster roles and packs
([`c592810`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/c592810),
[`a040ea2`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/a040ea2)),
and free-roaming enemies
([`8e1ddc9`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/8e1ddc9),
[`bf5cc41`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/bf5cc41)).

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
  chase separation and a short formation step into readable slots, checked
  by `src/formation.test.ts` at every crowd size, map corners and both
  marking viewports.
- **A lethal card wiped the rest of my hand,** and Focus vanished for good
  after one use. I found both by reading the code, not by playing: my v5 spec
  named the exact functions at fault. The fix settles a card fully before
  checking for victory and gives exhaust a per-fight pile, checked by
  `src/cards.test.ts` across 300 random fights.
- **The agent reported v5 as done, and it didn't run.** A custom field name
  clashed with Kaplay's own, and the game crashed on load with typecheck and
  build both green. The agent then built `tools/playtest.mjs`, a real Chrome
  that fails on any page error, which immediately caught a second crash the
  same way. "Client work isn't done until it runs in a browser" is now in
  `CLAUDE.md`.
- **The fight camera framed itself before the HUD finished growing,**
  zooming out to its floor for a player in a map corner. Browser layout
  checks caught it, not my eyes; the fix re-frames on any layout change.
- **Starting a new run could beat the last save.** I never hit this live; I
  found it by reasoning through `SaveClient`'s request order and named the
  exact failure: a victory still in flight could lose to New run, archiving
  the run as abandoned instead of won. Every write now goes through one
  ordered queue; `src/net.test.ts` holds requests in each completion order.
- **Enemies never moved except toward me, or changed after a chase.** The
  map felt static, and "splitting a pack" had no lasting effect. Enemies now
  wander, and grunts and elites settle where they give up instead of
  snapping home; the boss still returns to its fixed lair.
  `src/roam.test.ts` covers the wandering, the give-up conditions and the
  boss's homing, including across a save/reload.
- **The words drifted from the code.** The README said every chaser joins a
  fight; the code takes only chasers within 260 px. The words now match, and
  `src/encounter.test.ts` holds the rule.

## What the checks protect

`pnpm check` runs the course's two HTTP checks, my live save checks and the
game-rule tests against the running app, as CI will once the repo is public.
`tools/playtest.mjs` plays a stranger's whole session on the real image —
start, fight by tapping, saved, reload, restored — checks that a second
visitor can't overwrite the first, covers both marking viewports and a
resize mid-fight, and starts a run on a slow or offline connection.
`tools/persistence-check.sh` shows saves surviving a container restart and a
rebuilt image on the same volume.

The tests can't tell me whether a fight is interesting — whether pulling
three grunts is a real choice, or the boss's charge feels answerable. Those
promises are marked *judged* in the README, and I judge them by playing.

## What I chose not to build

No accounts: a cookie per browser is enough for friends. No leaderboard,
loot, talents or real art yet. Closing the tab mid-fight undoes that fight —
a known soft exploit the game states rather than hides.

## Next

Crit 9 makes the game multi-user and real-time. The map now has enough going
on — six camps, packs, a reviving mage, a boss with a lair — that "what does
another player see and affect" is a real question, not a formality. I
haven't decided the answer yet, and that comes before any code.
