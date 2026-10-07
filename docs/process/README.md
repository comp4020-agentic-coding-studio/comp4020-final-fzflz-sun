# Small, reviewable gameplay iterations

Use this workflow for the next playable change. `README.md` defines the intended
experience; `CLAUDE.md` contains current implementation constraints; accepted
architectural decisions live in `docs/adr/`. Keep those as the sources of truth.
This guide adds a way to record a change and its review, without duplicating them.

- [Independent first-play template](playtest.md)
- [Future art sample and asset record](art.md)
- [Release record template and dated releases](../releases/README.md)
- [Process tools: actual 7 October verification](2026-10-07-verification.md)

## Working loop

1. Describe a player problem and one observable improvement. Write the stage
   card below before asking an agent to implement it. Separate this stage from
   the larger monster → loot → talents → art direction.
2. Build the smallest complete playable change. State changes go through the
   existing rule modules; include save migration and wording changes when needed.
3. Run checks that cover the changed behavior and its concrete risks. For client
   changes, also play in the browser. Observe the sequence before, during and
   after the change, including desktop and phone when layout or input changes.
4. Record the author's actual play feedback. Turn a recurring correction into a
   rule in `CLAUDE.md` and a useful regression check. Keep design rationale in an
   ADR when the decision changes architecture or persistence semantics.
5. Commit the reviewed stage with its evidence. Add the real commit reference
   afterwards; never invent earlier checkpoints or imply a command was run.
   Deployments get a separate [release record](../releases/README.md).

Automated checks, agent browser checks, author play and independent player play
answer different questions. Label each result with who checked it, when, and
which commit or working tree it covered. A passing test count alone does not
establish readability, enjoyment, balance or production behavior.

For the production image, `pnpm check:browser` runs the automated production
guard, save and viewport scenarios. After deploying, use
`pnpm check:deploy -- <live-url>` for page/assets, the complete README and isolated
visitor save checks.
Record their actual results in the release record; those commands do not replace
the author's review of the changed gameplay or independent first-play sessions.

## Stage card template

Copy this into a short dated note under `docs/process/`, or use the same fields in
the implementation request. The blank fields below are a template, not evidence
that a stage has happened.

```text
Title / date:
Status: proposed | implemented, awaiting play review | reviewed | deferred
Starting commit:

Player problem and evidence:
Desired improvement (what the player should notice or choose differently):
This stage includes:
Later work:

Rule boundaries:
- Trigger and allowed actions:
- Edge cases / rejected actions / interruption behavior:
- Current rule or ADR links affected:
Save impact: none, or changed fields/version/migration/checkpoint rules
UI wording and feedback affected:

Acceptance scenarios (action → observable result):
1.
2.
3.
Checks selected and why:

Review evidence:
- Date, checker, environment, commit/working-tree state:
- Automated results actually run:
- Browser scenarios and viewports actually inspected:
- Author feedback (actual observation, not an inferred feeling):
- Independent player evidence, if any:
- Remaining uncertainty:

Correction record:
- Observed problem → agreed rule → fix/check → result:
- Durable constraint or ADR updated, if needed:

Reviewed implementation commit(s):
Deployment: not deployed, or link to the release record
Next decision:
```

Keep the card brief. Link existing checks, screenshots and commits instead of
copying their output. Only record a successful outcome after seeing it.
