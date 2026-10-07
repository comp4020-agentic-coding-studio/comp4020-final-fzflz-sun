# Process verification: 7 October 2026

Status: implementation checked by automated and agent review; no new player
feedback or artwork is claimed. Date: 2026-10-07, Australia/Sydney.

## Problem and scope

The author asked to apply the process review: existing browser checks were manual,
deployment CI checked only the homepage status, and release evidence remained in
chat. This stage adds production browser gates and artifacts, a stronger HTTP
deployment smoke, and reusable feature, first-play, art and release records.
The game's rules, save format and player-facing README did not change.

Starting commit: `01ea312e7bd66ee2933c2f84ca528bdfba3e3d4f`.
Implementation: [`0485d8b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/commit/0485d8b36681d4df022dc79b94460d84c563f492).

## Acceptance and observed results

| Scenario | Evidence and result |
| --- | --- |
| Existing game rules still hold | Type checking and all 328 tests passed against a local production server with a separate temporary data directory |
| A healthy deployment has files, full README and an isolated saved trace | `pnpm check:deploy` passed locally and against the existing Fly app; both disposable visitors' saves were cleared |
| A homepage 200 cannot hide missing files or broken persistence | Six fixture tests cover success, JS 404, JS served as HTML, headings-only README, an acknowledged-but-lost checkpoint and shared visitor state |
| Test selection cannot silently do no work | Unknown and empty browser suite arguments returned exit code 1 before launching Chrome |
| Production browser checks actually run on Linux | [PR CI run 37576846837](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/actions/runs/37576846837) passed the production Docker image, `prodguard,viewports` browser suites, HTTP smoke, evidence and credential checks |
| Results are retained | That run uploaded the browser screenshots, assertion log and dated `results.json` artifact, with a 14-day retention period |

The downloaded result reports Linux/headless execution, both suites completed,
61 browser assertions and zero failures. Eight screenshots were retained;
the phone fight and desktop victory-restore frames were also inspected by the
agent. The artifact identifies CI's tested merge commit
`01737715047f7b4dc3a9203cc73adb9b954dda03`; the implementation commit is linked above.

The local client build retained `index-COjw0JSB.js`. Docker was unavailable on
the author's computer during this change; the actual container/browser gate was
therefore verified in GitHub CI, rather than claimed as a local Docker run.
The Fly smoke checked the already deployed game; the checker was `0485d8b`,
and the game remained the C8 release at that observation. It did not deploy it
or test a Fly machine restart.

## Review corrections and limits

Agent review identified that artifact write failures could skip Chrome cleanup,
and failed WebSocket handshakes could leave connections behind. Cleanup is now
independent of artifact writing, and failed handshakes close their connection.
Chrome uses its own temporary profile and debugging port, with bounded request
and run timeouts. These failure paths were reviewed in code; disk failure and
forced browser crashes were not independently injected in this stage.

The [subsequent PR run 37577236657](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/actions/runs/37577236657)
failed one old browser assertion: killing `west-1` was assumed to clear the whole
West camp. The saved run correctly retained `west-2` and reported zero cleared
camps. The harness now compares the return screen to the saved roster's actual
camp count and checks kills/wins separately. This correction is also recorded in
`CLAUDE.md`. The [PR check history](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/pull/1/checks)
records verification of the correction; the earlier green run does not erase
this observed failure.

The author has not supplied new enjoyment judgments or independent player
observations for this change. The first-play and art sheets remain templates.
This is implementation evidence, not a new release record; the workflow's main
deployment run records any subsequent deployment and live smoke result.
