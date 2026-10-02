# ADR 0004: Enemies roam, can be pulled away, and keep their place in saves

Status: accepted, 2026-10-02

## Context

Enemies stood on their spawn points until noticed and walked straight home
after a chase, so the map was static and "splitting a pack" had no lasting
effect. The aim: a living map where leading enemies somewhere is a choice
that sticks, while the final boss stays the fixed goal at the end.

## Decision

- **Four positions, kept apart** (`src/roam.ts`): fixed spawn, real position,
  activity center, fight slot. Only the first three exist outside a fight,
  and only position, center and homing are saved.
- **Wander** around the center: a target in the disc, walk at 32-46% of chase
  speed, pause 0.8-2.6 s, abandon a blocked leg after 5 s. Loners use a 55-70
  px radius; pack members 45 px around their own offset from the pack's
  shared center, so a pack stays recognisable.
- **Give up by tier.** Grunts and elites: when the player has been beyond
  1.35x aggro range (from a loner, or from the *nearest* chasing pack-mate)
  for 0.6 s, they settle where they are and stand calm 1.5 s. The boss: the
  same, or on reaching 380 px from its lair, then walks home ignoring the
  player and calms there.
- **Links, not camps, decide who acts together**: alerts and rosters follow
  chains of pack-mates at most 240 px apart. A guard pulled away from its
  boss stops waking it, and vice versa. The original group still decides
  identity and camp progress.
- **Save v3** stores each living enemy's position, center and homing flag;
  older saves place everyone at spawn, which is what they used to show.

## Costs

- A settled enemy can end up somewhere awkward (a corner, next to another
  camp). That's the player's doing and is visible; the camp pointer and
  pack hints follow the real positions.
- Wander positions between checkpoints are lost on reload: a restore starts
  from the last stable moment (fight start, flee, victory, a settle, the boss
  getting home), not from the exact frame.
- Saves are bigger (one place per living enemy, ~16 entries).

## Verification at the time of the decision

`src/roam.test.ts` (wander bounds and pauses, corners, hysteresis, pack
settle, lagging mage, link clusters, boss homing and lair radius, guards
apart, flee settle), save v3 and migration tests, `tools/playtest.mjs
--suite=roam` and the other suites on the dev server and the production image,
and `tools/persistence-check.sh` (a pulled-away enemy's place across restart
and rebuild, v1 saves placed at spawn).
