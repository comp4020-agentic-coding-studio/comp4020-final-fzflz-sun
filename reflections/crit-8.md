# Crit 8 reflection: It's alive!

## What was the breakthrough that moved the work forward?

The breakthrough was turning "it feels wrong" into a rule the agent could be
held to. Most of my corrections started as a feeling during play. Moving
during combat felt like an action grinder. Timed enemy attacks made reading
my hand cost HP. Crowds made intents unreadable. What moved things was naming
the principle behind those complaints: *thinking should be free, and the
player chooses the size and place of every fight.* Once it was written down,
it became a phase machine with tests, a formation layout with tests, and
promises in the README. After that the agent's work could be checked against
something other than my reaction to it.

The second turn came when the agent reported a version as finished, and it
didn't even load: a custom field name collided with the engine's own, and the
game crashed on the very first load. Typecheck and build were both green.
Only a real browser showed the crash. Browser playtests, not just green
checks, are now part of what "done" means in `CLAUDE.md`.

## What did this work change about who I want to be as a software developer?

I want to be a developer who directs by evidence, not by trust. In this
project I reviewed by playing, not by reading diffs line by line, and that
worked well for judging how the game felt. It didn't catch a game that never
started — I had trusted the agent's report instead of checking myself. The
same gap showed up in the words, not just the code: the README said every
chasing enemy joins a fight, while the actual rule only pulled in nearby
ones. Both times, the fix was the same instinct: ask for something I can
check myself — a test, a screenshot, a run I can repeat — rather than a
claim. That's the habit I want to keep past this course: specify, let the
agent build, then verify before believing "done."
