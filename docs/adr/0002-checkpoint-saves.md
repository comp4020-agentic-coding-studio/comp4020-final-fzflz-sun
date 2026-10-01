# ADR 0002: Anonymous visitors, one checkpoint per run, saved at stable moments

Status: accepted (crit 8), 2026-10-01

## Context

"A stranger can come back and find their trace" needs a server save. The game
mixes real-time exploration with turn-based fights, formation animations and
a queued enemy resolve, none of which serialise cleanly.

## Decision

- **Who:** an anonymous visitor per browser: a random 256-bit HttpOnly cookie,
  stored server-side only as its SHA-256. No accounts (see README: software
  for a few known people can skip them).
- **What:** one checkpoint per visitor for the current run: player HP and
  position, every map enemy's HP keyed by a stable id from `src/world.ts`
  (never the runtime `enemyId`), run stats and outcome. Enemy positions are
  not saved; they restore at home, so formation slots can't leak into saves.
- **When:** at run start, the instant a fight triggers, and after victory,
  flee and death. Closing mid-fight restores the pre-fight checkpoint.
- **Integrity:** writes carry the revision they're based on (409 on a stale
  tab); the server validates structure and progression (no reviving kills,
  stats never go backwards, ended runs are final).
- **Loss:** a new run archives the old one into history; only an explicit
  `{"confirm":"erase"}` (typed ERASE in the UI) deletes data.

## Costs

- Closing the tab mid-fight undoes that fight's damage on both sides. The rule
  is stated in the game; it's a known soft exploit.
- The client is still the authority on what happened in a fight; the server
  only rejects impossible states, not unlikely ones.
- Walking around after the last checkpoint isn't saved.
