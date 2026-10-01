# ADR 0003: Monsters as data (tier, role, pack), downed-not-dead, save v2

Status: accepted, 2026-10-01

## Context

Every enemy was the same grunt plus one boss, so the only decision in a fight
was how many to pull. The next step was enemies that change *which* card and
*which* target: a swarm for Cleave, a mage that revives, an elite that
charges. A revive needs fallen enemies to stay in the fight, which the old
code (destroy at 0 HP, and save 0 HP as a permanent kill) couldn't express.

## Decision

- **Data, not code.** `src/world.ts` gives each unit a tier, a role, an
  action cycle and a group; groups are `skirmish` or `pack` (shared alert,
  shared leash, joins whole). Six camps on the existing map, v1 ids kept.
- **One pure combat module.** `src/combat.ts` owns intents, damage, the
  downed state, revive, the enemy turn and confirmed deaths, so tests and the
  balance simulator run the exact rules the game runs.
- **Downed until the fight ends.** At 0 HP a unit is downed in its slot; it
  can be revived only within that fight, and is confirmed dead (and counted)
  when the fight ends by victory, flee or death.
- **Save v2** adds each elite / boss phase. Old saves are migrated by the
  server on read; the rules are in `upgradeSave`.
- **No healing yet.** `tools/balance.ts` (greedy bot, 2000 runs) survives a
  whole run 98.7% of the time on 24 HP without it, so completion doesn't need
  a new mechanic; the 1.4% deaths are all at the Warlord.

## Costs

- The roster rule now has two parts (nearby chasers + alerted packs), which
  players have to learn; the ground hint and outline carry that.
- A pack alerted by a careless approach can pull a bigger fight than intended;
  that's the point, but it can feel harsh. Judged in play.
- The bot is an approximation of a player; balance claims based on it are
  marked as such in the README.

## Verification at the time of the decision

`pnpm test:unit` (rules incl. combat, encounter, save migration, store
migration), `tools/playtest.mjs --suite=monsters,groups,combat` on the dev
server, `tools/persistence-check.sh` (incl. a v1 save planted in the
production container), and the production image suites listed in CLAUDE.md.
