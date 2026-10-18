# Crit 10 reflection: Fly by instruments

*Author-review draft, 18 October 2026, prepared with Codex from recorded
requests and repository evidence. Personal conclusions need author review;
no human two-person demo is claimed.*

## What was the breakthrough that moved the work forward?

The useful shift was making shared play explainable from server evidence.
I had already asked for nearby players to enter encounters automatically
while retaining their own cards and choices. C10 made identity, ownership
and observation explicit parts of that experience.

The existing anonymous cookies supplied an identity model. The implementation
documented its costs, narrowed room peeking, tested private hands and
introduced business logs. Real browser profiles then exercised joining by
invitation, independent actions and reconnecting. Those checks give concrete
evidence for the design.

The latest review also challenged their scope. A permissions test failed
because it assumed a particular random hand. A bracketed nickname broke the
canvas text parser despite the earlier HTML fix. Logging checks passed while
review still found a failed forced flee recorded as success. These findings
make precise acceptance scenarios essential.

## What did this work change about who I want to be as a software developer?

I want to make the intended experience, server rules and evidence agree.
Being able to see an event name is only a starting point: the record needs
to identify the actor and accurately describe what actually happened.

My repeated requests for review and more concrete prompts show the workflow
I want to develop. Corrections should become useful checks and clear process
records. I also need to distinguish code inspection, isolated reproduction,
deployment evidence and human judgment. The deployed build has passed CI;
a real two-person session narrated from its logs remains an outstanding
observation.
