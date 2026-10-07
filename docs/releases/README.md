# Release evidence

Record what was checked on an exact deployed commit, with dates and limitations.
Stage implementation evidence belongs in the
[iteration card](../process/README.md); this directory records deployment results.

- [Crit 8: 3 October 2026](2026-10-03-crit-8.md) is a historical account of the
  agent-driven release checks performed that day.
- The process documentation added on 7 October 2026 has not been deployed by
  this documentation change. It is not part of the Crit 8 release above.

## Release record template

Copy into a dated file only when there is an actual release or attempted release.
Use `passed`, `failed` or `not run` for each relevant check. An empty template or
a successful local build is not evidence of a deployed version.

For future releases, run `pnpm check:browser` against the production image and
`pnpm check:deploy -- <live-url>` against the deployment, then record the target
commit and observed results below. Keep any extra gameplay review tied to the
feature being released. These checks do not retroactively extend older records.

```text
Release / date / timezone / checker:
Status: attempted | deployed and verified | verification incomplete
Repository:
Exact deployed commit:
Live URL:
Deployment workflow/run and result:
Release tag and resolved commit, if used:

Environment:
- Runtime/container/host facts actually observed:
- Limits or configuration, with source:

Verification (date, target build, method, result):
- Automated rules/API checks:
- Production page and referenced assets:
- Browser entry/core interaction and console errors:
- Save/reload/restart checks (record each separately):
- Relevant viewports / input / regression scenarios:
- Secret scan scope and result:

Evidence links:
Local evidence that is not published:
Failures and corrections with real commit references:
Not run / remaining uncertainty:
Later working-tree changes not included in this release:
```

Check that a tag resolves to the verified deployment, rather than assuming the
current branch is what is running. Historical records remain dated records;
append a later release or correction instead of relabelling old checks as new.
Do not publish session cookies, tokens or private test data as evidence.
