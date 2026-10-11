# Release record: co-op reaches production

Release / date / timezone / checker: 2026-10-11, Australia/Sydney, agent-run
(no human playtest of this deployment is recorded)
Status: deployed and verified
Repository: `comp4020-agentic-coding-studio/comp4020-final-fzflz-sun`
Exact deployed commit: `bb8d93d3a725884ea2198c6bc55763b71bbbc01c`
Live URL: https://comp4020-final-fzflz-sun.fly.dev/
Deployment workflow/run and result: GitHub Actions `checks` workflow, run
`38127922180` (triggered by the push to `main`), conclusion `success`
Release tag and resolved commit, if used: none used for this release

## Why this is a release, not just a merged stage

The previous co-op stage (commits `a1d639a`..`12c6e3b`) and this stage's own
commits (`ec65456`..`bb8d93d`) were all committed locally but never pushed —
confirmed before this release via `git fetch` (`origin/main` was 4, then 9,
commits behind local `HEAD`). The live site was still serving the pre-co-op
build: `/` returned 200 but `/coop.html` returned 404. This release is the
first time any co-op code has reached `origin/main`, CI, or Fly.

## Environment

- Runtime/container/host facts actually observed: Fly.io, single machine,
  `primary_region = "syd"`, `shared-cpu-1x` / `256mb` per `fly.toml`; the
  same Dockerfile verified locally in this stage (`docker build` + `docker
  run` on a named volume) is what CI's `deploy` job built and shipped.
- Limits or configuration, with source: no changes to `fly.toml` this
  release; `[mounts]` still backs `/data` with a persistent volume, which
  is what both the single-player and co-op SQLite files rely on.

## Verification (date, target build, method, result)

All on 2026-10-11, against the live deployment above, by the agent that
built this stage.

- **Automated rules/API checks**: `node scripts/verify-deploy.ts --
  https://comp4020-final-fzflz-sun.fly.dev` — passed (`ok: true`); its own
  `sourceRevision` field identifies the local checking checkout at
  `bb8d93d3a7258...`. It is not returned by the server and does not establish
  the deployed revision by itself. The commit attribution comes from the
  successful check/deploy workflow at this SHA, alongside observed live
  behaviour. This interpretation was corrected during the 11 October
  documentation review; the recorded check result is unchanged.
- **Production page and referenced assets**: `/` and `/coop.html` both
  return 200 (previously `/coop.html` was 404); `verify-deploy.ts` confirmed
  the referenced JS assets and README images resolve.
- **Browser entry/core interaction and console errors**: a real two-
  independent-browser run (`.local/coop-browser-check.mjs`, pointed at the
  live URL) — both browsers joined one room, saw each other move, zero page
  errors.
- **Save/reload/restart checks**: not re-run against the live Fly machine
  specifically this release (no Fly-level restart was performed) — restart
  persistence (room state, a mid-fight resume, a killed enemy staying dead)
  was verified against the actual production Docker image locally earlier
  in this stage, on a real `docker restart`. Those checks establish behaviour
  of the tested local production image; no image-digest comparison with Fly
  was performed. See this stage's card
  (`docs/process/2026-10-11-coop-reliability-and-perf.md`) for that
  evidence. `verify-deploy.ts`'s own single-visitor save round trip and
  visitor isolation passed against the live site.
- **Relevant viewports / input / regression scenarios**: not re-run against
  the live Fly URL specifically (mobile/viewport/formation checks were run
  against the dev server and the production Docker image, not re-pointed at
  Fly this release) — see "Not run" below.
- **Secret scan scope and result**: covered by the same CI `checks` workflow
  run (`38127922180`) that this release's deploy job depended on; not
  re-run separately by the agent outside that workflow.

## Evidence links

- `docs/process/2026-10-11-coop-reliability-and-perf.md` — this stage's
  full card, with the dev-server and production-Docker-image evidence this
  release's deploy was built from.
- `docs/adr/0006-coop-perf-and-reliability.md` — the architecture/causes
  this release implements.
- [GitHub Actions run 38127922180](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/actions/runs/38127922180)
  on the `checks` workflow.

## Local evidence that is not published

None beyond what's already cited above and in the stage card; no
screenshots were taken for this release specifically (the stage card's
production-Docker-image evidence used the same checks without screenshots).

## Failures and corrections with real commit references

None during this release itself — the push and CI run succeeded on the
first attempt. (Corrections made while building the commits being released
are recorded in the stage card's own Correction record table, not here.)

## Not run / remaining uncertainty

- No real Fly-level restart was performed during this release (the
  restart-persistence evidence is from the production Docker image run
  locally, not a live Fly machine restart/redeploy cycle).
- Mobile/phone and formation/camera checks were not re-pointed at the live
  Fly URL this release (they passed against the dev server and the
  production Docker image built locally with the updated Dockerfile;
  identity with Fly's separately built image was not checked).
- No human playtest of this deployment is recorded — all verification
  above is agent-run.

## Later working-tree changes not included in this release

None at the time of this record; the working tree was clean
(`worktreeDirty: false` per `verify-deploy.ts`'s own output) at the moment
of verification. Like `sourceRevision`, this field describes the checking
checkout, not Fly's filesystem.

## Subsequent documentation and verification

The release-record commit `104e580` subsequently triggered
[workflow 38128190414](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/actions/runs/38128190414),
which also succeeded. This does not change the identity of the first co-op
release recorded above.

The [11 October source/documentation review](../process/2026-10-11-c9-documentation-review.md)
found recovery boundaries not covered by the recorded restart scenarios:
player HP is stored in a separate periodic room snapshot, ready status is
reset on restoration, and fight removal and final room state are separate
writes. These findings limit claims of exact crash recovery; no additional
Fly restart or human playtest was performed during that review.
