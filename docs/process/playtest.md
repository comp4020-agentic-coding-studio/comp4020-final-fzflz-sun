# Independent first-play review

Status: reusable template. No independent sessions are recorded by this file.

Use one unchanged build with two or three people who have not played it before.
Observe each session separately. Give them the normal entry screen and let them
try the game before explaining its systems. Do not replace their observations
with the author's or an agent's playthrough.

## Session

```text
Date / observer:
Build commit / URL / local or deployed:
Participant ID / prior card-game or action-game experience:
Device / viewport / input:
Task stated to the participant:
```

Start with a simple task such as “start a run and clear a camp.” Afterwards, ask
them to leave and return to their run. Use additional tasks only for the feature
being reviewed; do not demonstrate the intended solution first.

## Observe before explaining

| Moment | What to record |
| --- | --- |
| Entry | Where they first look, how they start, what they think the goal is |
| First encounter | What they think triggered it; whether the roster makes sense |
| Player turn | Whether they understand cards, energy, targets and enemy intents |
| Enemy turn / flee | What they expected, what happened, and any surprise |
| Return | Whether they recognize saved progress and know how to resume |

Record actions and exact words only when actually observed. If help is necessary,
note the point and what was explained; later success may depend on that help.

```text
Observed sequence (time or event, action, result):
Points of hesitation / misunderstanding:
Help given:
Player's words, if recorded:
```

## Ask after play

- What were you trying to do, and what did you think the enemy would do next?
- Which decision changed the outcome? Which part was difficult to understand?
- What would you choose to try next, if anything?

Avoid asking whether a proposed solution is “better” before identifying the
problem. Separate confusion about the rules from disagreement with the rules.

## Co-op session (two participants)

Status: reusable template. No independent co-op sessions are recorded by
this file — "awaiting playtest" until two real people actually play
together. An agent's own real-browser checks
(`tools/coop-live-check.mjs`, `tools/coop-restart-check.sh`) prove the
server/client wiring works; they are not a substitute for this, must never
be written up as if they were human feedback, and must not alone justify
changing the attack-target rule below.

Needs two participants on their own devices (or two browser profiles on
one device, if that's what's available), joining the same room live, not
one person playing both sides in sequence.

```text
Date / observer:
Build commit / URL / local or deployed:
Participant A: ID / prior card-game or multiplayer experience / device / viewport / input:
Participant B: ID / prior card-game or multiplayer experience / device / viewport / input:
Room code / how it was shared:
Network: same room, same network, or two genuinely separate connections:
```

Ask them to find the co-op entry themselves (don't hand them the URL
pre-opened) and create/join one room together.

| Moment | What to record |
| --- | --- |
| Finding the entry | Whether they find it from the normal start/menu screens without being told where to look |
| Joining | Whether creating/sharing/joining the room code is clear |
| Exploring together | Whether a nearby teammate auto-joining a fight, and a far one staying free to explore, matches what they expected |
| Waiting on each other | Whether they can tell whose turn it is and who they're waiting on |
| A personal flee or death | Whether the consequence (they leave or fall, the other keeps fighting) is clear to both, not just the one who acted |
| Playing together | Whether they actually discuss targets, which cards to play, or when to Guard — or play silently past each other |
| Feel, on real devices/network | Whether movement still feels choppy on their actual hardware and connection, not just localhost |

```text
Observed sequence (time or event, action, result) — note which participant:
Points of hesitation / misunderstanding, and which participant:
Help given:
Players' words, if recorded:
```

## Ask after a co-op session

- Who did you think you were waiting on, and when?
- What happened when [the other player] fled or fell — did you expect that?
- Did the game ever attack you specifically in a way that felt unfair or
  hard to plan around? (This is the draft lowest-HP attack-target rule in
  [ADR 0005](../adr/0005-coop-multiplayer.md) — record what's actually
  said, don't lead with "should low-HP players get targeted more?")
- Was there anything you wanted to do together that the game didn't let you?

```text
Co-op sessions completed / build(s):
Entry/join friction observed:
Auto-join-radius behavior: matched expectation / surprised them, and how:
Attack-target rule: felt fine / felt punishing / no opinion formed, and why:
Real-device/real-network smoothness, separate from any localhost measurement:
One prioritized change and why:
Reviewed fix commit / follow-up observation, when available:
Still unverified:
```

These sessions can reveal whether the shared-world/auto-join/individual-
flee design actually reads as intended to two people playing together, and
whether the draft attack-target rule feels fair. They do not prove general
multiplayer balance, long-run cooperative depth, or behavior under a real
degraded network beyond what the two participants happened to have. Keep
original observations when updating the summary; a later fix never rewrites
an earlier session's record.

## Combined review after two or three sessions

```text
Sessions completed / build(s):
Repeated observed problem and affected participants:
Single-player observations worth following up:
Interpretation (label as an interpretation):
One prioritized change and why:
Acceptance scenario for that change:
Reviewed fix commit / follow-up observation, when available:
Still unverified:
```

These sessions can reveal onboarding and readability problems. They do not prove
general satisfaction, long-run balance or multiplayer capacity. Keep the original
observations when updating the summary so a proposed fix does not rewrite them.
