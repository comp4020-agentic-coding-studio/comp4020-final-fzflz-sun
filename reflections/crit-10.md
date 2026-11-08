# Crit 10 reflection: Fly by instruments

## What was the breakthrough that moved the work forward?

The useful shift was making shared play explainable from server evidence.
I had asked for nearby players to enter encounters automatically while
retaining their own cards. C10 made identity, ownership and observation
explicit parts of that experience.

Anonymous cookies supplied an identity model. Documented permissions,
private-hand tests, business logs and independent browser profiles made its
guarantees inspectable.

The 18 October review exposed an invalid hand assumption, nickname text
crashes and falsely successful flee logs. Follow-up commits addressed those
paths, sequence handling and expedition endings. The suite reached 472 tests,
and local production-browser checks passed. An earlier live check failed once
in five runs; the cause was an all-Strike hand assumption, and the fix landed
in the check rather than a retry. Further review found queued flee described
as departure and the ending panel absent after reload or reconnect;
`f567620` and `0b14516` closed both.

## What did this work change about who I want to be as a software developer?

I want to make the intended experience, server rules and evidence agree.
Being able to see an event name is only a starting point: the record needs to
identify the actor and accurately describe what actually happened.

My repeated requests for review and concrete prompts show the workflow I want
to develop: corrections become useful checks and clear records. I also need to
distinguish inspection, local reproduction, deployment evidence and human
judgment. A two-person session driven through two independent HTTP/WebSocket
identities verified the deployed build at `ec0fd87`, including a real Fly
machine restart (7/7), late join (13/13) and a captured log stream; it also
found the queued-flee and ending-panel gaps. The project has since deployed
`1ea1de8`.

That is evidence the mechanism works, not evidence that two people enjoy
playing. I have not yet played the deployed game with another person. The
agent-driven test and a real two-person playtest answer different questions,
and the latter remains outstanding.
