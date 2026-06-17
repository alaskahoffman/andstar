# changelog

## 0.4.0

The systems update. Skills, equipment, items, and stats each got room to do
more, and the sidebar reorganized to match.

**Skills**

- A skill can carry a description: `skill hands "The Hands" #d98b6a = 3 "what
  it is"`. It shows on the character screen and as a sidebar tooltip, so a
  player knows what they're choosing.
- The build screen now lets you pull a skill down to 1 as well as up to 9 (or
  the author's max), so you can min-max by trading points from one skill to
  another. Mid-game level-ups honor the same ceiling.

**Items, three kinds**

What an item modifies is what it is:

- A **skill** modifier (`item flask "Hip Flask" gut+2 logic-1`) is
  **equipment**, worn from the wardrobe.
- A **stat** modifier (`item cup "Cup of Water" water+1`) is a **consumable**:
  it sits under ITEMS with its effect shown, and the reader clicks it any time
  to apply the change and spend one. Their economy to manage, not only the
  author's gates.
- No modifier is a **key item**, just carried.

Items also stack: `~ give water 3`, `~ take water`, shown as `×N`. And
`has(item)` now reads as the count, so `[has(cup) > 1]` and `{has(cup)}` work,
while a bare `[has(cup)]` still means "any."

**Equipment slots**

- A slot caps how many of a kind you can wear at once. Declare one with `slot
  hat "Headwear"` (limit 1 by default, or `= N` for a budget), then put items in
  it by using the slot's name as the keyword: `hat fedora "Fedora" logic+1`.
  Filling a slot swaps out the longest-worn piece, and slots can be declared
  above or below the items that use them.
- The gear panel is now EQUIPMENT, grouped by slot, each with a worn/limit tally.

**Stats & money**

- A stat can be a gauge: `stat resolve = 3 max 5` draws filled/empty pips under
  its label, and the value clamps at the cap (the floor stays open, so an
  `@fail` on `<= 0` still fires). Good for vitals like health, resolve, or water.
- Currency is money: it shows as a float (`340.00`) at the foot of the sidebar,
  so it reads as cash whatever you name it.
- The sidebar now runs STATUS, SKILLS, EQUIPMENT, ITEMS, and money, top to
  bottom.

**Reading**

- Already-read lines shrink as they recede without the text rewrapping, so a
  long passage no longer reflows while it shrinks.

**Publishing**

- Published games are now pinned to the engine version they were made under.
  When andstar updates, a game you already shared keeps the exact look and
  behavior it had at publish time; only republishing moves it to the current
  engine. So everything above is safe to ship without disturbing the back
  catalog.

The demo, rebuilt as "Two Wings Good," shows all of it.

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
