# Stage card: C10 follow-up — five reproduced gaps from the 18 October review

Title / date: C10 follow-up fixes, 2026-10-19
Status: implemented and verified locally (including a fresh production
Docker image); not yet committed, not yet deployed
Starting commit: `3fd04f7` (C10's deployed state); the review's own
documentation-only commit `e0319c7` landed on top of it before this round's
code work began

## Player problem and evidence

A follow-up review (`docs/process/2026-10-18-c10-review.md`) ran the
already-implemented C10 checks against the deployed app and did isolated
reproductions. `docs/process/2026-10-18-c10-follow-up-prompt.md` turned
the findings into acceptance cases. I independently re-read the actual
source for each of the five findings before touching anything:

1. **Bracketed nicknames crash Kaplay's canvas text.** `makeLabel()`
   (`src/coop-main.ts:163`) passes a name straight into `k.text()`.
   Kaplay's styled-text grammar (confirmed by reading
   `dist/kaplay.js`'s `$n()`) treats unescaped `[`/`]` as style-tag syntax
   and a trailing unescaped `\` as an error, throwing `Styled text error:
   unclosed tags ...` inside `applyState()` — one bad name aborts that
   whole state-apply pass for every client that receives it. `escapeHtml`
   (the existing DOM-sink protection) does nothing for this different
   sink. `cleanName()` (`server/coop/ws.ts:62`) only trims/truncates;
   it never touches bracket/backslash characters.
2. **Card-play logs lie.** `handleFightAction` (`server/coop/ws.ts:571-575`)
   logs the raw client-sent `targetKey` for any successful `playCard`
   with no card-name field. `FightSession.applyAction`
   (`fight-session.ts:397-401`) only validates `targetKey` for
   `kind === "single"` — a Guard/Cleave/Focus play's log line carries
   whatever arbitrary string the client attached, unbounded. Separately,
   `armReconnectTimer`'s forced-flee path (`ws.ts:515-516`) logs
   `coop.fight.flee result=ok` unconditionally, never checking
   `forceFlee`'s own `ActionResult.ok` — the one real failure case
   (already-downed/already-fled, `fight-session.ts:440`) is misreported
   as a successful flee.
3. **The seq contract is broken, not just mis-documented.** `applyAction`
   (`fight-session.ts:390`) sets `ps.lastSeq = seq` before the
   per-action-type validation that can still reject (card-not-in-hand,
   insufficient energy, invalid target). A rejected `playCard` at seq=2
   still advances `lastSeq` to 2; a legitimate End Turn still carrying
   seq=2 afterward is then rejected as stale. The protocol doc
   (`src/coop-protocol.ts:148-152`) calls `lastSeq` "the last-accepted"
   action — accepted, not merely attempted.
4. **A real test-fixture flake, not a permission bug.**
   `spec/coop-auth.test.ts`'s "after a rejected action, the legitimate
   player can still act normally" assumes a random 4-card hand contains
   an affordable non-single card; a freshly-dealt hand can legitimately
   be all-Strike (`buildDeck` in `src/cards.ts`: 5/3/3/3 split, shuffled).
   `tools/coop-live-check.mjs` already handles this (round 4's own
   correction record); this spec test does not. `tools/coop-xss-check.mjs`'s
   fixed w+d diagonal heading is the same geometric-miss class already
   fixed once in `tools/coop-identity-demo-check.mjs`'s `steerToward()`,
   never back-ported.
5. **A wiped run has no visible way forward.** `FightSession.finish()`
   (`fight-session.ts:520-527`) nulls `fightId` on any outcome but never
   resets `rp.hp` — it stays 0 after a wipe. `selectRoster`
   (`encounter.ts:97`) correctly never re-forms a fight for a 0-HP
   player, but `room.setIntent`/`tick` (`room.ts:172-188`) still let them
   move freely, and the client (`coop-main.ts:871-873`) shows only a
   transient status line with no persistent "expedition over" state or a
   way to start fresh.

I also independently confirmed the review's correction about
`verify-deploy`'s `sourceRevision`/`worktreeDirty` fields
(`scripts/verify-deploy.ts:286-292`): read via `git rev-parse HEAD`/`git
status --porcelain` against the *checking* repo's own local checkout —
they can never fingerprint a remote container.

## Desired improvement

A crafted bracketed/backslash display name displays correctly for every
connected player with no client-side parse exception. A successful
card-play log line always carries the server-confirmed card name/kind,
and a non-single card's log line never carries an attacker-supplied
`targetKey`. A forced-flee timeout that didn't actually free the player is
never logged as a successful flee. A rejected action never advances a
player's action sequence, so a legitimate retry at the same seq always
succeeds. The flaky fixture/check failures are fixed deterministically,
not retried into green. A wiped party sees a clear, persistent "this
expedition has ended" state with a working path to start a new one.

## This stage includes

- `escapeKaplayText()` in `src/coop-protocol.ts`, applied at every
  dynamic canvas-text call site for a player-supplied name in
  `src/coop-main.ts`.
- `ActionResult.summary` (server-confirmed card name/kind/validated
  target) threaded from `FightSession.applyAction` into `ws.ts`'s
  `coop.fight.card` log line; `armReconnectTimer`'s forced-flee path
  checks `forceFlee`'s real return value before logging/broadcasting.
- `ps.lastSeq` only advances on an action that actually returns
  `{ ok: true }`, not on a rejected one; `CoopHandMsg.lastSeq`'s doc
  comment corrected to say so, and the "a rejected action never changes
  any state" claim narrowed to what's actually true.
- `spec/coop-auth.test.ts`'s affordable-card lookup fixed to handle an
  all-single hand without throwing, plus a deterministic
  `fight-session.test.ts` unit test forcing that exact scenario;
  `tools/coop-xss-check.mjs`'s heading replaced with the same live
  steering `tools/coop-identity-demo-check.mjs` already uses.
- `room.setIntent` gated on `p.hp > 0`; a small persistent "expedition
  ended" panel in `coop.html`/`coop-main.ts` for the `wiped` outcome,
  reusing the existing `#screen`/`#panel` dialog and the existing
  create-room flow — no revive, no accounts, no growth system.

## Rule boundaries

- Trigger and allowed actions unchanged: this stage fixes accuracy/safety
  of existing mechanisms, not new rules.
- Edge cases: a rejected action still never mutates fight/player/card
  state (unchanged); it additionally now never advances the action
  sequence either. A non-single card's log line never contains any
  client-supplied free text. A wiped player cannot move or re-enter a
  fight; nothing here revives them.

## Save impact

None to the persisted save shape. No `PersistedFight`/`PersistedFightPlayer`
field changes.

## Acceptance scenarios

| Action | Observable result |
| --- | --- |
| A names a room `[Sun]`; B joins via invite link | No `Styled text error`; both clients show the name correctly and have a non-null position/roster |
| A legal Guard play carries a 2048-char garbage `targetKey` | The log line has `cardName: "Guard"`, no `targetKey`, and never contains the garbage string |
| A legal single-target Strike with a real target | The log line has `cardName: "Strike"` and the real target key |
| A downed player's reconnect window times out | Logged `result: "rejected"`, never `"ok"` |
| An invalid card is rejected at seq=2, then a legitimate End Turn at seq=2 | The End Turn succeeds, not rejected as stale |
| `spec/coop-auth.test.ts`'s rejected-action-recovery test, run repeatedly | Passes deterministically regardless of the dealt hand |
| `tools/coop-xss-check.mjs`, run repeatedly | No longer intermittently misses the fight formation |
| A party wipes together | Each affected player sees a persistent "expedition ended" panel with a working "new expedition" button; cannot move or re-enter combat afterward |

## Checks selected and why

Unit-level (`src/coop-protocol.test.ts`, `server/coop/fight-session.test.ts`)
for the pure escaping/seq/summary logic, since these are deterministic
claims that don't need a live server. Extended `server/coop/ws.test.ts`
(same injectable-sink pattern as the prior round) for exact log-content
assertions. `spec/coop-auth.test.ts` fixed in place, since it's an
HTTP/WS-level claim about real client recovery. Real-browser
(`tools/coop-xss-check.mjs` extended, plus a small new wipe-flow browser
check) because only a real DOM proves no parse exception and that the
panel actually renders and its button works, at both a desktop and a
phone viewport.

## Review evidence

- **2026-10-19, agent, local unit tests (Node 24, macOS)**: `pnpm typecheck`
  clean; `pnpm test:unit` 441 tests passing — new: `src/coop-protocol.test.ts`
  6 tests for `escapeKaplayText` (normal names unchanged, `[Sun]`, a lone
  `[`/`]`, a trailing backslash, backslash-before-bracket ordering,
  mismatched-tag-shaped input); `server/coop/fight-session.test.ts` extended
  with 2 tests confirming `ActionResult.summary` carries the real
  server-confirmed card name/kind and only a validated target for a
  single-target card, 4 tests on the seq-contract fix (card-not-in-hand,
  insufficient-energy, invalid-target rejections never advance `lastSeq`;
  a real success still does), and 1 deterministic test constructing an
  all-Strike hand directly (bypassing the shuffle) and confirming
  `applyAction` handles it correctly — the non-flaky regression for the
  review's finding 4; `server/coop/room.test.ts` extended with 1 test
  confirming a 0-HP player's `setIntent` is a no-op and their position is
  unchanged across ticks.
- **2026-10-19, agent, extended `server/coop/ws.test.ts`** (same
  injectable-sink pattern as the prior round, 4 new tests): a Guard play
  with a 2048-character garbage `targetKey` logs `cardName: "Guard"`, no
  `targetKey`, and the garbage string appears nowhere in the log line; a
  legitimate Strike play logs the real card name and real target; a
  downed player's simulated reconnect-window timeout (via the new
  `testHandleReconnectTimeout` hook) logs `result: "rejected"`, never a
  false success; a normal (not downed) timeout still logs `result: "ok"`
  with `summary.left: true`. `pnpm check` (typecheck + full spec/unit
  suite) passed at 462 tests.
- **2026-10-19, agent, real HTTP/WebSocket against the dev server**
  (`spec/coop-auth.test.ts`'s fixed "after a rejected action, the
  legitimate player can still act normally" test): rewrote the affordable-
  card lookup to fall back to a real single-target card against a live
  enemy when the dealt hand happens to be all-single-target, and replaced
  fixed `sleep()`-then-read-stale-message waits with polling for the next
  actual message of the expected type (`waitForNext`), with diagnostics
  (hand/fight content) on timeout. Ran 20 times in a row against the dev
  server (`-t "after a rejected action"`): 20/20 passed. The deterministic
  all-Strike-hand unit test above (not RNG-dependent) is the primary proof
  this exact scenario is actually fixed, independent of what any given
  spec run happens to deal.
- **2026-10-19, agent, real headless Chrome, local rooms only**
  (`tools/coop-xss-check.mjs`, extended): replaced the fixed w+d diagonal
  heading with the same live `steerToward`/`walkTogether` steering already
  proven in `tools/coop-identity-demo-check.mjs`; added 6 new bracketed/
  backslash/mixed-script name scenarios (`[Sun]`, a lone `]`, a lone `[`,
  `mismatched]tag[`, a trailing `\`, and a mixed Chinese/backslash/bracket
  name), each run through a real two-profile create/join-by-invite-link
  flow, asserting a resolved identity, a non-null `selfPos`, a populated
  player list, correct DOM display, and zero page errors. Ran against the
  dev server 6 times total across this round's work: 6/6 passed (the
  steering fix's own effect — previously ~1-in-3 failed on "both players
  enter a shared fight"). Ran 3 more times against the fresh production
  container: 3/3 passed.
- **2026-10-19, agent, a new real-browser check** (`tools/coop-wipe-check.mjs`,
  new, wired into `package.json` as `check:wipe` and into CI): a solo
  player is worn down by west-1's own deterministic 3-damage-per-round
  attack (no RNG in damage) to a real 0-HP wipe by repeatedly ending turn
  without defending, then asserts the persistent "expedition ended" panel
  appears, its text names the real outcome, its button is present, and
  clicking it actually navigates to a fresh `/coop.html`. Run at both a
  desktop (1280x800) and phone (390x844) viewport: both passed, against
  both the dev server and the production container.
- **2026-10-19, agent, the actual production Docker image** (fresh build,
  fresh container, `--tmpfs /data`): `APP_URL=... pnpm check` passed (462
  tests, including 3 repeated runs of the previously-flaky spec test, all
  passing); `pnpm check:browser` passed in full; `pnpm check:deploy`
  passed (`ok: true`; its `sourceRevision`/`worktreeDirty` fields describe
  this checking checkout's own local git state, not the container, per
  the review's own correction — `worktreeDirty: true` here is expected
  and correct, since this round's fixes were uncommitted at the time of
  this sweep); `tools/coop-live-check.mjs` (pre-existing, untouched file)
  passed 4/5 repeated runs, the one failure being the already-documented,
  unrelated all-Strike-hand flake from round 4's own correction record
  — confirmed via `git diff` showing zero changes to that file this
  round; `tools/coop-xss-check.mjs` 3/3; `tools/coop-log-check.mjs` and
  `tools/coop-identity-demo-check.mjs` both passed; `tools/coop-wipe-check.mjs`
  passed at both viewports; `docker logs` on the running container
  confirmed real `coop.fight.card` lines carrying `cardName`/`cardKind`
  with non-single cards' `targetKey` always `null`, and real
  `coop.fight.flee` lines carrying the new `forced`/`requested`/`left`
  summary fields; `pnpm check:evidence` passed (18 cited commits in
  PROCESS.md all resolve, all three reflection files found). Container
  and image removed after the sweep; no state left running.
- **Not run as part of this round**: a real Fly deploy of these fixes, and
  `flyctl logs` exercised against the live app with them — both require an
  actual deploy, pending the user's go-ahead. The real two-person
  narrate-from-logs demo likewise remains unperformed by an agent.
- **Author feedback**: none yet on this round's fixes specifically.

## Reviewed implementation commits

- `5291631` — `escapeKaplayText`, applied in `coop-main.ts`; extends
  `tools/coop-xss-check.mjs` with bracketed/backslash name scenarios and
  live steering (replacing its fixed diagonal). Also includes the wipe
  panel's client-side code in `coop-main.ts` (staged together before this
  commit) and the `lastSeq` doc-comment correction in `coop-protocol.ts`.
- `50beb47` — `ActionResult.summary`, honest forced-flee logging, the
  `lastSeq`-only-advances-on-success fix, and their tests.
- `442a36e` — fixes `spec/coop-auth.test.ts`'s all-single-hand fixture
  flake and its fixed-sleep message-reading pattern.
- `3157699` — `room.setIntent`'s HP gate, its test, `tools/coop-wipe-check.mjs`,
  and CI/`package.json` wiring.

## Deployment

Not deployed as part of this stage. The production image built and swept
above was a local, throwaway build for verification only — not pushed,
not the image any deployed Fly app is running. See the end-of-stage report
for what remains before a push/deploy.

## Next decision

Whether these fixes, once verified, are ready to ship via the existing
release flow, and what (if anything) still needs a real two-person demo
beyond what's already covered.
