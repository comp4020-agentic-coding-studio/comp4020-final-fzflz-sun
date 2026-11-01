# Art sample and asset record

Status (30 October 2026): one art sample (recorded below) is merged to `main`
in merge commit `a2f7a0c` and deployed. CI
[run 41050641974](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/actions/runs/41050641974)
passed `check` and `deploy` for that commit. The only review is an agent review
by Claude Code; the author then asked for it to be merged and deployed. No
author screenshot review, author playtest or player review is recorded. It is
a first sample, not a full art set. The workflow and templates below still
govern any expansion.

## Review one playable sample first

Before producing a full set, make a small sample with the player, one normal
enemy, one elite, the boss and one card. Check it in an actual encounter using
the existing HUD, intent labels and targeting. Use a crowded encounter as well
as a simple one, at desktop and phone sizes.

Write a short style contract:

```text
Camera / projection:
Palette / outline / lighting:
Player, normal, elite and boss size hierarchy:
Team / role recognition beyond color alone:
Logical size / anchor / transparent padding:
Animation and effect scope for this sample:
```

Judge the sample by play: bodies and roles are recognizable, intents and numbers
remain readable, selecting a target matches the visible body, and attack/death
effects do not hide the next decision. Keep collision, fight footprints and save
positions independent of decorative sprite bounds.

For each candidate choose `accept`, `adapt`, `reject` or `defer`, with a reason.
Review the accepted sample before expanding the set. Store editable sources when
available and a reproducible export recipe; the production build must use tracked
runtime assets rather than an ignored local source library.

## Sample review template

```text
Date / reviewer / build commit:
Sample assets / style contract:
Encounters and viewports inspected:
Role recognition / intent readability / targeting / effects observations:
Candidate decisions and reasons:
Adjustments and recheck result:
Reviewed commit:
Remaining art work:
```

## Asset record template

Record each accepted asset or a set sharing the same provenance. For original or
generated work, record its creation source and retained editable files rather
than inventing an external author or license.

| Field | Value to fill |
| --- | --- |
| Runtime file(s) | Tracked game asset path(s) |
| Author / creation source | Creator, pack, or recorded generation source |
| Original source | Source URL and local source file, when applicable |
| License / attribution | Actual license reference and required credit text |
| Modifications | Changes made, or unmodified |
| Editable source | Tracked source path, when available |
| Export recipe | Tool/settings or script; output size and format |
| Logical size / anchor | Gameplay size, pivot and padding rules |
| Acceptance evidence | Sample review date and real reviewed commit |

Keep the license or applicable credit with the selected set. Verify permission
for the actual exported assets; a pack being described as “free” is not its
license. Retain the record when replacing or adapting a file.

## Sample 1 — 30 October 2026 (branch `cc/art-sample`)

### Style contract

```text
Camera / projection: top-down 2D, unchanged. Tokens read as standing figures
  seen from slightly above and in front.
Palette / outline / lighting: dark, low-contrast ground (#1d211e–#202520) so
  units and intent text are the brightest things on screen. Each unit keeps its
  existing role hue as the dominant fill, so colour-based reading still works.
  Every token has a ~2px near-black (#121212) outline, one soft top-left
  highlight, and a flat ellipse contact shadow drawn inside its own box.
Player, normal, elite and boss size hierarchy: drawn size equals the existing
  logical size exactly — player 32, grunt 28, elite 40, boss 56 (swarmling 20
  and mage 24 are unchanged squares in this sample). Art is never larger than
  the logical body, so HP / intent / tag labels and target marker sit where
  they always did.
Team / role recognition beyond color alone: a silhouette per role — grunt is a
  squat figure behind a round shield; elite captain has a horned helm and
  pauldrons (and keeps the gold frame); boss has a crown and a banner pole;
  the player is a hooded explorer with a lantern. Co-op players share one
  sprite tinted to each member's colour, with their name label above.
Logical size / anchor / transparent padding: each SVG's viewBox is exactly its
  logical square; anchor centre; no padding beyond what the figure leaves
  transparent. sprite() is always called with explicit width/height equal to
  the logical size, and SVGs are rasterised at 4x for sharpness at fight zoom.
Animation and effect scope for this sample: none added. Existing hit flash,
  downed grey, fight dimming and target marker keep their timing and are
  applied to the sprite instead of the square.
```

### How it is wired (rendering only)

The existing body entity is unchanged: same `rect`/`circle` size, `area()`,
centre anchor, position, and outline components. It now draws with
`fill: false`, and the art is a child `sprite` pinned to exactly the same size.
Decorative bounds therefore cannot become collision, click area, fight
footprint, formation slot, server position or save data. Elite gold frames and
pack-hint outlines still come from the unfilled logical rect. Tint and fade
are routed to the art child: `tintBody` in `src/main.ts`, `setBodyOpacity` in
`src/coop-main.ts`. No pure rule module (`cards`, `turn`, `combat`,
`encounter`, `roam`, `formation`, `save`), server file, protocol message,
`LABELS` offset or footprint box changed.

The SVGs are imported with Vite's `?raw` and loaded as data URLs, so they are
bundled into `dist/assets/` (confirmed: the shared `world-*.js` chunk contains
them after `pnpm build`). This matters because the Dockerfile builds from
`src/`, not `public/`; a `public/` asset would have worked in `pnpm dev` and
been missing from the production image.

### Sample review

```text
Date / reviewer / build commit: 30 October 2026 / Claude Code (agent), not
  the author or a player / reviewed on top of b7665ec; reviewed code is commit b76d406.
Sample assets / style contract: player.svg, grunt.svg, elite.svg, boss.svg,
  ground.svg (5 of the 4–6 allowed); contract above. Camp clearings are a
  procedural two-tone circle, not a separate asset.
Encounters and viewports inspected (headless Chrome, local dev server unless
  noted):
  - crowded fight ?fight=3,1 (Warlord + pack + grunts), 1920x1080 and 390x844
  - simple fight ?fight=1,0, both viewports
  - elite fight ?fight=group:ridge (captain + escort), both viewports
  - the 33-enemy overflow fight from playtest (12 on stage, 21 in side list),
    960x540
  - a downed body and a Cleave hit flash, 1280x800
  - co-op shared map with two players (Ash, Birch) and a co-op fight, 1280x800
  - production build (NODE_ENV=production server): real solo fight with a
    server save at 1920x1080 and 390x844
Role recognition / intent readability / targeting / effects observations:
  - Boss and elite are recognisable at every inspected size, by silhouette as
    well as hue. The crowded and overflow fights stay readable: intent text
    and numbers keep full size, nothing overlaps, the side list still holds
    the rest.
  - Grunts lose their shield and face detail at small scale (about 18 screen
    px in the 960x540 overflow fight) and read as small red figures. Grunt vs
    boss is still instant; grunt vs a future similar-sized sprite would rely
    on hue.
  - A figure covers less of its logical square than the old filled square did,
    so normal units look smaller than before although nothing changed in size.
    The click area is still the full logical square.
  - Targeting: the yellow marker and selection match the visible body; the
    marker sits above the art, never on it.
  - Downed: the greyed, faded figure keeps its slot and is clearly distinct
    from standing units.
  - Hit flash: weaker than before. color() multiplies and cannot brighten, so
    the flash is a cold blue tint (0.15 s) rather than the old white square.
    The floating damage number remains the main hit signal.
  - Ground: no longer reads as a debug checkerboard and stays behind the
    units, but its horizontal band repeats in visible rows at exploration
    zoom.
  - Co-op: one player sprite tinted per member works (blue / orange both
    read); fight and away dimming apply to the art.
  - No page exceptions or console errors in any inspected run.
Candidate decisions and reasons:
  - player.svg: accept — distinct from enemies, tints cleanly for co-op.
  - boss.svg: accept — unmistakable at every size; crown and banner stay in
    its 56px box.
  - elite.svg: accept — horns and pauldrons separate it from grunts beyond the
    gold frame.
  - grunt.svg: adapt — fine at fight zoom, loses detail at small scale; a
    bolder, simpler silhouette is needed before more normal units are drawn.
  - ground.svg: adapt — keep the low contrast; break up the repeating band.
  - hit flash on sprites: adapt (code) — needs a brightening effect (e.g. a
    short white overlay child) to match the old feedback strength.
  - intent icon set and card frame: defer — intent text with exact numbers is
    a hard readability rule, and icons need their own readability check
    rather than being added unreviewed in this sample.
Adjustments and recheck result: ground.svg was redrawn once at lower contrast
  after the first pass competed with units and intent text; rechecked at both
  viewports and in co-op.
Reviewed commit: see "Reviewed implementation commits" below.
Remaining art work: swarmling and mage sprites; a bolder grunt; a
  non-repeating ground; a brighter hit effect; intent icons (with a
  readability review); card frame; the README screenshots
  (docs/fight-desktop.png, docs/fight-phone.png) still show the old squares
  and were deliberately not changed here; an author review and a play review
  of this sample.
```

### Checks run on this sample

All against the local dev server on :8080 unless noted, 30 October 2026:

- `pnpm typecheck`: clean.
- `pnpm test:unit`: 451 passed (17 files).
- `APP_URL=http://127.0.0.1:8080 pnpm check`: 472 passed (20 files).
- `node tools/playtest.mjs --suite=combat,viewports --headless`: 117 checks,
  all passed, exit 0. This includes the crowded and overflow layouts
  (`topLeft_boss7` with 10 on stage, the overflow stage, "warlord pack + 3")
  and real fights at 1920x1080 and 390x844. Note: its footprint checks use the
  declared boxes, not rendered pixels. They still hold because the art is
  pinned to the unchanged logical size; the screenshots above are the check on
  the art itself.
- `pnpm build`, then the production server (`NODE_ENV=production`) and
  `pnpm check:browser`: 68 checks, all passed (real fight, save and reload,
  visitor isolation, phone touch, resize mid-fight).
- Page exceptions / console errors captured over CDP in every screenshot run:
  none.

Not run before the merge: a local production Docker image build. CI built
and checked the production image instead (see "Deployment" below).

### Asset record

| Field | Value |
| --- | --- |
| Runtime file(s) | `src/art/player.svg`, `grunt.svg`, `elite.svg`, `boss.svg`, `ground.svg`; loaded by `src/art/sprites.ts` |
| Author / creation source | Original, hand-written SVG authored for this repository by Claude Code on 30 October 2026 at the author's request. No generator, pack or reference image. |
| Original source | None external; the tracked files are the source. |
| License / attribution | Same terms as this repository's own code. No third-party content, so no external credit is required. |
| Modifications | `ground.svg` redrawn once at lower contrast during the review; others unmodified since creation. |
| Editable source | The runtime files themselves (plain SVG text). |
| Export recipe | None. Vite imports each SVG with `?raw`; `sprites.ts` scales its width/height by 4 and passes it to Kaplay `loadSprite` as a data URL, which Kaplay rasterises once at load. |
| Logical size / anchor | player 32x32, grunt 28x28, elite 40x40, boss 56x56, ground 130x130 (= `GROUND_TILE`). Centre anchor. viewBox equals logical size; drawn with explicit `width`/`height` equal to logical size. Never used for collision, click area, footprint, formation or save. |
| Acceptance evidence | Agent sample review above, 30 October 2026, on code `b76d406`. Merged in `a2f7a0c` at the author's request and deployed by CI run 41050641974 the same day. No author or player review of the art itself is recorded. |

### Reviewed implementation commits

- `b76d406` — the five SVGs, `src/art/sprites.ts`, and the rendering changes
  in `src/main.ts` / `src/coop-main.ts`. The review above was made on this
  code (uncommitted at review time, on top of `b7665ec`).
- `f2bfcb2` — this record's first version.
- `9a6c77e` — README screenshots (`docs/fight-desktop.png`,
  `docs/fight-phone.png`) replaced with fresh captures of the sample, taken
  from `f2bfcb2` on the local dev server; alt text and the "not built yet"
  line updated.
- `a2f7a0c` — merge of `cc/art-sample` into `main` (`--no-ff`).
- (the commit after the merge) — this status and deployment record.

### Deployment

Merged to `main` as `a2f7a0c` and pushed; CI
[run 41050641974](https://github.com/comp4020-agentic-coding-studio/comp4020-final-fzflz-sun/actions/runs/41050641974)
passed `check` (production image build plus the full suite, including the
browser, co-op, XSS, logging and wipe checks) and `deploy`.

Checked against the deployed app on 30 October 2026:

- `pnpm check:deploy -- https://comp4020-final-fzflz-sun.fly.dev`: `ok: true`.
  Its `sourceRevision` (`a2f7a0c`) describes the checking checkout, not the
  server, so it was not taken as proof of the deployed code. Server-returned
  evidence instead: the deployed app serves `world-C5ncGKK8.js` and
  `main-DzyLQiXw.js`, the same fingerprints as a local `pnpm build` of this
  code; the deployed `world-*.js` contains all five SVGs; both deployed
  README images are byte-identical (SHA-256) to the tracked files; the
  deployed README serves the new "not built yet" line and none of the old
  alt text.
- `node tools/coop-live-check.mjs <deployed>`: 27/27, first run.
- `node tools/coop-wipe-check.mjs <deployed>`: 18/18, both viewports, first
  run, including reload after a wipe, no page errors.
- `/` and `/readme/` in headless Chrome at 1920x1080 and 390x844: both README
  images load at their new sizes; a real run starts (16 enemies, server save
  confirmed) with the sprites drawn; no page or console errors. The
  disposable visitors were erased afterwards.

The repeating ground band is clearly visible on the deployed exploration view,
as recorded above; it remains an adapt item.

CI run 41051496195, for the commit that added this deployment record
(`fb5a75d`, a docs-only change), failed in `tools/coop-live-check.mjs`
scenario 5, so that commit was not deployed. The cause was in the check, not
the art or the game: when B's opening hand has no Strike (about 12.6% of
deals) B cannot kill west-1 in the first round, and the absent-but-active
player correctly blocks the round from resolving until their reconnect window
ends. The check now forms a fresh fight until B holds a Strike, before anything
under test happens, and uses the server's `lastSeq`. That fix and its
verification are in the following commit.

## Sample 1, polish pass — 1 November 2026 (branch `cc/art-polish`)

Scope: only the adapt items from Sample 1's review, plus the two missing
roles. No new renderer, no 3D, no rule, size, collision, click-area,
footprint or save change. Art stays a child sprite pinned to the logical
size; the style contract above is unchanged.

### What changed

- `grunt.svg` redrawn bolder: a broad red body and head carry the shape, the
  round shield is smaller and secondary, and the outline is thicker (2.5) so the
  figure still reads at about 18 screen px.
- Ground: `ground.svg` redrawn as low-contrast speckle and grass tufts, with no
  band or large blobs; new second tile `ground-b.svg`. `groundTileFor(i, j)` in
  `sprites.ts` picks the tile and flips from an integer hash of the cell, the
  same in solo and co-op, so neither rows nor diagonals repeat.
- Hit flash: `sprites.ts` builds a white silhouette of each unit SVG at load
  time (fills and strokes made white, contact shadow dropped) and loads it as
  `<name>-flash`. Each enemy with art gets that silhouette as a second child at
  the same logical size, with opacity 0; `flash()` in `main.ts` sets it to the
  art's current opacity and fades it to 0 over `HIT_FLASH_DURATION` (0.15 s).
  Units without art keep the old tint flash.
- New `mage.svg` (24x24, teal hooded robe with a staff) and `swarm.svg`
  (20x20, orange many-legged bug); `ROLE_SPRITE` now covers every role. The
  mage's `+` glyph is drawn only when it has no art, since the staff carries
  the cue.

### Sample review

```text
Date / reviewer / build commit: 1 November 2026 / Claude Code (agent), not
  the author or a player / reviewed on top of ef21561 (commit below).
Sample assets / style contract: grunt.svg (redrawn), ground.svg (redrawn),
  ground-b.svg, mage.svg, swarm.svg, plus generated flash silhouettes;
  contract unchanged.
Encounters and viewports inspected (headless Chrome, local dev server):
  - crowded fight ?fight=3,1 (Warlord + pack + grunts + swarmling),
    1920x1080 and 390x844
  - simple fight ?fight=1,0 and elite fight ?fight=group:ridge, both viewports
  - the 33-enemy overflow fight from playtest, 960x540
  - north camp (mage + grunts) at 1920x1080 and 390x844, and the mage revive
    intent (playtest monsters suite)
  - Cleave hit flash and a downed body, 1280x800
  - co-op shared map with two players and a co-op fight, 1280x800
Role recognition / intent readability / targeting / effects observations:
  - Grunt: body and head read first, shield second; in the overflow fight it
    still reads as a small figure with a shield rather than a blob. Simple at
    that size by design.
  - Mage and swarmling are now figures, not squares, and are told apart from
    grunts by silhouette as well as hue. SHOOT 2 and REVIVE +3 intents and
    the revive target line ("Mage (north-mage) will revive Grunt (north-1)")
    stay fully readable above them.
  - Ground: no horizontal band at exploration or fight zoom. A faint tile
    edge is still just perceptible between the two variants on a large
    screen; it stays behind units and text.
  - Hit flash: a short white silhouette of the exact figure, clearly brighter
    than the sprite, then fading; a downed (dimmed) unit flashes at its own
    lower opacity. The floating damage number is unchanged.
  - Player hit feedback is still the red tint on the player sprite (not part
    of this pass).
  - Footprints, slots, labels and click areas unchanged (art drawn at logical
    size); playtest layout checks pass.
  - No page exceptions or console errors in any inspected run.
Candidate decisions and reasons:
  - grunt.svg: accept — readable at fight zoom and in the overflow fight.
  - ground.svg + ground-b.svg: accept — band gone; faint tile edge noted.
  - white-silhouette hit flash: accept — restores a brightening hit cue.
  - mage.svg, swarm.svg: accept — visual set now consistent, no squares left
    in normal play.
  - intent icons and card frame: still deferred (same reason as Sample 1).
Adjustments and recheck result: grunt redrawn twice (the first redraw let the
  shield dominate); ground redrawn twice (the first rework made a lattice of
  light spots); flash peak raised to the art's full opacity after it looked
  washed out. Each rechecked at both viewports.
Remaining art work: intent icons (with a readability review); card frame;
  a player hit flash matching the enemy one; softening the faint tile edge;
  an author review and a play review of the art.
```

### Checks run

Local dev server on :8080, 1 November 2026, on the final code of this pass:

- `pnpm typecheck`: clean.
- `pnpm test:unit`: 451 passed (17 files).
- `APP_URL=http://127.0.0.1:8080 pnpm check`: 472 passed.
- `node tools/playtest.mjs --suite=combat,viewports --headless`: 117 ok,
  0 failed (crowded, overflow and real fights at 1920x1080 and 390x844).
- `node tools/playtest.mjs --suite=monsters,groups --headless`: 62 ok,
  0 failed (packs, mage revive, elite cycle, every camp at both viewports).
- Screenshot runs over CDP: 0 page errors.
- `pnpm build`: the new SVGs are bundled into `dist/assets/world-*.js`.

The playtest footprint checks use the declared boxes, not pixels; they hold
because the art is pinned to the unchanged logical size.

### Asset record additions

| Field | Value |
| --- | --- |
| Runtime file(s) | `src/art/ground-b.svg`, `mage.svg`, `swarm.svg` (new); `grunt.svg`, `ground.svg` (redrawn); `<unit>-flash` sprites generated at load by `silhouette()` in `src/art/sprites.ts` (no file) |
| Author / creation source | Original, hand-written SVG authored for this repository by Claude Code on 1 November 2026 at the author's request. No generator, pack or reference image. |
| Original source | None external; the tracked files are the source. |
| License / attribution | Same terms as this repository's own code. No third-party content. |
| Modifications | grunt and ground each redrawn twice during this review (see above). |
| Editable source | The runtime files themselves (plain SVG text). Flash silhouettes derive from them; edit the unit SVG, not the flash. |
| Export recipe | Same as Sample 1 (`?raw` import, 4x raster via data URL). Silhouettes: same path after a regex pass that whitens every `fill`/`stroke` and removes the shadow ellipse. |
| Logical size / anchor | mage 24x24, swarm 20x20, ground-b 130x130; centre anchor; viewBox equals logical size. Never used for collision, click area, footprint, formation or save. |
| Acceptance evidence | Agent review above. No author or player review of the art is recorded. |

README screenshots (`docs/fight-desktop.png`, `docs/fight-phone.png`) were
replaced with captures of the crowded fight from this pass's code; alt text
unchanged.
