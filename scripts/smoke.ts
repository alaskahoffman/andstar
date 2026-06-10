// Smoke test: compile the sample game, then play several full runs with a
// seeded RNG, exercising checks, items, conditions, and endings.
// Run with: npx vite-node scripts/smoke.ts

import { parseGame } from "../src/dsl/parser";
import { Runtime } from "../src/engine/runtime";
import { SAMPLE_GAME } from "../src/sample-game";

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  ok — ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL — ${msg}`);
  }
}

// deterministic rng
function seeded(seed: number): () => number {
  let s = seed;
  const next = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  // warm up: the first outputs of a small-seeded LCG barely vary with the seed
  for (let i = 0; i < 10; i++) next();
  return next;
}

console.log("compile sample game:");
const { game, errors } = parseGame(SAMPLE_GAME);
for (const e of errors) console.error(`  L${e.line}: ${e.message}`);
assert(errors.length === 0, "sample compiles without errors");
assert(game && Object.keys(game.passages).length >= 15, "all passages present");
assert(game && game.start === "start", "start passage detected");

if (!game) process.exit(1);

console.log("\nerror reporting:");
{
  const bad = parseGame(`== start\nbob: "hi"\n* go -> nowhere\n`);
  assert(bad.errors.some((e) => e.message.includes("unknown speaker")), "unknown speaker caught");
  assert(bad.errors.some((e) => e.message.includes('unknown passage "nowhere"')), "bad jump target caught");
  const bad2 = parseGame(`skill a "A"\n== s\n* [white b 10] x -> s | s\n`);
  assert(bad2.errors.some((e) => e.message.includes('unknown name "b"')), "check on undeclared skill caught");
}

console.log("\nrandom playthroughs (200 seeds):");
{
  const endingsSeen = new Set<string>();
  let crashed = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const rng = seeded(seed);
    const rt = new Runtime(game, { rng });
    let steps = 0;
    try {
      // generous cap: the saloon/street hubs allow long random dawdling
      while (!rt.ended && steps++ < 300) {
        const cs = rt.getChoices();
        if (cs.length === 0) break;
        rt.choose(cs[Math.floor(rng() * cs.length)].id);
      }
      const text = rt.log.map((l) => ("text" in l ? l.text : "")).join("\n");
      if (text.includes("WALKED EAST")) endingsSeen.add("walk");
      if (text.includes("THE FIRE")) endingsSeen.add("fire");
      if (rt.failed) endingsSeen.add("fail");
      if (text.includes("runtime error")) {
        crashed++;
        if (crashed === 1) console.error(rt.log.map((l) => JSON.stringify(l)).join("\n"));
      }
    } catch (e) {
      crashed++;
      console.error(`  seed ${seed} threw: ${(e as Error).message}`);
    }
    if (!rt.ended && !rt.failed && steps >= 300) crashed++;
  }
  assert(crashed === 0, "no playthrough crashed, errored, or ran forever");
  assert(
    endingsSeen.size === 3,
    `walking out, the signal fire, and the fail state all reachable (saw: ${[...endingsSeen].join(", ")})`,
  );
}

console.log("\nmechanics:");
{
  const rt = new Runtime(game, { rng: () => 0.0 });
  const inv = rt.getInventory();
  assert(inv.find((i) => i.id === "jacket")?.equipped, "jacket given and equipped on start (~ equip)");
  const before = rt.effectiveSkill("senses"); // base 3
  rt.toggleEquip("torch");
  assert(rt.effectiveSkill("senses") === before + 2, "equipping the torch buffs senses by +2");
  rt.toggleEquip("torch");
  assert(rt.effectiveSkill("senses") === before, "unequip restores total");
  assert(rt.effectiveSkill("hands") === 2, "equipped jacket debuffs the hands (3 - 1)");

  // Passives: senses 6 (the exhaust flame) needs total >= 6; base is 3.
  assert(!rt.log.some((l) => l.kind === "passive"), "senses passive hidden at low skill");
  const g2 = structuredClone(game);
  g2.skills.senses.base = 10;
  const rt2 = new Runtime(g2, { rng: () => 0.0 });
  assert(rt2.log.some((l) => l.kind === "passive"), "passive fires at high skill");

  // Dawn conditionals: orange/chart/heart choices hidden without their flags,
  // and drinking is visible but locked with the thermos still in the wreck.
  const rtS = new Runtime(game, { rng: () => 0.0, startAt: "dawn" });
  const dawnChoices = rtS.getChoices();
  assert(dawnChoices.length === 4, "orange/chart/heart choices hidden without their flags");
  const drink = dawnChoices.find((c) => c.cost?.kind === "pay")!;
  assert(drink.cost!.locked, "drinking greyed out with zero cups of water");

  // White checks lock on failure until the skill total improves; red is one-shot.
  const g3 = parseGame(`
skill a "A" = 0
item lens "Lens" a+1
== start
~ give lens
~ wardrobe open
* [white a 30] try -> win | start
* [red a 30] once -> win | start
* wait -> start
== win
-> END
`).game!;
  const rt3 = new Runtime(g3, { rng: () => 0.0 }); // always rolls 1+1 = crit fail
  let cs = rt3.getChoices();
  assert(cs.length === 3, "both checks + filler visible initially");
  rt3.choose(cs[0].id); // fail white at effective 0
  cs = rt3.getChoices();
  const white = cs.find((c) => c.check?.type === "white")!;
  assert(white.check!.failedBefore && white.check!.locked, "failed white is locked while skill unchanged");
  rt3.choose(white.id); // locked: must be a no-op
  assert(rt3.getChoices().length === 3, "choosing a locked check does nothing");
  rt3.toggleEquip("lens"); // effective 0 -> 1, beats the fail value
  const retry = rt3.getChoices().find((c) => c.check?.type === "white")!;
  assert(!retry.check!.locked && retry.check!.failedBefore, "white unlocks once the skill total improves");
  rt3.choose(rt3.getChoices().find((c) => c.check?.type === "red")!.id); // fail red
  cs = rt3.getChoices();
  assert(!cs.some((c) => c.check?.type === "red"), "red gone after one attempt");
}

console.log("\nsave checkpoints (~ save):");
{
  const sg = parseGame(`
skill a "A" = 1
item hat "Hat" a+1
== start
~ give hat
* go -> mid
== mid
~ set seen = true
~ save
After the checkpoint.
* onward -> deep
== deep
* finish -> END
var seen = false
`).game!;
  let snap: import("../src/engine/runtime").SaveData | null = null;
  const rtX = new Runtime(sg, { rng: () => 0.5, onSave: (s) => { snap = s; } });
  rtX.choose(rtX.getChoices()[0].id); // -> mid, hits ~ save
  assert(snap !== null, "onSave fired at the checkpoint");
  assert(rtX.log.some((l) => l.kind === "system" && l.text === "Progress saved"), "save logged");

  const restored = new Runtime(sg, { rng: () => 0.5, restore: snap! });
  assert(restored.statValue("seen") === true, "restored vars intact");
  assert(restored.getInventory().some((i) => i.id === "hat"), "restored inventory intact");
  assert(
    restored.log.filter((l) => "text" in l && l.text === "After the checkpoint.").length === 1,
    "post-save steps replay exactly once",
  );
  assert(restored.getChoices().length === 1 && restored.getChoices()[0].text === "onward", "restored choices match");
  restored.choose(restored.getChoices()[0].id);
  restored.choose(restored.getChoices()[0].id);
  assert(restored.ended, "restored game plays to the end");

  // A save pointing at a deleted passage must throw (caller starts fresh).
  const changed = structuredClone(sg);
  delete changed.passages.mid;
  let threw = false;
  try { new Runtime(changed, { restore: snap! }); } catch { threw = true; }
  assert(threw, "restore against a changed game throws");
}

console.log("\nskill points (~ points):");
{
  const pg = parseGame(`
skill a "A" = 1
skill b "B" = 1
== start
~ points 2
* [white a 30] try -> win | start
* wait -> start
== win
-> END
`).game!;
  const rtP = new Runtime(pg, { rng: () => 0.0 });
  assert(rtP.pendingPoints === 2, "~ points 2 grants 2 pending points");
  assert(rtP.log.some((l) => l.kind === "system" && l.text === "+2 skill points"), "grant logged");
  assert(!rtP.allocatePoints({ a: 1 }), "partial allocation rejected");
  assert(!rtP.allocatePoints({ a: 3, b: -1 }), "negative allocation rejected");
  assert(rtP.allocatePoints({ a: 2, b: 0 }), "exact allocation accepted");
  assert(rtP.skillBase("a") === 3 && rtP.pendingPoints === 0, "points applied to base");

  // Allocation unlocks a previously failed white check.
  rtP.choose(rtP.getChoices()[0].id); // fail white at effective 3; re-entering start grants 2 more
  assert(rtP.getChoices().find((c) => c.check)!.check!.locked, "white locked after fail");
  assert(rtP.allocatePoints({ a: 2, b: 0 }), "new points allocated");
  assert(!rtP.getChoices().find((c) => c.check)!.check!.locked, "leveling up unlocks the retry");
}

console.log("\nstructural warnings:");
{
  const w = parseGame(`
skill a "A" = 1
item ghost "Ghost Item" a+1
var phantom = 0
var counted = 0
== start
The count is {counted}.
* go -> END
== orphan
unreachable text
* x -> END
`);
  assert(w.errors.length === 0, "warnings are not errors");
  assert(w.warnings.some((x) => x.message.includes('"orphan" can never be reached')), "unreachable passage warned");
  assert(w.warnings.some((x) => x.message.includes('"ghost" is declared but never')), "unused item warned");
  assert(w.warnings.some((x) => x.message.includes('"phantom" is declared but never used')), "unused var warned");
  assert(!w.warnings.some((x) => x.message.includes('"counted"')), "{interpolation} counts as var usage");
  const clean = parseGame(SAMPLE_GAME);
  for (const x of clean.warnings) console.error(`  sample warning: ${x.message}`);
  assert(clean.warnings.length === 0, "sample game has no warnings");
}

console.log("\nfail states:");
{
  const fg = parseGame(`
skill a "A" = 1
stat hp = 2
@fail hp <= 0 "You are done."
== start
* push on -> hurt
* doom -> FAIL
== hurt
~ save
~ set hp = hp - 1
* again -> hurt2
* stop -> END
== hurt2
~ set hp = hp - 1
This line is never reached after the fail.
* x -> END
`);
  assert(fg.errors.length === 0, "@fail and -> FAIL compile");
  const g = fg.game!;

  // Rule-based fail, with a checkpoint taken two steps earlier.
  let snap: import("../src/engine/runtime").SaveData | null = null;
  const rtF = new Runtime(g, { rng: () => 0.5, onSave: (s) => { snap = s; } });
  rtF.choose(rtF.getChoices()[0].id); // -> hurt: save at hp 2, drop to 1
  assert(!rtF.failed, "surviving damage does not fail");
  rtF.choose(rtF.getChoices()[0].id); // -> hurt2: hp 0
  assert(rtF.failed && !rtF.ended, "@fail rule triggers a fail state, not an ending");
  const failEntry = rtF.log.find((l) => l.kind === "fail");
  assert(failEntry?.kind === "fail" && failEntry.text === "You are done.", "fail message logged");
  assert(!rtF.log.some((l) => "text" in l && l.text === "This line is never reached after the fail."), "passage aborts at the fail");
  assert(rtF.getChoices().length === 0, "no choices while failed");
  rtF.choose("start#0");
  assert(rtF.failed, "choose() is a no-op while failed");

  // Reloading the checkpoint replays the survivable damage and continues.
  const back = new Runtime(g, { rng: () => 0.5, restore: snap! });
  assert(!back.failed && back.statValue("hp") === 1, "restored run is alive at the checkpoint");
  assert(back.getChoices().length === 2, "restored choices intact after a fail reload");

  // Manual -> FAIL target.
  const rtM = new Runtime(g, { rng: () => 0.5 });
  rtM.choose(rtM.getChoices()[1].id); // doom
  assert(rtM.failed && rtM.log.some((l) => l.kind === "fail" && !l.text), "-> FAIL fails without a message");
}

console.log("\nline gates & composable brackets:");
{
  const lg = parseGame(`
skill a "A" = 1
currency gold "Gold" = 6
item key "Key"
var met = false
== start
[once] First time only.
[met] We meet again.
[!met] ~ set met = true
* [once] One shot deal -> start
* [once] [earn 2] Composable once-earn -> start
* [met] [pay 5] [white a 30] Buy a try -> win | start
* loop -> start
== win
[has(key)] -> END
You need the key.
* grab it -> keyroom
== keyroom
~ give key
* back -> win
`);
  for (const e of lg.errors) console.error(`  L${e.line}: ${e.message}`);
  assert(lg.errors.length === 0, "line gates and composed brackets compile");
  const g = lg.game!;
  const rtL = new Runtime(g, { rng: () => 0.0 });

  const texts = () => rtL.log.filter((l) => "text" in l).map((l) => (l as { text: string }).text);
  assert(texts().includes("First time only."), "[once] line shows on first visit");
  assert(!texts().includes("We meet again."), "[met] line hidden while false");
  // [!met] ~ set met = true ran, so met is now true.
  let cs = rtL.getChoices();
  assert(cs.length === 4, "all choices visible initially (met now true)");
  const composed = cs.find((c) => c.cost && c.check)!;
  assert(composed.cost!.amount === 5 && composed.check!.difficulty === 30, "[pay]+[white] both present on one choice");

  rtL.choose(cs.find((c) => c.text.includes("One shot"))!.id); // -> start again
  assert(texts().filter((t) => t === "First time only.").length === 1, "[once] line did not repeat on revisit");
  assert(texts().includes("We meet again."), "[met] line appears once true");
  cs = rtL.getChoices();
  assert(!cs.some((c) => c.text.includes("One shot")), "[once] choice gone after being picked");

  rtL.choose(cs.find((c) => c.text.includes("Composable"))!.id); // +2 gold -> 8
  assert(rtL.statValue("gold") === 8, "[once][earn 2] paid out");
  assert(!rtL.getChoices().some((c) => c.text.includes("Composable")), "and disappeared after one use");

  // pay+check: deducts on attempt, even when the roll fails (crit fail at rng 0).
  rtL.choose(rtL.getChoices().find((c) => c.cost && c.check)!.id);
  assert(rtL.statValue("gold") === 3, "[pay 5] deducted on the attempt");
  assert(rtL.log.some((l) => l.kind === "roll" && !l.roll.success), "and the roll still happened (failed)");

  // conditional jump: win without the key falls through to its text.
  const rtJ = new Runtime(g, { rng: () => 0.0, startAt: "win" });
  assert(rtJ.log.some((l) => "text" in l && l.text === "You need the key."), "conditional -> skipped while false");
  rtJ.choose(rtJ.getChoices()[0].id); // keyroom: ~ give key
  rtJ.choose(rtJ.getChoices()[0].id); // back -> win: [has(key)] -> END fires
  assert(rtJ.ended, "conditional -> taken once true");

  // once state survives a save/restore roundtrip.
  const sg2 = parseGame(`
skill a "A" = 1
== start
[once] Only once ever.
~ save
* again -> start
`).game!;
  let snap2: import("../src/engine/runtime").SaveData | null = null;
  const rtO = new Runtime(sg2, { rng: () => 0.5, onSave: (s) => { snap2 = s; } });
  rtO.choose(rtO.getChoices()[0].id); // revisit: line skipped, re-saved
  const rtO2 = new Runtime(sg2, { rng: () => 0.5, restore: snap2! });
  rtO2.choose(rtO2.getChoices()[0].id);
  const onceCount = rtO2.log.filter((l) => "text" in l && l.text === "Only once ever.").length;
  assert(onceCount === 1, "[once] state survives save/restore");

  // bracket errors
  assert(parseGame(`== s\n* [white a 1] [red a 2] x -> s | s\nskill a "A"\n`).errors.some((e) => e.message.includes("one skill check")), "two checks rejected");
  assert(parseGame(`skill a "A"\n== s\n[pay 5] hi\n* x -> END\n`).errors.some((e) => e.message.includes("only works on * choices")), "[pay] on a plain line rejected");
}

console.log("\nexport zip roundtrip:");
{
  const { buildItchZip, readZipEntry } = await import("../src/editor/itch-export");
  const zip = buildItchZip("Test & <Game>", SAMPLE_GAME, "console.log('bundle');");
  assert(readZipEntry(zip, "source.txt") === SAMPLE_GAME, "source.txt survives the zip roundtrip");
  const html = readZipEntry(zip, "index.html");
  assert(!!html && html.includes("window.__GAME__") && html.includes("Test &amp; &lt;Game&gt;"), "index.html embedded with escaped title");
  assert(readZipEntry(zip, "missing.txt") === null, "missing entries return null");
}

console.log("\nplaytest start override:");
{
  const rtJ = new Runtime(game, { rng: () => 0.5, startAt: "dawn" });
  assert(rtJ.log.some((l) => "text" in l && String(l.text).includes("color of iron")), "startAt begins at the chosen passage");
}

console.log("\nbuild points & wardrobe:");
{
  assert(game.points?.pool === 4 && game.points?.max === 6, "@points 4 max 6 parsed");

  // Build overrides replace skill bases.
  const rtB = new Runtime(game, { rng: () => 0.5, build: { hands: 6, reckoning: 3, sangfroid: 2, senses: 3, heart: 2 } });
  assert(rtB.skillBase("hands") === 6, "build allocation applied to skill base");

  // Wardrobe: locked by default, opened/closed by effects.
  const wg = parseGame(`
skill a "A" = 2
item hat "Hat" a+1
== start
~ give hat
* open up -> opened
* stay -> start
== opened
~ wardrobe open
* lock down -> locked
== locked
~ wardrobe close
* done -> END
`).game!;
  const rtW = new Runtime(wg, { rng: () => 0.5 });
  rtW.toggleEquip("hat");
  assert(rtW.effectiveSkill("a") === 2, "toggle is a no-op while wardrobe is locked (default)");
  rtW.choose(rtW.getChoices()[0].id); // -> opened
  rtW.toggleEquip("hat");
  assert(rtW.effectiveSkill("a") === 3, "toggle works after ~ wardrobe open");
  rtW.choose(rtW.getChoices()[0].id); // -> locked
  rtW.toggleEquip("hat");
  assert(rtW.effectiveSkill("a") === 3, "toggle is a no-op again after ~ wardrobe close (hat stays on)");
  assert(wg.wardrobe === false, "games default to wardrobe locked");
  assert(parseGame(`@wardrobe open\n== s\nhi\n* x -> END\n`).game!.wardrobe === true, "@wardrobe open parsed");

  // The sample opens the wardrobe in the cockpit and locks it for the descent.
  let snapped = false;
  const rtS = new Runtime(game, { rng: () => 0.5, onSave: () => { snapped = true; } });
  assert(rtS.wardrobeOpen, "sample: wardrobe open in the cockpit");
  rtS.choose(rtS.getChoices()[0].id); // climb -> descent
  assert(!rtS.wardrobeOpen, "sample: wardrobe locked for the descent");
  assert(snapped, "sample: checkpoint saved before the impact");
}

console.log("\ntheme directives:");
{
  const t = parseGame(`@bg #101820\n@accent #e94560\n@font serif\n== s\nhi\n* x -> END\n`);
  assert(t.errors.length === 0, "valid theme directives accepted");
  assert(
    t.game!.theme.bg === "#101820" && t.game!.theme.accent === "#e94560" && t.game!.theme.font === "serif",
    "theme values stored",
  );
  const badColor = parseGame(`@bg red\n== s\nhi\n* x -> END\n`);
  assert(badColor.errors.some((e) => e.message.includes("hex color")), "non-hex @bg rejected");
  const badFont = parseGame(`@font comic\n== s\nhi\n* x -> END\n`);
  assert(badFont.errors.some((e) => e.message.includes("choose: mono, serif")), "unknown @font rejected");
  assert(parseGame(`== s\nhi\n* x -> END\n`).game!.theme.bg === undefined, "theme optional");

  // Declarations tolerate trailing " # comment" (passage text is untouched).
  const inline = parseGame(
    `@font serif      # mono (default), serif, book, sans, humanist\n` +
    `@bg #101820 # dark blue\n` +
    `skill logic "Logic" #6cb9ff = 3 # rollable\n` +
    `== s\nCase #4 begins today.\n* x -> END\n`,
  );
  assert(inline.errors.length === 0, "inline # comments allowed on declarations");
  assert(inline.game!.theme.font === "serif" && inline.game!.skills.logic.color === "#6cb9ff", "values survive comment stripping");
  const says = inline.game!.passages.s.steps[0];
  assert(says.kind === "say" && says.text === "Case #4 begins today.", "# kept verbatim inside passage text");
}

console.log("\ncurrency & plain items:");
{
  assert(game.currency?.id === "water" && game.currency?.name === "Water (cups)", "sample declares currency (water)");

  const cg = parseGame(`
currency gold "Gold" = 10
item key "Brass Key"
item hat "Hat" gold_sense+1
skill gold_sense "Gold Sense" = 2
== start
~ give key
~ give hat
~ wardrobe open
~ earn 5
* [gold >= 12] spend -> shop
* wait -> start
== shop
~ pay 12
* done -> END
`);
  assert(cg.errors.length === 0, "currency + plain item game compiles");
  const rtC = new Runtime(cg.game!, { rng: () => 0.5 });
  assert(rtC.statValue("gold") === 15, "~ earn adds to currency (10 + 5)");
  const inv = rtC.getInventory();
  assert(inv.find((i) => i.id === "key")?.equippable === false, "modless item is a plain possession");
  assert(inv.find((i) => i.id === "hat")?.equippable === true, "modded item stays equippable");
  rtC.toggleEquip("key");
  assert(!rtC.getInventory().find((i) => i.id === "key")!.equipped, "plain possessions cannot be equipped");
  rtC.choose(rtC.getChoices()[0].id); // gold >= 12 visible, spend
  assert(rtC.statValue("gold") === 3, "~ pay subtracts (15 - 12)");
  assert(rtC.log.some((l) => l.kind === "system" && l.text === "−12 Gold"), "pay logged");

  const noCur = parseGame(`== s\n~ pay 5\n* x -> END\n`);
  assert(noCur.errors.some((e) => e.message.includes("needs a currency")), "~ pay without currency rejected");

  // [pay N] / [earn N] choice costs.
  const pc = parseGame(`
currency gold "Gold" = 10
== start
* [pay 15] buy the lamp -> won
* [earn 5] beg -> start
* wait -> start
== won
-> END
`);
  assert(pc.errors.length === 0, "[pay]/[earn] choices compile");
  const rtPC = new Runtime(pc.game!, { rng: () => 0.5 });
  let pcs = rtPC.getChoices();
  const buy = pcs.find((c) => c.cost?.kind === "pay")!;
  assert(buy.cost!.locked && buy.cost!.amount === 15 && buy.cost!.name === "Gold", "unaffordable pay choice is locked");
  rtPC.choose(buy.id);
  assert(!rtPC.ended, "choosing a locked pay choice is a no-op");
  rtPC.choose(pcs.find((c) => c.cost?.kind === "earn")!.id); // beg: +5 -> 15
  assert(rtPC.statValue("gold") === 15, "[earn 5] added on selection");
  pcs = rtPC.getChoices();
  assert(!pcs.find((c) => c.cost?.kind === "pay")!.cost!.locked, "pay choice unlocks once affordable");
  rtPC.choose(pcs.find((c) => c.cost?.kind === "pay")!.id);
  assert(rtPC.statValue("gold") === 0 && rtPC.ended, "[pay 15] deducted and choice navigated");
  assert(rtPC.log.some((l) => l.kind === "system" && l.text === "−15 Gold"), "payment logged");

  assert(
    parseGame(`== s\n* [pay 5] x -> END\n`).errors.some((e) => e.message.includes("needs a currency")),
    "[pay] without currency rejected",
  );
}

console.log(failures ? `\n${failures} FAILURES` : "\nall good");
process.exit(failures ? 1 : 0);
