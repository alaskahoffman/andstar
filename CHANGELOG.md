# changelog

## 0.3.0

Reading settings. A settings button in the header (play pages and the editor
preview) opens reader-side options, saved per device for every game:

- **Text size**: scales the reading surface (and sidebar) in steps.
- **E-ink mode**: a calm two-color view (light background, dark text) that
  overrides the author's colors. Where meaning was carried by color, it's
  restated in text: red checks become a dashed "⚠ one-shot", already-picked
  choices read "· seen" / "· done".

These layer on top of author theming and never change the author's file.

More accessibility, beyond those toggles:

- New lines are announced to screen readers as they appear.
- Keyboard focus is clearly outlined, and choices advance with space or enter.
- The player honors the system "reduce motion" setting, dropping the fades
  and slides while keeping the reading pace.
- Secondary (dimmed) text is a little brighter across the board.

Also: in click-to-continue, the echo of the choice you just made and
bookkeeping notices (item acquired, progress saved) appear and then advance on
their own, so a tap is only ever spent on new prose. Already-read lines recede
by shrinking, not only dimming, so your place is always the largest line. Text
size scales the sidebar and system notices too, and check chips have room to
breathe before the choice text.

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
