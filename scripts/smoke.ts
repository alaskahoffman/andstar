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
  assert(inv.find((i) => i.id === "flying")?.equipped, "jacket given and equipped on start (~ equip)");
  const before = rt.effectiveSkill("senses"); // base 3
  rt.toggleEquip("torch");
  assert(rt.effectiveSkill("senses") === before + 2, "equipping the torch buffs senses by +2");
  rt.toggleEquip("torch");
  assert(rt.effectiveSkill("senses") === before, "unequip restores total");
  assert(rt.effectiveSkill("hands") === 2, "equipped jacket debuffs the hands (3 - 1)");

  // Passives: senses 4 (the exhaust flame) needs total >= 4; base is 3.
  assert(!rt.log.some((l) => l.kind === "passive"), "senses passive hidden at low skill");
  const g2 = structuredClone(game);
  g2.skills.senses.base = 10;
  const rt2 = new Runtime(g2, { rng: () => 0.0 });
  assert(rt2.log.some((l) => l.kind === "passive"), "passive fires at high skill");

  // Dawn conditionals: orange/chart/heart hidden without their flags, and the
  // drink is hidden while water sits at 0 (it's a [water >= 1] gate now).
  const rtS = new Runtime(game, { rng: () => 0.0, startAt: "dawn" });
  const dawnChoices = rtS.getChoices();
  assert(dawnChoices.length === 3, "orange/chart/heart/drink choices hidden without water or their flags");
  assert(!dawnChoices.some((c) => c.text.startsWith("Drink")), "drinking hidden with zero water");

  // White checks lock on failure until the skill ITSELF is upgraded;
  // equipment affects rolls but cannot reopen a failed check. Red is one-shot.
  const g3 = parseGame(`
skill a "A" = 0
item lens "Lens" a+1
== start
~ give lens
~ wardrobe open
* [white a 30] try -> win | start
* [red a 30] once -> win | start
* train -> gym
* wait -> start
== gym
~ skill a +1
-> start
== win
-> END
`).game!;
  const rt3 = new Runtime(g3, { rng: () => 0.0 }); // always rolls 1+1 = crit fail
  let cs = rt3.getChoices();
  assert(cs.length === 4, "both checks + fillers visible initially");
  rt3.choose(cs[0].id); // fail white at base 0
  cs = rt3.getChoices();
  const white = cs.find((c) => c.check?.type === "white")!;
  assert(white.check!.failedBefore && white.check!.locked, "failed white is locked while skill unchanged");
  rt3.choose(white.id); // locked: must be a no-op
  assert(rt3.getChoices().length === 4, "choosing a locked check does nothing");
  rt3.toggleEquip("lens"); // effective 0 -> 1, but the BASE skill hasn't grown
  assert(
    rt3.getChoices().find((c) => c.check?.type === "white")!.check!.locked,
    "equipment does NOT reopen a failed white check",
  );
  rt3.choose(rt3.getChoices().find((c) => c.text.includes("train"))!.id); // ~ skill a +1
  assert(rt3.log.some((l) => l.kind === "system" && l.text === "A +1"), "~ skill change is logged");
  const retry = rt3.getChoices().find((c) => c.check?.type === "white")!;
  assert(!retry.check!.locked && retry.check!.failedBefore, "white unlocks once the skill itself improves");
  rt3.choose(rt3.getChoices().find((c) => c.check?.type === "red")!.id); // fail red
  cs = rt3.getChoices();
  assert(!cs.some((c) => c.check?.type === "red"), "red gone after one attempt");
}

console.log("\nequipment slots (single & budget):");
{
  const pg = parseGame(`
skill a "A" = 0
slot hat "Headwear" = 1
slot charm "Charms" = 2
hat   fedora "Fedora" a+1
hat   cap    "Cap" a+2
charm ring   "Ring" a+1
charm pin    "Pin" a+1
charm bead   "Bead" a+1
item  torch  "Torch" a+1
== start
~ give fedora
~ give cap
~ give ring
~ give pin
~ give bead
~ give torch
~ wardrobe open
* wait -> start
`);
  assert(pg.errors.length === 0, "slot game compiles clean");
  const cg = pg.game!;
  assert(cg.slots.hat?.limit === 1 && cg.slots.charm?.limit === 2, "slot limits parsed");
  assert(cg.slots.hat?.name === "Headwear", "slot display name parsed");
  assert(cg.items.fedora.slot === "hat", "slot-keyword puts the item in its slot");
  assert(cg.items.torch.slot === undefined, "plain item has no slot");

  const rt = new Runtime(cg, { rng: () => 0.5 });
  // Slot (limit 1): equipping a second hat swaps the first one out.
  rt.toggleEquip("fedora");
  assert(rt.effectiveSkill("a") === 1, "fedora equipped (+1)");
  rt.toggleEquip("cap");
  assert(rt.effectiveSkill("a") === 2, "equipping the cap swapped out the fedora (slot of 1)");
  const hats = rt.getInventory().filter((i) => i.slot === "hat" && i.equipped);
  assert(hats.length === 1 && hats[0].id === "cap", "exactly one hat worn, the newest");

  // Budget (limit 2): the third charm evicts the one equipped longest ago.
  rt.toggleEquip("ring");
  rt.toggleEquip("pin");
  rt.toggleEquip("bead");
  const charms = rt.getInventory().filter((i) => i.slot === "charm" && i.equipped).map((i) => i.id);
  assert(charms.length === 2, "charm budget capped at 2");
  assert(!charms.includes("ring") && charms.includes("pin") && charms.includes("bead"), "oldest charm (ring) evicted");

  // Untagged items ignore caps entirely.
  rt.toggleEquip("torch");
  assert(rt.getInventory().find((i) => i.id === "torch")?.equipped, "slotless item equips freely");

  // The ~ equip effect honors the cap too.
  const eg = parseGame(`
skill a "A" = 0
slot hat "Hat" = 1
hat h1 "H1" a+1
hat h2 "H2" a+2
== start
~ equip h1
~ equip h2
* wait -> start
`).game!;
  const eqHats = new Runtime(eg, { rng: () => 0.5 }).getInventory().filter((i) => i.equipped).map((i) => i.id);
  assert(eqHats.length === 1 && eqHats[0] === "h2", "~ equip respects the slot limit (h2 swapped in)");

  // A slot can be declared AFTER the items that use it (order-independent).
  const reordered = parseGame(`skill a "A"\nhat x "X" a+1\nslot hat "H"\n== s\n* w -> s\n`).game!;
  assert(reordered.items.x?.slot === "hat", "slot may be declared after the items that use it");

  // Errors and warnings around slots.
  const unknown = parseGame(`skill a "A"\nnope x "X" a+1\n== s\n* w -> s\n`);
  assert(unknown.errors.some((e) => e.message.includes('unknown declaration "nope"')), "unknown slot keyword errors");
  const noMods = parseGame(`slot hat "Hat" = 1\nhat x "X"\n== s\n* w -> s\n`);
  assert(noMods.errors.some((e) => e.message.includes("no skill modifiers")), "slotted item needs modifiers");
  const badLimit = parseGame(`slot hat "Hat" = 0\n== s\n* w -> s\n`);
  assert(badLimit.errors.some((e) => e.message.includes("at least 1")), "limit below 1 rejected");
  const reserved = parseGame(`slot item "Items"\n== s\n* w -> s\n`);
  assert(reserved.errors.some((e) => e.message.includes("reserved keyword")), "slot can't shadow a reserved keyword");
  const unused = parseGame(`skill a "A"\nslot hat "Hat" = 1\n== s\n* w -> s\n`);
  assert(unused.warnings.some((w) => w.message.includes('slot "hat" is declared but no item')), "unused slot warned");

  // The "= N" limit is optional and defaults to 1 (the common single-item slot).
  const defaulted = parseGame(`skill a "A"\nslot hat "Headwear"\nslot ring\nhat h "H" a+1\nring r "R" a+1\n== s\n* w -> s\n`).game!;
  assert(defaulted.slots.hat.limit === 1, "omitted limit defaults to 1");
  assert(defaulted.slots.ring.limit === 1 && defaulted.slots.ring.name === "Ring", "bare slot gets default name + limit 1");

  // Sample game wiring: one slot per kind, each defaulting to limit 1.
  assert(game!.slots.jacket?.limit === 1 && game!.slots.tool?.limit === 1 && game!.slots.accessory?.limit === 1,
    "sample kind-slots present (jacket/tool/accessory, default limit 1)");
  assert(game!.items.flying.slot === "jacket" && game!.items.torch.slot === "tool" && game!.items.scarf.slot === "accessory",
    "sample items declared via their slot keyword");
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
  assert(!rtP.allocatePoints({ a: 3 }), "over-allocation rejected");
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
  const oneShot = cs.find((c) => c.text.includes("One shot"))!;
  assert(oneShot?.used === true && oneShot?.locked === true, "picked [once] stays listed: used + locked");
  rtL.choose(oneShot.id);
  assert(rtL.getChoices().some((c) => c.text.includes("One shot")), "choosing a spent [once] is a no-op");

  rtL.choose(cs.find((c) => c.text.includes("Composable"))!.id); // +2 gold -> 8
  assert(rtL.statValue("gold") === 8, "[once][earn 2] paid out");
  const spentEarn = rtL.getChoices().find((c) => c.text.includes("Composable"))!;
  assert(spentEarn.locked === true, "and locks after one use");
  rtL.choose(spentEarn.id);
  assert(rtL.statValue("gold") === 8, "spent [once][earn] cannot be milked");
  assert(rtL.getChoices().find((c) => c.text.includes("loop"))!.used !== true, "unpicked choices are not marked used");
  rtL.choose(rtL.getChoices().find((c) => c.text.includes("loop"))!.id);
  assert(rtL.getChoices().find((c) => c.text.includes("loop"))!.used === true, "picked plain choices are marked used (still clickable)");

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
  assert(game.points?.pool === 2 && game.points?.max === undefined, "@points 2 parsed (no explicit max)");
  assert(parseGame(`@points 4 max 6\n== s\nhi\n* x -> END\n`).game!.points?.max === 6, "@points max override parsed");

  // Skill descriptions: optional quoted blurb after the base.
  assert(game.skills.sangfroid.desc?.startsWith("Cold blood"), "sample skill carries a description");
  const sd = parseGame(`skill a "A" #6cb9ff = 3 "the blurb"\n== s\nhi\n* x -> END\n`);
  assert(sd.errors.length === 0 && sd.game!.skills.a.desc === "the blurb", "skill description parsed");
  assert(parseGame(`skill a "A" = 3\n== s\nhi\n* x -> END\n`).game!.skills.a.desc === undefined, "description optional");

  // Build overrides replace skill bases — including pulled BELOW base (min-max,
  // floored at 1 on the build screen).
  const rtB = new Runtime(game, { rng: () => 0.5, build: { hands: 9, reckoning: 3, sangfroid: 1, senses: 3, heart: 2 } });
  assert(rtB.skillBase("hands") === 9, "build allocation applied to skill base");
  assert(rtB.skillBase("sangfroid") === 1, "a skill pulled below its baseline takes effect");

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

  // @reveal line pacing
  assert(parseGame(`== s\nhi\n* x -> END\n`).game!.reveal === "click", "reveal defaults to click");
  assert(parseGame(`@reveal paced\n== s\nhi\n* x -> END\n`).game!.reveal === "paced", "@reveal paced parsed");
  assert(parseGame(`@reveal off\n== s\nhi\n* x -> END\n`).game!.reveal === "off", "@reveal off parsed");
  assert(
    parseGame(`@reveal typewriter\n== s\nhi\n* x -> END\n`).errors.some((e) => e.message.includes("@reveal must be")),
    "unknown @reveal rejected",
  );

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

console.log("\nstats (HUD gauges):");
{
  // The sample's resolve carries a max, so the HUD draws it as a 5-pip gauge.
  assert(game.stats.find((s) => s.name === "resolve")?.max === 5, "sample 'resolve' stat capped at max 5");

  const sg = parseGame(`stat hp = 3 max 5\nstat gold = 10\n== s\n* w -> s\n`).game!;
  assert(sg.stats.find((s) => s.name === "hp")?.max === 5, "stat max parsed");
  assert(sg.stats.find((s) => s.name === "gold")?.max === undefined, "stat without max stays a plain number");

  const bad = parseGame(`stat label = "hi" max 5\n== s\n* w -> s\n`);
  assert(bad.errors.some((e) => e.message.includes("isn't a number")), "max on a non-numeric stat rejected");

  // A capped stat clamps to its max, on both the initial value and every ~ set.
  const over = parseGame(`stat hp = 9 max 5\n== s\n~ set hp = hp + 10\n* w -> s\n`).game!;
  assert(new Runtime(over, { rng: () => 0.5 }).statValue("hp") === 5, "initial above max and ~ set both clamp to the cap");
  const under = parseGame(`stat hp = 2 max 5\n== s\n~ set hp = hp - 10\n* w -> s\n`).game!;
  assert(new Runtime(under, { rng: () => 0.5 }).statValue("hp") === -8, "the floor is free, so @fail can still see <= 0");

  // The sample's water is now a survival stat (capped at 3 cups), not currency.
  assert(game.stats.find((s) => s.name === "water")?.max === 3, "sample water is a stat (max 3)");
}

console.log("\nstackable & consumable items:");
{
  const sg = parseGame(`
stat thirst = 1 max 3
item water "Water"
== start
~ give water 3
~ wardrobe open
-> hub
== hub
You carry {has(water)} cups.
* [has(water)] drink -> drink
* [has(water) > 1] more than one -> hub
* wait -> hub
== drink
~ take water
~ set thirst = thirst + 1
~ save
-> hub
`).game!;
  let snap: import("../src/engine/runtime").SaveData | null = null;
  const rt = new Runtime(sg, { rng: () => 0.5, onSave: (s) => { snap = s; } });
  const count = (r: Runtime) => r.getInventory().find((i) => i.id === "water")?.count ?? 0;
  assert(count(rt) === 3, "~ give item N stacks to N");
  assert(rt.getChoices().some((c) => c.text === "drink"), "consume choice shown while items remain");
  // has(item) is the count: a bare gate stays truthy, while comparisons and
  // {interpolation} see the number — no second keyword to learn.
  assert(rt.log.some((l) => "text" in l && l.text === "You carry 3 cups."), "{has(item)} interpolates the count");
  assert(rt.getChoices().some((c) => c.text === "more than one"), "[has(item) > 1] open while 3 are held");

  rt.choose(rt.getChoices().find((c) => c.text === "drink")!.id); // 3 -> 2, thirst 1 -> 2, save
  assert(count(rt) === 2, "~ take removes exactly one");
  assert(rt.statValue("thirst") === 2, "consuming applied its effect (thirst 1 -> 2)");
  assert(snap !== null && count(new Runtime(sg, { rng: () => 0.5, restore: snap! })) === 2, "item counts survive save/restore");

  rt.choose(rt.getChoices().find((c) => c.text === "drink")!.id); // 2 -> 1
  assert(!rt.getChoices().some((c) => c.text === "more than one"), "[has(item) > 1] closes at 1 (bare [has] would still pass)");
  rt.choose(rt.getChoices().find((c) => c.text === "drink")!.id); // 1 -> 0, gone
  assert(count(rt) === 0 && !rt.getInventory().some((i) => i.id === "water"), "the last one taken removes the item");
  assert(!rt.getChoices().some((c) => c.text === "drink"), "consume choice hidden once empty");

  // Sample wiring: the cup is a stackable consumable that feeds the water vital.
  assert(game.items.cup?.consumable?.water === 1, "sample cup is a consumable (water+1)");
}

console.log("\nconsumable items (click to use):");
{
  const cg = parseGame(`
skill grit "Grit" = 3
stat thirst = 1 max 3
item cup "Cup" thirst+1
item jacket "Jacket" grit+1
item rock "Rock"
== start
~ give cup 2
* w -> start
`).game!;
  assert(cg.items.cup.consumable?.thirst === 1 && Object.keys(cg.items.cup.mods).length === 0, "a stat modifier makes a consumable, not equipment");
  assert(Object.keys(cg.items.jacket.mods).length === 1 && !cg.items.jacket.consumable, "a skill modifier stays equipment");
  assert(!cg.items.rock.consumable && Object.keys(cg.items.rock.mods).length === 0, "no modifier stays a plain possession");

  const rt = new Runtime(cg, { rng: () => 0.5 });
  const cups = () => rt.getInventory().find((i) => i.id === "cup")?.count ?? 0;
  assert(rt.getInventory().find((i) => i.id === "cup")?.consumable?.thirst === 1, "inventory exposes the consumable effect");
  rt.useItem("cup");
  assert(rt.statValue("thirst") === 2 && cups() === 1, "using applies the effect and spends exactly one");
  rt.useItem("cup");
  assert(rt.statValue("thirst") === 3 && cups() === 0, "second use applies again and empties the stack");
  rt.useItem("cup"); // none left
  assert(cups() === 0, "using with none left is a safe no-op");

  // A capped stat clamps on use, just like ~ set.
  const clampG = parseGame(`stat hp = 4 max 5\nitem potion "Potion" hp+10\n== s\n~ give potion\n* w -> s\n`).game!;
  const cr = new Runtime(clampG, { rng: () => 0.5 });
  cr.useItem("potion");
  assert(cr.statValue("hp") === 5, "a consumable can't push a capped stat past its max");

  // Errors: unknown target, mixing equipment + consumable, consumable in a slot.
  assert(parseGame(`item x "X" zzz+1\n== s\n* w -> s\n`).errors.some((e) => e.message.includes("not a declared skill or stat")), "unknown modifier target errors");
  assert(parseGame(`skill a "A" = 1\nstat hp = 1\nitem x "X" a+1 hp+1\n== s\n* w -> s\n`).errors.some((e) => e.message.includes("mixes skill modifiers")), "mixing equipment + consumable errors");
  assert(parseGame(`stat hp = 1\nslot pouch\npouch x "X" hp+1\n== s\n* w -> s\n`).errors.some((e) => e.message.includes("can't go in an equipment slot")), "a consumable can't be slotted");
}

console.log("\ncurrency & plain items:");
{
  assert(game.currency?.id === "franc" && game.currency?.name === "Francs", "sample declares currency (francs)");

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
  assert(rtC.log.some((l) => l.kind === "system" && l.text === "−12.00 Gold"), "pay logged (float)");

  const noCur = parseGame(`== s\n~ pay 5\n* x -> END\n`);
  assert(noCur.errors.some((e) => e.message.includes("needs a currency")), "~ pay without currency rejected");

  // ~ skill validation
  assert(
    parseGame(`skill a "A"\n== s\n~ skill b +1\n* x -> END\n`).errors.some((e) => e.message.includes('unknown skill "b"')),
    "~ skill on undeclared skill rejected",
  );
  assert(
    parseGame(`skill a "A"\n== s\n~ skill a +0\n* x -> END\n`).errors.some((e) => e.message.includes("non-zero")),
    "~ skill +0 rejected",
  );

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
  assert(rtPC.log.some((l) => l.kind === "system" && l.text === "−15.00 Gold"), "payment logged (float)");

  assert(
    parseGame(`== s\n* [pay 5] x -> END\n`).errors.some((e) => e.message.includes("needs a currency")),
    "[pay] without currency rejected",
  );
}

console.log(failures ? `\n${failures} FAILURES` : "\nall good");
process.exit(failures ? 1 : 0);
