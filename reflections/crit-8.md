# Crit 8 reflection: It's alive!

<!-- DRAFT assembled by the agent from our sessions. Every factual claim below
     happened; the judgement calls are marked "AUTHOR:" — rewrite them in your
     own words, then delete these comments. -->

## What was the breakthrough that moved the work forward?

The breakthrough was turning "it feels wrong" into a rule the agent could be
held to. For three versions I kept rejecting builds by feel. Moving during
combat made it an action grinder. Timed enemy attacks made reading my hand
cost HP. Crowds made intents unreadable. What moved things was naming the
principle behind each complaint: *thinking should be free, and the player
chooses the size of every fight.* Once I wrote it down, it became a phase
machine with tests, a formation layout with tests, and promises in the
README. After that the agent's work could be checked against something other
than my mood.

The second turn was when the agent called v5 finished and it didn't load.
Typecheck and build were green. Only a real browser showed the crash. Now
browser playtests are part of "done".

<!-- AUTHOR: is this the breakthrough you'd pick? Alternatives from the record:
     the first build that locked movement in combat (v2), or the turn-based switch (v4). -->

## What did this work change about who I want to be as a software developer?

I want to be a developer who directs by evidence. In this project my review
was playing, not reading diffs, and that worked for feel. It didn't catch a
game that never started, because I trusted the report. I want to keep the
fast loop of specifying, playing and correcting. I also want every claim of
"done" to come with something I can check myself: a test, a screenshot or a
reproducible run.

<!-- AUTHOR: say in your own words how it felt to discover the "done" build
     didn't run, and whether "directing by evidence" is really your takeaway. -->
