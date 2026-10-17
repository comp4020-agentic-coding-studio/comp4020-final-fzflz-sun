# Crit 10 reflection: Fly by instruments

*Author-review draft, 17 October 2026. Drafted from the actual work done this
round, not from a recorded design discussion — unlike crit 9's reflection,
there is no author-stated feedback or feeling behind this round's choices to
draw from yet. The paragraphs marked below need the author's own words before
this file can be considered finished; nothing here claims a real human
two-person demo or crit feedback has happened.*

## What was the breakthrough that moved the work forward?

*[PENDING — needs the author's own account.]* What can be stated as fact,
not feeling: the actual breakthrough this round was procedural rather than a
new idea. A source review of the existing co-op server found that the
identity and authorization mechanics C10 asks for were already correct,
built in crit 9 and never revisited since — both `cc_visitor` and `cc_coop`
were already server-derived from a hashed cookie, never a value the client
could supply, and every fight action already traced back to the connection
that sent it, not anything named in the message body. The real work this
round was proving that, not building it: writing the permission table down
in [ADR 0007](../docs/adr/0007-coop-identity-and-permissions.md), finding
the one place it genuinely wasn't true (the room-peek endpoint handing out
the full member list to anyone who knew the code), and adding the logging
and automated checks that turn "the server already does this" from a
code-reading claim into something a test — and eventually a real demo
narrated from `flyctl logs` — can actually show.

*[The author should say here whether this \"it was already correct\" result
felt like a relief, a letdown, or something else — and whether discovering
that through a deliberate source review (rather than a symptom report, the
way every earlier round started) changed how they think about verifying a
system versus just building the next feature on top of it.]*

## What did this work change about who I want to be as a software developer?

*[PENDING — needs the author's own account.]* One thing this round made
concrete: a system that is correct but silent is not yet trustworthy to
someone who didn't write it. Before this round, nobody — not a teammate, not
the author a week later — could look at the running server and say with any
confidence who did what, or prove that one player genuinely couldn't act as
another; that confidence lived only in the source code and the author's own
memory of having read it carefully. Building `server/log.ts` and the checks
around it was less about adding a feature and more about making an existing
guarantee legible to someone who isn't the person who wrote it.

*[The author should say here what this changes about how they'll build the
next system — whether "can someone else tell what happened, just from what
it wrote down" becomes a standing question they ask before calling something
done, and whether that connects to or complicates the evidence habit from
crit 8/9.]*
