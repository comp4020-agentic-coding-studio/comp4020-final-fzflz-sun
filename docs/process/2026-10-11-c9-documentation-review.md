# C9 documentation review — 11 October 2026

Checker: Codex. Starting commit: `104e580`. Scope: update PROCESS.md and
create reflections/crit-9.md, preserve existing performance evidence, and
correct a release-evidence interpretation. No gameplay changes or deployment.

## Curated direction from the actual conversation

These are selected author statements from the conversation, not invented
earlier prompts or an independent playtest transcript. This file records
them on 11 October; it does not assign unrecorded dates to each statement.

- Against a counters-only shared layer: “只是用简单的数值来体现每个人的贡献”.
- On the game's direction: “转成探索+战术卡牌这样的形式，而非单纯的堆砌敌人数量”.
- Proposed proximity entry: “在一定范围内，一个触敌同时战斗，一旦脱离过远则不触发”.
- Requested a concrete implementation prompt: “内容涉及到多人模式体系的搭建”.
- Actual feedback on the earlier version: “我没找到多人的选项” and
  “而且很卡，帧率非常低”.

Codex's first implementation prompt converted this into a shared world,
fixed world-distance membership, independent cards, one enemy round, personal
flee and server authority. Its next prompt required measuring rendering
and snapshot intervals separately, fixing the four review findings, and
verifying phone input and process-boundary recovery. These are curated
constraints from the real prompts, not a claim that Claude Code consumed
every word unchanged.

The author has not provided post-fix feedback confirming smoothness,
multiplayer balance or the target-selection rule. The first-person
conclusions in PROCESS and the C9 reflection remain author-review drafts.
The C8 reflection is unchanged.

## Evidence reviewed

- Real commits from `a1d639a` through `104e580`, current implementation,
  ADRs 0005/0006, both co-op stage cards and the first co-op release record.
- Existing ignored measurement JSON copied unchanged to
  [baseline](evidence/coop-perf-baseline.json) and
  [after](evidence/coop-perf-after-phaseB.json). This preserves earlier
  agent measurements; no new performance run was performed here.
- Moving host samples: average rAF interval 16.67 ms in both files;
  average rAF ticks between displayed position changes 8.78 before and
  1.02 after. These are short local/headless samples, without embedded
  revision, hardware or capture-time metadata. Stage documentation supplies
  their attribution; the JSON alone does not prove an exact build or user
  experience.
- GitHub workflow 38127922180: successful check and deploy jobs, head
  `bb8d93d3a725884ea2198c6bc55763b71bbbc01c`.
- Subsequent workflow 38128190414: success at `104e580`.
  These are workflow provenance, not server-returned version identifiers.
- Current course pages: [C9](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/09-all-at-once/)
  and [written artefacts](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/assessment/#word-counts).
  The overview is rewritten for C9; the new reflection uses the exact
  crit-9.md filename and answers the two standing prompts.

## Findings that limit the account

1. Fight restoration now exists, so the previous absence must not be
   described as the current implementation. However,
   [fight-session.ts](../../server/coop/fight-session.ts) does not serialize
   player HP or ready status. HP comes from the separately debounced
   [room snapshot](../../server/coop/ws.ts); restore sets ready to false.
   A crash between writes may roll back HP, and a pending fleeing player
   may regain card actions. This is a source-review finding, not a new
   crash reproduction.
2. Fight persistence and room updates are separate writes; victory deletes
   the fight row before writing the final room snapshot. The existing
   restart scenarios do not establish atomic recovery at every process
   interruption point. Avoid describing all recovery as exact.
3. The release verifier's `sourceRevision` and `worktreeDirty` are read
   from the local Git checkout in
   [verify-deploy.ts](../../scripts/verify-deploy.ts). They are not read
   back from Fly. The release record is corrected accordingly.
4. Existing check:evidence accepts any one of the C8/C9/C10 reflections and
   checks cited local commit objects. It does not establish C9 completeness,
   authorship, link validity or gameplay correctness by itself. This review
   checks the new C9 file, word counts and relative links separately.
5. Historical agent checks are kept distinct from the author's earlier
   feedback. Phone/formation and restart checks in the release record were
   local production-image checks, not live Fly checks or independent play.

## Checks for this documentation change

Run on 11 October against the uncommitted documentation changes above
`104e580`:

- `mise exec -- pnpm check:evidence`: passed; C8 and C9 files found,
  all 11 cited commit objects resolve locally.
- `git diff --check` and a separate whitespace check covering new files:
  passed.
- Exact C9 filename, both standing-prompt headings and all relative links
  in the four changed Markdown documents: passed.
- Overview length: 913 whitespace-separated words after removing link
  targets; reflection is within the indicative 150–300 words, including
  its review note and headings.
- Both preserved JSON files match their ignored originals byte for byte;
  their moving-host metrics agree with the summary above.

No new game, browser or performance checks were run. No commit, push or
deployment was performed for this documentation change.

## Update, 2026-10-11 (Claude Code)

Both findings in this review's item 1 are fixed:

- Player HP and ready status are now part of `FightSession`'s own
  per-action persisted record (not left to the separately-debounced room
  snapshot), fixed in `b2896df` and verified with a real server restart
  (actual damage taken, immediate restart, HP restored exactly, not rolled
  back to a stale value).
- A further, more careful look at the same restart path (not prompted by
  this review, but in the same spirit — reading the source again rather
  than trusting the prior "resumes exactly" claim) found four more real
  gaps: no legacy-format compatibility for a fight row missing `hp`/
  `ready` entirely, a fight-id collision risk across a restart, a fled
  player that could be re-locked on restore, and non-atomic fight-end
  persistence with notification before persisting. All four are fixed and
  verified with real server restarts; see
  `docs/process/2026-10-11-coop-restart-hardening.md` and
  `docs/adr/0006-coop-perf-and-reliability.md`'s hardening addendum for the
  causes, fixes and evidence.

This review's other findings (item 2: fight persistence and room updates
as separate writes — now addressed by `CoopStore.finishFight`'s single
transaction; item 3: `sourceRevision`/`worktreeDirty` describing the local
checking checkout, not Fly — unchanged, and respected in all evidence
produced this round) stand as originally recorded above.
