# Art sample and asset record

Status: future workflow and templates. This file does not introduce artwork or
claim that an art review has been completed.

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
