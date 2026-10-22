# Crit 10 reflection: Fly by instruments

*Author-review draft, 19 October 2026, prepared with Codex from recorded
requests and repository evidence. Personal conclusions need author review;
no human two-person demo is claimed.*

## What was the breakthrough that moved the work forward?

The useful shift was making shared play explainable from server evidence.
I had asked for nearby players to enter encounters automatically while
retaining their own cards. C10 made identity, ownership and observation
explicit parts of that experience.

Anonymous cookies supplied an identity model. Documented permissions,
private-hand tests, business logs and independent browser profiles made its
guarantees inspectable.

The 18 October review exposed an invalid hand assumption, nickname text
crashes and falsely successful flee logs. Follow-up commits address those
basic paths, sequence handling and expedition endings. Claude Code recorded
462 passing tests and local production-browser checks; another live check
failed once in five runs. Further review still found queued flee described
as departure and the ending panel absent after reload or reconnect.

## What did this work change about who I want to be as a software developer?

I want to make the intended experience, server rules and evidence agree.
Being able to see an event name is only a starting point: the record needs
to identify the actor and accurately describe what actually happened.

My repeated requests for review and concrete prompts show the workflow I
want to develop: corrections become useful checks and clear records. I also
need to distinguish inspection, local reproduction, deployment evidence and
human judgment. A real multi-user test session (agent-driven: two
independent HTTP/WebSocket identities, not two people each in a real
browser) has now verified CI, deployment and a real Fly restart for commit
c8a4b10, and found two further gaps this latest round closed. A real
two-person session narrated from its logs — the one kind of evidence none
of this replaces — remains outstanding.
