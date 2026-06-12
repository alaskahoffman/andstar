# changelog

## 0.2.0

The reading update, from the first 48 hours of playtester feedback.

**Reading**

- Click-to-continue pacing is the default: each tap, space, or enter reveals
  the next line. Authors choose with `@reveal click | paced | off`.
- Text above the newest line dims, so your place is always the bright edge.
- Narration renders at full contrast (it's the story, not chrome); only your
  own echoed choice stays dim.
- Skill voices are no longer italic; the bold colored name carries them.

**Choices**

- Check and cost tags render as chips, visible without hovering.
- Red checks outline the entire choice in red, permanently.
- Choices you've picked before turn red. A picked `[once]` choice stays
  visible but locks, instead of vanishing.

**Skills**

- Failed white checks now reopen only when the skill itself is upgraded.
  Equipment improves rolls but cannot reopen a failed check.
- New effect `~ skill name +1` / `-1`: an author-directed change to one
  skill, announced to the player.

**Docs**

- A full reference now lives at /docs: every declaration, line type,
  bracket, and effect with descriptions and examples, plus the dice rules.

Existing published games pick all of this up automatically, including the
new default pacing; add `@reveal paced` or `@reveal off` and republish if
you prefer the old behavior.

## 0.1.0

Initial release: the script language (skills that speak, white and red 2d6
checks, equipment, currency, fail states, checkpoints, theming), the editor
with live errors and warnings, publishing to bare links, and self-contained
zip export for itch.io.
