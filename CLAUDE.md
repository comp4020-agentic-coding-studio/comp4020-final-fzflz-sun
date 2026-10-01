# Camp Clearer: rules for agents working in this repo

The argument for what good means is `README.md`. These are the standards a
change must meet; each one came from a playtest correction or a bug that
reached a build. Pure rules live in `src/cards.ts`, `src/turn.ts`,
`src/formation.ts`, `src/separation.ts` and `src/save.ts`; keep them free of
Kaplay and the DOM so they stay testable.

## Combat must never punish thinking

- Exploration is real-time; combat is strictly turn-based. During the player
  turn nothing advances on its own: no timers, regeneration or enemy moves.
- Card play, End turn and Flee all go through the one gate, `canAct`
  (`src/turn.ts`), and phase changes go through `transition()`. A second End
  turn during the resolve must be a no-op, never a skipped turn.
- Enemies act only from the intent shown before the player's turn. Dead
  enemies don't act. A killing blow stops the resolve at once.
- Flee resolves the shown enemy actions first, then escapes if the player
  survives. Never make flee free.
- Every fight participant must show its intent with exact numbers; the boss's
  charge names the hit it leads to.

## Cards are conserved

- The 14-card deck is always fully accounted for across draw, hand, discard
  and exhaust. A card play settles completely (out of hand, cost, effect,
  destination) before victory is checked.
- Exhaust is per fight: exhausted cards return to discard when the encounter
  ends, whatever the outcome.

## Fights stay readable

- Slots are assigned once, at engagement, from the safe area measured from the
  real HTML HUD (`measureSafe`). Killed enemies leave a gap; nobody shuffles.
- No two participants' footprints (body, HP/block, intent, target marker:
  `TRASH_BOX` / `BOSS_BOX`) may overlap or leave the safe area, at 1920x1080,
  390x844, map corners and edges. If they don't fit, use the side list; never
  drop an enemy or shrink text to fit.
- The fight is re-framed whenever the viewport or HUD changes size; the camera
  is clamped to the map at its current scale every frame.
- Formation positions are display-only. Identity, HP, intent, target and click
  area always belong to the same enemy instance. After a flee, survivors
  return to their recorded engage position.

## Saves are honest

- Enemies are saved by the stable ids in `src/world.ts`, never by runtime
  `enemyId`. Never renumber or reuse an id.
- Save only at stable moments (run start, fight trigger, victory, flee,
  death). Never save formation slots, half a resolve, or animation state.
- Load before starting: a default new game must never overwrite a save.
- Show "Saved" only after the server confirmed that exact checkpoint. Retry
  transient failures, and show conflict and failure states.
- Every save write (checkpoint, new run, erase) goes through `SaveClient`'s
  one ordered queue. Never call `/api` writes from anywhere else. A new run
  may only start after the last checkpoint is confirmed, or after the player
  explicitly chooses to discard it. A response or retry from before a new run
  or erase must not change anything. `src/net.test.ts` holds this.
- Every way to trigger an action (button, key, repeat click) goes through the
  same entry point.
- The server validates every save (`validateSave`, `checkProgression`). Only
  an explicit `{"confirm":"erase"}` deletes data; a new run archives the old.
- `?fight=` and other test entry points are development-only and never save.

## Words match the code

- README, the in-game how-to and the hints describe rules as the code runs
  them (e.g. only chasers within `JOIN_RADIUS` join a fight). When a rule
  changes, change the words in the same commit, and keep a test of the rule
  itself (`src/encounter.test.ts`, `src/turn.test.ts`, ...).

## Kaplay traps that already broke a build

- Never put square brackets in Kaplay `text()`: `[x]` is a style tag and an
  unmatched one throws and halts the game loop.
- Never add a custom field named after a component property (e.g. `radius` on
  a `rect()` object): Kaplay throws "Duplicate component property" on spawn.
- Typecheck and build passing does not mean the game runs. A change that
  touches the client isn't done until it has run in a real browser.

## Verify before claiming done

```sh
pnpm typecheck
pnpm test:unit                      # rule tests, no app needed
pnpm dev                            # app + API on :8080 (saves in .data/)
APP_URL=http://localhost:8080 pnpm check   # rules + spec/ against the running app
pnpm playtest                       # real Chrome: combat, save loop, both viewports
node tools/playtest.mjs --suite=race   # new run vs a slow / offline final save
sh tools/persistence-check.sh       # saves survive restart and rebuild (Docker)
pnpm check:evidence
```

For the production image: `docker build -t app . && docker run -p 8090:8080
--tmpfs /data app`, then `APP_URL=http://localhost:8090 pnpm check` and
`node tools/playtest.mjs http://localhost:8090/ --suite=prodguard,save,viewports`.
Report what was actually run, and say plainly what wasn't verified.

## Process

- Commit real work as it happens; never rewrite or backdate history.
- `spec/invariants.test.ts` and `spec/global-setup.ts` are the course's: don't
  edit them. Add checks as new `spec/*.test.ts` files.
- `README.md`, `PROCESS.md` and `reflections/` are the author's. Draft them
  only when asked, and flag what needs the author's own judgment.
- Never print, commit or log the Fly token; it lives in `mise.local.toml`.
