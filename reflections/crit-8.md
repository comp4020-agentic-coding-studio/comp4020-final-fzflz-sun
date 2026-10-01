# Crit 8 reflection: It's alive!

<!-- DRAFT, assembled by the agent from our sessions and the commit history.
     Facts below were checked against the conversation and the repo. Sentences
     marked CONFIRM are personal judgements only you can make: keep, rewrite
     or delete each one, then delete all of these comments before the cutoff
     (Wed 7 Oct, 13:30). -->

## What was the breakthrough that moved the work forward?

The breakthrough was turning "it feels wrong" into a rule the agent could be
held to. Most of my corrections started as a feeling during play. Moving
during combat felt like an action grinder. Timed enemy attacks made reading
my hand cost HP. Crowds made intents unreadable. What moved things was naming
the principle behind those complaints: *thinking should be free, and the
player chooses the size of every fight.* Once it was written down, it became
a phase machine with tests, a formation layout with tests, and promises in
the README. After that the agent's work could be checked against something
other than my reaction to it.
<!-- CONFIRM: is this the breakthrough you'd pick? Other moments from the
     record: v2 locking movement in combat, or v4 switching to strict turns. -->

The second turn came when the agent reported v5 as finished, and it didn't
even load. Typecheck and build were green. Only a real browser showed the
crash. Browser playtests are now part of what "done" means in `CLAUDE.md`.

## What did this work change about who I want to be as a software developer?

<!-- CONFIRM: this whole answer is a proposal built from what happened; the
     feelings and the takeaway have to be yours. -->
I want to be a developer who directs by evidence.
<!-- CONFIRM: true of how you reviewed? -->
In this project I reviewed by playing, not by reading diffs, and that worked
for how the game felt. It didn't catch a game that never started.
<!-- CONFIRM: did you trust the report? -->
I had trusted the report. The same thing showed up in the words: the README
said every chasing enemy joins a fight, while the code only took nearby
ones. I want to keep the fast loop of specifying, playing and correcting,
and make every "done" come with something I can check myself: a test, a
screenshot or a run I can repeat.
