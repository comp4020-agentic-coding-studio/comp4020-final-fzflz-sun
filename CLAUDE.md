# Camp Clearer: rules for agents working in this repo

The argument for what good means is `README.md`. These are the standards a
change must meet; each one came from a playtest correction or a bug that
reached a build. Pure rules live in `src/cards.ts`, `src/turn.ts`,
`src/combat.ts`, `src/encounter.ts`, `src/roam.ts`, `src/formation.ts`, `src/separation.ts`,
`src/save.ts` and the data in `src/world.ts`; keep them free of Kaplay and the
DOM so they stay testable, and keep every fight state change in
`src/combat.ts` (main.ts animates, it doesn't decide).

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

## Monsters are data, and each one changes the plan

- Units are described in `src/world.ts`: tier (normal / elite / boss) is how
  dangerous, role (grunt, swarmling, mage, captain, warlord) is what it does,
  `pattern` is its action cycle. Add or tune a unit there, not in main.ts.
- A new unit or camp needs a reason in play: what card, target order or Guard
  timing it asks for. Check it with `node tools/balance.ts` (whole runs must
  stay winnable) and `node tools/balance.ts hand` (does one hand play
  differently against it?), then by playing.
- Skirmishers notice and give up alone. A pack's alert spreads only along
  links of pack-mates at most `LINK_RADIUS` apart, its chasing members give
  up together, and its linked, alerted members join a fight together. A
  fight's roster is the trigger, nearby chasers and their linked pack-mates:
  no recursion, no duplicates, fixed once formation starts (`src/encounter.ts`).

## Enemies move, and stay where they are

- Keep the four positions apart (`src/roam.ts`): the fixed spawn (layout,
  migration, boss home), the real position (exploring, chasing, saving), the
  activity center (what idle units wander around), and the fight slot
  (display only). A fight slot must never become a position, a center, or
  anything in a save.
- Grunts and elites can be led anywhere; when they give up (out of reach for
  the delay window) they settle where they are: a new center at their spot,
  or at a pack's centroid plus each member's offset. Move a center only at
  such moments, never while picking wander targets.
- A boss's center is always its spawn. It gives up at the edge of its lair or
  when out of reach, walks home ignoring the player, and only then calms.
- Exploration runs only while exploring: the menu and fights freeze it, and
  a restored save continues from where it was saved, with no time skipped.
- Save positions, centers and boss homing whenever the world is checkpointed,
  plus when enemies settle or the boss arrives home (debounced), through the
  ordered save queue.
- A fallen enemy is *downed*: it keeps its slot and is shown as a body until
  the fight ends, and only then is it confirmed dead and counted, once by
  stable id. Never destroy an enemy mid-fight.
- A mage's revive follows `src/combat.ts` exactly: same-pack grunt or
  swarmling that fell on an earlier turn, half HP, one success per mage and
  one per member per fight, shown with its target before the enemy turn,
  cancelled if the mage falls, fizzles (never re-targets) if the target is
  up, and the revived unit waits a turn. Confirmed-dead enemies never return.
- Elite and boss phases persist across flee, reload and new fights; a charge
  that resolved is followed by its heavy hit, never reset.

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
  `enemyId`. Never renumber or reuse an id; a new member gets a new id.
- Changing the save shape, an enemy's max HP or the set of ids needs a version
  bump and a migration in `upgradeSave` (dead stays dead, wounded HP scaled,
  new members dead in a cleared camp or an ended run), applied by the server
  on read, with tests (`src/save.test.ts`, `src/store-migration.test.ts`).
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
node tools/playtest.mjs --suite=monsters,groups   # packs, revive, elite cycle; every camp at both viewports
node tools/playtest.mjs --suite=roam   # wandering, pull-away, Warlord homing, guards apart, saved places
node tools/balance.ts [runs]           # whole runs with the real rules: must stay winnable
sh tools/persistence-check.sh       # saves survive restart and rebuild (Docker)
pnpm check:evidence
```

For the production image: `docker build -t app . && docker run -p 8090:8080
--tmpfs /data app`, then `APP_URL=http://localhost:8090 pnpm check`,
`pnpm check:browser http://localhost:8090/` and
`pnpm check:deploy -- http://localhost:8090/`.
The browser and deploy checks run in CI against the production image before deployment.
The deploy check also runs against Fly after deployment; it checks the page,
referenced assets, full README and a checkpoint kept apart from a second guest.
It cleans only its newly created test guests' saves. It does not prove a real
browser fight or persistence across a Fly restart.
For save races and legacy migration additionally run
`PLAYTEST_CONTAINER=<name> node tools/playtest.mjs http://localhost:8090/ --suite=race,legacy`.
Chrome is detected on macOS/Linux/Windows, or overridden with `CHROME`.
Browser screenshots and a dated result with revision are saved to
`.local/checks/browser/` (`SHOTS` overrides it); CI retains them for 14 days.
Report what was actually run, and say plainly what wasn't verified.

## Process

- Start each substantial feature with the short acceptance card in
  [the working process](docs/process/README.md): player problem, scope,
  rules and save impact, observable acceptance scenarios. Close it with
  actual checks, author corrections and real commits. Keep unfinished work
  labelled pending; do not backfill invented decisions or test results.
- Separate agent-driven regression checks from independent player feedback.
  Use [the playtest sheet](docs/process/playtest.md) for first-time players;
  leave observations empty until someone actually plays.
- Keep [release records](docs/releases/README.md) dated and tied to the
  verified commit and workflow. Preserve old crit tags after their cutoff.
- Before producing art in bulk, use [the art sample checklist](docs/process/art.md)
  in a real fight and record each asset's source, licence and export settings.
- Commit real work as it happens; never rewrite or backdate history.
- `spec/invariants.test.ts` and `spec/global-setup.ts` are the course's: don't
  edit them. Add checks as new `spec/*.test.ts` files.
- `README.md`, `PROCESS.md` and `reflections/` are the author's. Draft them
  only when asked, and flag what needs the author's own judgment.
- Never print, commit or log the Fly token; it lives in `mise.local.toml`.
