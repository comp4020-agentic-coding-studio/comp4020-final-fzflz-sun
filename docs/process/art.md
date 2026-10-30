# Art sample and asset record

Status (30 October 2026): one agent-reviewed sample exists on branch
`cc/art-sample` (recorded below). It has not been reviewed by the author or by
a player, is not merged or deployed, and is not a full art set. The workflow
and templates below still govern any expansion.

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

Not run: a production Docker image build, a Fly deploy, or any check against
the deployed app. This branch is not merged.

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
| Acceptance evidence | Agent sample review above, 30 October 2026. Not yet accepted by the author. |

### Reviewed implementation commits

- `b76d406` — the five SVGs, `src/art/sprites.ts`, and the rendering changes
  in `src/main.ts` / `src/coop-main.ts`. The review above was made on this
  code (uncommitted at review time, on top of `b7665ec`).
- (next commit) — this record.
