# andstar (&*)

A website where anyone can write **Disco Elysium-style dialogue games** in a
Twine-like plain-text script, play them in a clean night-mode player, and
share them with a public link.

## Features

- **Script DSL** — passages, branching choices, and dialogue attributed to
  characters *or skills* (skills speak in italics, in their own color)
- **Skill checks** — `[white logic 10]` / `[red authority 12]` choices roll
  2d6 + skill + equipment vs the difficulty, with DE rules: double-6 always
  succeeds, double-1 always fails, red checks are once-ever; success odds are
  shown on the choice. A failed **white** check locks (greyed) until the skill
  itself is upgraded past where it failed — equipment affects rolls but
  cannot reopen a failed check
- **Skill points** — `~ points 1` grants points mid-game and re-opens the
  +/− allocation screen (no per-skill cap on level-ups); `~ skill name -1`
  applies an author-directed change to one skill, shown to the player
- **Checkpoints** — authors place `~ save` where progress should persist;
  players get CONTINUE / START OVER on return. No free saving, no savescumming.
  Saves are per-browser and invalidated when the game is republished
- **Fail states** — `@fail morale <= 0 "message"` rules (checked whenever an
  effect changes state) or a `-> FAIL` choice target end the run without
  ending the game: the player gets RETURN TO LAST SAVE (or START OVER if no
  checkpoint was reached)
- **Passive checks** — `? perception 6: …` interjections that only appear when
  the skill total is high enough
- **Character build** — `@points 4 max 6` shows a point-allocation screen
  before play; players distribute extra skill points on top of the authored
  bases (restart returns there to re-spec)
- **Items, three kinds** — what an item modifies is what it is: a **skill** modifier
  (`item flask "Hip Flask" gut+2 logic-1`) is **equipment** you wear; a **stat**
  modifier (`item cup "Cup of Water" water+1`) is a **consumable** the reader clicks to
  use any time, spending one; no modifier is a **key item** you just carry (`has(item)`
  still gates on it). All three **stack** — `~ give water 3` / `~ take water`, shown as
  `×N`, and `has(item)` reads as the count (`[has(cup) > 1]`, `{has(cup)}`)
- **Equipment slots** — declare a slot to cap how many of a kind can be worn at once
  (`slot hat "Headwear"`, limit 1 by default or `= N` for a budget) and put items in it
  by using the slot's name as the keyword (`hat fedora "Fedora" logic+1`); filling a
  slot swaps out the longest-worn piece, while slotless equipment has no limit.
  Equipping is **locked by default** so players can't gear-swap at a skill check —
  open with `~ wardrobe open` / close with `~ wardrobe close` (or `@wardrobe open` to
  keep it free all game)
- **Stats & currency** — a `stat morale = 2` shows in the STATUS panel; add
  `max N` (`stat resolve = 3 max 5`) to draw it as a row of filled/empty pips that
  clamps at the cap, a gauge the player sweats toward zero. A `currency real "Réal"
  = 20` is money: shown as a float (`20.00`) at the foot of the sidebar, spent and
  gained with `~ pay 20` / `~ earn 5`. `* [pay 20] Bribe him -> target` shows a
  `[−20.00 RÉAL]` tag and greys out when unaffordable (`[earn 5]` for the reverse)
- **Variables, stats, conditions** — `~ set morale = morale - 1`,
  `[morale >= 2]` gated choices, `{morale}` text interpolation
- **Line gates** — any line (narration, dialogue, effects, `->` jumps) can be
  prefixed with `[condition]` and/or `[once]`, so one passage can change with
  state instead of being cloned per variant; choice brackets compose freely
  (`* [once] [mae_trusts] [pay 10] …`, `* [pay 5] [white sense 9] …`)
- **Theming** — `@bg #101820`, `@accent #e94560`, and `@font serif` restyle the
  player per game; panel/border/dim shades are derived from the background
  (light backgrounds get dark text automatically), and fonts come in `book`
  (default), `mono`, `serif`, `sans`, `humanist`
- **Editor** — live error checking plus structural warnings (unreachable
  passages, unused items/vars; click to jump to the line), instant play-test
  preview that can start **from any passage**, autosave, `.txt` export/import
  for drafts, built-in language reference
- **Export** — one button downloads a zip containing the whole game as a
  single self-contained HTML page (engine inlined, zero requests) plus the
  script as `source.txt`. It's simultaneously a backup (IMPORT reads the zip
  back) and an upload-ready itch.io HTML project — creators can host or sell
  their games anywhere, independent of this server
- **Publishing** — one click creates a public `/play/<id>` link; an edit key
  stored in your browser lets you republish updates to the same link

## Run it

```sh
npm install
npm run build      # build the frontend into dist/
npm run server     # serve site + API on http://localhost:8787
```

For frontend development with hot reload, also run `npm run dev` (Vite on
:5173, proxying `/api` to :8787).

Other commands: `npm run check` (typecheck), `npm run smoke` (parser/engine
smoke tests: compiles the sample game and plays 200 seeded runs).

## Pages

- `/` — homepage (`index.html`)
- `/create` — the editor (`create.html`)
- `/play/<id>` — published games; `/play/demo` is the bundled sample

## Layout

- `src/dsl/` — script language: tokenizer/expressions and the compiler
- `src/engine/runtime.ts` — game state machine (rolls, passives, effects)
- `src/ui/player-view.ts` — TUI renderer shared by preview and play page
- `src/editor/`, `src/player/` — the editor and player entry scripts
- `src/sample-game.ts` — "Sand and Stars", demonstrates every feature
- `server/index.mjs` — Express + built-in `node:sqlite`; games stored in
  `data/games.db` (created on first run)

## Deploying

Any host that runs Node ≥ 23 works (the server uses the built-in
`node:sqlite`): `npm run build`, then `npm start` (set `PORT` if needed) and
persist the data directory. There are no other moving parts — no external
database, no native modules.

On **Render** (or similar):

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Attach a **persistent disk** (e.g. mounted at `/var/data`) and set
  `DATA_DIR=/var/data` — without one, every deploy wipes published games
- Environment: `TRUST_PROXY=1` (Render proxies traffic; required for rate
  limiting to see real client IPs) and `ADMIN_TOKEN=<secret>` for takedowns
- Node version comes from `.node-version` / `engines` (23)
- Back up `$DATA_DIR/games.db` on a schedule; it is the entire database

Publishing is rate-limited per IP (20 creates/hour, 120 updates/hour). Behind
a reverse proxy, set `TRUST_PROXY=1` so limits apply to real client IPs.

Authors can unpublish their own games from the editor. For abuse takedowns,
set `ADMIN_TOKEN=<secret>` and call
`curl -X DELETE -H "x-admin-token: <secret>" https://yourhost/api/games/<id>`.

## Script cheatsheet

The full reference, with descriptions and examples for everything, is at
[andstar.org/docs](https://andstar.org/docs).

```text
@title My Game
@points 4 max 6                 # optional: pre-game skill point allocation
@wardrobe open                  # optional: free equipping all game (default locked)
@reveal paced                  # optional: click (default, tap per line), paced (timed), off
@bg #101820                     # optional: background color (shades derived)
@accent #e94560                 # optional: accent color
@font serif                     # optional: book (default), mono, serif, sans, humanist
skill logic "Logic" #6cb9ff = 3
char kim "Kim" #f0c987
item flask "Hip Flask" gut+2 logic-1
item page "Torn Page"           # no modifiers = plain possession
slot hat "Headwear"             # equipment slot; cap defaults to 1, "= N" for a budget
hat fedora "Fedora" logic+1     # an item in the hat slot (slot name is the keyword)
currency real "Réal" = 20       # money, shown as a float at the foot of the sidebar
stat morale = 2 max 5           # "max N" draws a capped pip gauge; omit it for a plain number
var seen_body = false

== start
Plain text is narration.
kim: "Speaker id, colon, text."
logic: Skills speak too.
? perception 6: Shown only if Perception total >= 6.
~ give flask
~ wardrobe open                 # or close — gate when players may change gear
~ set morale = morale - 1
~ pay 20                        # spend currency; ~ earn 5 to gain
~ points 1                      # grant skill points (player allocates immediately)
~ skill sangfroid -1            # author-directed skill change, shown to the player
~ save                          # checkpoint; player resumes here on return
* Plain choice -> other_passage
* [morale >= 2] Conditional choice -> other_passage
* [white logic 10] Skill roll -> success_passage | fail_passage
* Quit -> END

== other_passage
-> END
```
