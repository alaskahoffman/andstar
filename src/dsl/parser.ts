// Compiles game source (the authoring DSL) into a GameDef.
// Line-oriented: declarations before the first passage, then `== passage` blocks.

import type {
  GameDef, ParseError, ParseResult, Passage, Choice, Effect, Value, Expr,
} from "./types";
import { parseExpr, collectRefs } from "./expr";

const IDENT = /^[A-Za-z_]\w*$/;

// skill/char/item declarations share this shape:
//   kw id "Display Name" ...rest    (quotes optional for one-word names)
function parseDecl(rest: string): { id: string; name: string; tail: string } | null {
  const m = rest.match(/^([A-Za-z_]\w*)\s+(?:"([^"]*)"|(\S+))\s*(.*)$/);
  if (!m) return null;
  return { id: m[1].toLowerCase(), name: m[2] ?? m[3], tail: m[4].trim() };
}

// Peel leading [bracket] [groups] off a line; returns null on an unclosed [.
function splitGroups(src: string): { groups: string[]; rest: string } | null {
  const groups: string[] = [];
  let s = src;
  while (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end === -1) return null;
    groups.push(s.slice(1, end).trim());
    s = s.slice(end + 1).trimStart();
  }
  return { groups, rest: s };
}

export function parseGame(source: string): ParseResult {
  const errors: ParseError[] = [];
  const game: GameDef = {
    title: "Untitled",
    author: "",
    start: "",
    theme: {},
    points: null,
    wardrobe: false,
    reveal: "click",
    currency: null,
    fails: [],
    skills: {},
    chars: {},
    items: {},
    vars: {},
    stats: [],
    passages: {},
  };

  const err = (line: number, message: string) => errors.push({ line, message });

  const lines = source.split(/\r?\n/);
  let passage: Passage | null = null;
  let explicitStart: string | null = null;
  let passiveCount = 0;

  // Deferred validation: expressions/targets checked after all declarations are known.
  const exprRefs: { line: number; idents: Set<string>; items: Set<string> }[] = [];
  const targetRefs: { line: number; target: string }[] = [];

  const parseCondOrNull = (src: string, line: number) => {
    try {
      const e = parseExpr(src);
      const idents = new Set<string>(), items = new Set<string>();
      collectRefs(e, idents, items);
      exprRefs.push({ line, idents, items });
      return e;
    } catch (ex) {
      err(line, `bad expression "${src}": ${(ex as Error).message}`);
      return null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const raw = lines[i];
    const text = raw.trim();
    if (!text || text.startsWith("#")) continue;

    // --- passage header ---
    let m = text.match(/^(?:==+|::)\s*(\S+)\s*$/);
    if (m) {
      const id = m[1].toLowerCase();
      if (!IDENT.test(id)) { err(ln, `passage name "${m[1]}" must be a word (letters, digits, _)`); continue; }
      if (game.passages[id]) { err(ln, `duplicate passage "${id}"`); continue; }
      passage = { id, line: ln, steps: [] };
      game.passages[id] = passage;
      if (!game.start) game.start = id;
      continue;
    }

    // --- declarations (only before the first passage) ---
    if (!passage) {
      // Declarations allow trailing " # comment" — safe because color tokens
      // (#6cb9ff) have no space after the #. Passage text is never stripped.
      const decl = text.replace(/\s+#\s.*$/, "");
      if ((m = decl.match(/^@title\s+(.+)$/))) { game.title = m[1].trim(); continue; }
      if ((m = decl.match(/^@author\s+(.+)$/))) { game.author = m[1].trim(); continue; }
      if ((m = decl.match(/^@start\s+(\S+)\s*$/))) { explicitStart = m[1].toLowerCase(); targetRefs.push({ line: ln, target: explicitStart }); continue; }
      if ((m = decl.match(/^@points\s+(\d+)(?:\s+max\s+(\d+))?\s*$/))) {
        game.points = { pool: parseInt(m[1], 10), max: m[2] ? parseInt(m[2], 10) : undefined };
        continue;
      }
      if (decl.startsWith("@points")) { err(ln, `bad @points — expected: @points 6  (optionally: @points 6 max 6)`); continue; }
      if ((m = decl.match(/^@wardrobe\s+(open|locked)\s*$/))) { game.wardrobe = m[1] === "open"; continue; }
      if ((m = decl.match(/^@reveal\s+(\S+)\s*$/))) {
        const v = m[1].toLowerCase();
        if (v !== "click" && v !== "paced" && v !== "off") {
          err(ln, `@reveal must be click (default: tap for each line), paced (timed), or off`);
          continue;
        }
        game.reveal = v;
        continue;
      }
      if (decl.startsWith("@wardrobe")) { err(ln, `bad @wardrobe — expected: @wardrobe open  or  @wardrobe locked`); continue; }
      if ((m = decl.match(/^@(bg|accent)\s+(\S+)\s*$/))) {
        if (!/^#[0-9a-fA-F]{6}$/.test(m[2])) { err(ln, `@${m[1]} needs a 6-digit hex color, e.g. @${m[1]} #1a2030`); continue; }
        game.theme[m[1] as "bg" | "accent"] = m[2];
        continue;
      }
      if ((m = decl.match(/^@fail\s+(.+)$/))) {
        let condSrc = m[1].trim();
        let message: string | undefined;
        const qm = condSrc.match(/^(.*?)\s*"([^"]*)"\s*$/);
        if (qm) { condSrc = qm[1].trim(); message = qm[2]; }
        if (!condSrc) { err(ln, `bad @fail — expected: @fail morale <= 0 "optional message"`); continue; }
        const cond = parseCondOrNull(condSrc, ln);
        if (!cond) continue;
        game.fails.push({ cond, message });
        continue;
      }
      if ((m = decl.match(/^@font\s+(\S+)\s*$/))) {
        const f = m[1].toLowerCase();
        if (!["mono", "serif", "book", "sans", "humanist"].includes(f)) {
          err(ln, `unknown font "${m[1]}" — choose: mono, serif, book, sans, humanist`);
          continue;
        }
        game.theme.font = f as GameDef["theme"]["font"];
        continue;
      }

      if ((m = decl.match(/^skill\s+(.*)$/))) {
        const d = parseDecl(m[1]);
        if (!d) { err(ln, `bad skill declaration — expected: skill id "Name" #color = 3`); continue; }
        let color = "#9fb8c8", base = 2;
        const cm = d.tail.match(/#[0-9a-fA-F]{3,8}/);
        if (cm) color = cm[0];
        const bm = d.tail.match(/=\s*(-?\d+)/);
        if (bm) base = parseInt(bm[1], 10);
        if (game.skills[d.id] || game.chars[d.id]) { err(ln, `"${d.id}" is already declared`); continue; }
        game.skills[d.id] = { id: d.id, name: d.name, color, base };
        continue;
      }

      if ((m = decl.match(/^char\s+(.*)$/))) {
        const d = parseDecl(m[1]);
        if (!d) { err(ln, `bad char declaration — expected: char id "Name" #color`); continue; }
        const cm = d.tail.match(/#[0-9a-fA-F]{3,8}/);
        if (game.skills[d.id] || game.chars[d.id]) { err(ln, `"${d.id}" is already declared`); continue; }
        game.chars[d.id] = { id: d.id, name: d.name, color: cm ? cm[0] : "#e0d6c3" };
        continue;
      }

      if ((m = decl.match(/^item\s+(.*)$/))) {
        const d = parseDecl(m[1]);
        if (!d) { err(ln, `bad item declaration — expected: item id "Name" skill+1 other-1`); continue; }
        const mods: Record<string, number> = {};
        let ok = true;
        if (d.tail) {
          for (const part of d.tail.split(/\s+/)) {
            const pm = part.match(/^([A-Za-z_]\w*)([+-]\d+)$/);
            if (!pm) { err(ln, `bad item modifier "${part}" — expected like logic+1`); ok = false; break; }
            mods[pm[1].toLowerCase()] = parseInt(pm[2], 10);
          }
        }
        if (!ok) continue;
        if (game.items[d.id]) { err(ln, `item "${d.id}" is already declared`); continue; }
        game.items[d.id] = { id: d.id, name: d.name, mods };
        continue;
      }

      if ((m = decl.match(/^currency\s+(.*)$/))) {
        const d = parseDecl(m[1]);
        if (!d) { err(ln, `bad currency declaration — expected: currency real "Réal" = 20`); continue; }
        if (game.currency) { err(ln, `currency is already declared ("${game.currency.id}")`); continue; }
        if (d.id in game.vars || game.skills[d.id]) { err(ln, `"${d.id}" is already declared`); continue; }
        let start = 0;
        const sm = d.tail.match(/^=\s*(-?\d+)\s*$/);
        if (sm) start = parseInt(sm[1], 10);
        else if (d.tail) { err(ln, `bad currency declaration — expected: currency real "Réal" = 20`); continue; }
        game.currency = { id: d.id, name: d.name };
        game.vars[d.id] = start;
        continue;
      }

      if ((m = decl.match(/^(var|stat)\s+([A-Za-z_]\w*)\s*=\s*(.+)$/))) {
        const kind = m[1], name = m[2].toLowerCase(), lit = m[3].trim();
        let v: Value;
        if (/^-?\d+(\.\d+)?$/.test(lit)) v = parseFloat(lit);
        else if (lit === "true" || lit === "false") v = lit === "true";
        else if (/^"[^"]*"$/.test(lit)) v = lit.slice(1, -1);
        else { err(ln, `${kind} value must be a number, true/false, or "string"`); continue; }
        if (name in game.vars || game.skills[name]) { err(ln, `"${name}" is already declared`); continue; }
        game.vars[name] = v;
        if (kind === "stat") game.stats.push(name);
        continue;
      }

      err(ln, `expected a declaration (@title, skill, char, item, var, stat) or a passage (== name)`);
      continue;
    }

    // --- passage content ---

    // * [groups...] Choice text -> target  /  -> success | fail
    // Groups compose: [once], [conditions...], one [white/red skill N], one [pay/earn N].
    if (text.startsWith("*")) {
      const split = splitGroups(text.slice(1).trim());
      if (!split) { err(ln, `unclosed [ bracket in choice`); continue; }
      const cm = split.rest.match(/^(.+?)\s*->\s*(.+)$/);
      if (!cm) { err(ln, `bad choice — expected: * [optional brackets] Text -> target`); continue; }
      const [, ctext, targetPart] = cm;
      const choice: Choice = {
        id: `${passage.id}#${passage.steps.length}`,
        text: ctext,
        line: ln,
      };
      const conds: Expr[] = [];
      let bad = false;
      for (const g of split.groups) {
        if (!g) { err(ln, `empty [] bracket on choice`); bad = true; break; }
        if (/^once$/i.test(g)) { choice.once = true; continue; }
        const ck = g.match(/^(white|red)\s+([A-Za-z_]\w*)\s+(\d+)$/i);
        if (ck) {
          if (choice.check) { err(ln, `a choice can only have one skill check`); bad = true; break; }
          const skill = ck[2].toLowerCase();
          exprRefs.push({ line: ln, idents: new Set([skill]), items: new Set() });
          choice.check = {
            type: ck[1].toLowerCase() as "white" | "red",
            skill,
            difficulty: parseInt(ck[3], 10),
            success: "", // targets filled in below
            fail: "",
          };
          continue;
        }
        const costm = g.match(/^(pay|earn)\s+(\d+)$/i);
        if (costm) {
          if (!game.currency) { err(ln, `[${costm[1]}] needs a currency — declare one first: currency real "Réal" = 20`); bad = true; break; }
          if (choice.cost) { err(ln, `a choice can only have one [pay]/[earn]`); bad = true; break; }
          choice.cost = { kind: costm[1].toLowerCase() as "pay" | "earn", amount: parseInt(costm[2], 10) };
          continue;
        }
        const cond = parseCondOrNull(g, ln);
        if (!cond) { bad = true; break; }
        conds.push(cond);
      }
      if (bad) continue;
      if (conds.length) {
        choice.cond = conds.reduce((l, r) => ({ t: "bin", op: "and", l, r }));
      }
      if (choice.check) {
        const targets = targetPart.split("|").map((s) => s.trim().toLowerCase());
        if (targets.length !== 2 || !targets[0] || !targets[1]) {
          err(ln, `a check needs two targets: -> success_passage | fail_passage`);
          continue;
        }
        targetRefs.push({ line: ln, target: targets[0] });
        targetRefs.push({ line: ln, target: targets[1] });
        choice.check.success = targets[0];
        choice.check.fail = targets[1];
      } else {
        const target = targetPart.trim().toLowerCase();
        if (target.includes("|")) { err(ln, `only checks ([white skill 10]) may have two targets`); continue; }
        targetRefs.push({ line: ln, target });
        choice.target = target;
      }
      passage.steps.push({ kind: "choice", choice });
      continue;
    }

    // Non-choice lines may start with [once] and/or [condition] gates.
    const gate: { cond?: Expr; once?: boolean } = {};
    let content = text;
    if (content.startsWith("[")) {
      const split = splitGroups(content);
      if (!split) { err(ln, `unclosed [ bracket — for literal brackets start the line with |`); continue; }
      const conds: Expr[] = [];
      let bad = false;
      for (const g of split.groups) {
        if (/^once$/i.test(g)) { gate.once = true; continue; }
        if (/^(white|red|pay|earn)\s/i.test(g)) { err(ln, `[${g.split(/\s/)[0]}] only works on * choices`); bad = true; break; }
        const cond = parseCondOrNull(g, ln);
        if (!cond) { bad = true; break; }
        conds.push(cond);
      }
      if (bad) continue;
      if (conds.length) gate.cond = conds.reduce((l, r) => ({ t: "bin", op: "and", l, r }));
      content = split.rest;
      if (!content) { err(ln, `[brackets] need a line after them`); continue; }
    }

    // -> target  (jump; with a gate this is a conditional jump)
    if ((m = content.match(/^->\s*(\S+)\s*$/))) {
      const target = m[1].toLowerCase();
      targetRefs.push({ line: ln, target });
      passage.steps.push({ kind: "goto", target, ...gate });
      continue;
    }

    // ? skill 8: passive interjection
    if (content.startsWith("?")) {
      const pm = content.match(/^\?\s*([A-Za-z_]\w*)\s+(\d+)\s*:\s*(.+)$/);
      if (!pm) { err(ln, `bad passive check — expected: ? skill 8: Text shown when skill total >= 8`); continue; }
      const skill = pm[1].toLowerCase();
      exprRefs.push({ line: ln, idents: new Set([skill]), items: new Set() });
      passage.steps.push({
        kind: "passive",
        id: `p${passiveCount++}`,
        skill,
        difficulty: parseInt(pm[2], 10),
        text: pm[3],
        ...gate,
      });
      continue;
    }

    // ~ effect
    if (content.startsWith("~")) {
      const body = content.slice(1).trim();
      let effect: Effect | null = null;
      if ((m = body.match(/^set\s+([A-Za-z_]\w*)\s*=\s*(.+)$/))) {
        const e = parseCondOrNull(m[2], ln);
        if (!e) continue;
        const name = m[1].toLowerCase();
        exprRefs.push({ line: ln, idents: new Set([name]), items: new Set() });
        effect = { kind: "set", name, expr: e };
      } else if ((m = body.match(/^(give|take|equip|unequip)\s+([A-Za-z_]\w*)\s*$/))) {
        effect = { kind: m[1] as "give", item: m[2].toLowerCase() };
        exprRefs.push({ line: ln, idents: new Set(), items: new Set([effect.item]) });
      } else if ((m = body.match(/^wardrobe\s+(open|close)\s*$/))) {
        effect = { kind: "wardrobe", open: m[1] === "open" };
      } else if (body === "save") {
        effect = { kind: "save" };
      } else if ((m = body.match(/^points\s+(\d+)\s*$/))) {
        const amount = parseInt(m[1], 10);
        if (amount < 1) { err(ln, `~ points needs a positive number of skill points`); continue; }
        effect = { kind: "points", amount };
      } else if ((m = body.match(/^skill\s+([A-Za-z_]\w*)\s*([+-]\d+)\s*$/))) {
        const skill = m[1].toLowerCase();
        const amount = parseInt(m[2], 10);
        if (!game.skills[skill]) { err(ln, `unknown skill "${m[1]}" — ~ skill changes a declared skill, e.g. ~ skill sangfroid -1`); continue; }
        if (amount === 0) { err(ln, `~ skill needs a non-zero change, e.g. ~ skill ${skill} +1`); continue; }
        effect = { kind: "skillmod", skill, amount };
      } else if ((m = body.match(/^(pay|earn)\s+(.+)$/))) {
        if (!game.currency) { err(ln, `~ ${m[1]} needs a currency — declare one first: currency real "Réal" = 20`); continue; }
        const e = parseCondOrNull(m[2], ln);
        if (!e) continue;
        effect = { kind: m[1] as "pay", expr: e };
      } else {
        err(ln, `bad effect — expected: ~ set name = expr | ~ give/take/equip/unequip item | ~ pay/earn amount | ~ points 1 | ~ skill name +1 | ~ save | ~ wardrobe open/close`);
        continue;
      }
      passage.steps.push({ kind: "effect", effect, line: ln, ...gate });
      continue;
    }

    // speaker: dialogue  /  narration
    const sm = content.match(/^([A-Za-z_]\w*)\s*:\s*(.+)$/);
    if (sm) {
      const id = sm[1].toLowerCase();
      if (game.chars[id] || game.skills[id]) {
        passage.steps.push({ kind: "say", speaker: id, text: sm[2], ...gate });
        continue;
      }
      err(ln, `unknown speaker "${sm[1]}" — declare it with char/skill, or start the line with | for plain narration`);
      continue;
    }
    passage.steps.push({ kind: "say", speaker: "", text: content.startsWith("|") ? content.slice(1).trim() : content, ...gate });
  }

  // --- whole-document validation ---
  if (explicitStart) game.start = explicitStart;
  if (!game.start) err(0, "no passages defined — add one with: == start");

  for (const ref of targetRefs) {
    if (ref.target !== "end" && ref.target !== "fail" && !game.passages[ref.target]) {
      err(ref.line, `unknown passage "${ref.target}"`);
    }
  }
  for (const ref of exprRefs) {
    for (const id of ref.idents) {
      if (!(id in game.vars) && !game.skills[id]) {
        err(ref.line, `unknown name "${id}" — not a declared var, stat, or skill`);
      }
    }
    for (const it of ref.items) {
      if (!game.items[it]) err(ref.line, `unknown item "${it}"`);
    }
  }
  for (const item of Object.values(game.items)) {
    for (const sk of Object.keys(item.mods)) {
      if (!game.skills[sk]) err(0, `item "${item.id}" modifies unknown skill "${sk}"`);
    }
  }

  // A passage with both choices and an UNCONDITIONAL goto is almost always a
  // mistake — gated jumps ([cond] -> x / [once] -> x) combine with choices fine.
  for (const p of Object.values(game.passages)) {
    const hasChoice = p.steps.some((s) => s.kind === "choice");
    const goto = p.steps.find((s) => s.kind === "goto" && !s.cond && !s.once);
    if (hasChoice && goto) {
      err(p.line, `passage "${p.id}" has both choices (*) and an unconditional jump (->) — the jump would always win`);
    }
  }

  // --- warnings (non-blocking) ---
  const warnings: ParseError[] = [];

  // {interpolations} count as usage of vars/items, but never produce errors —
  // prose can legitimately contain braces.
  const interpIdents = new Set<string>();
  const interpItems = new Set<string>();
  const scanText = (text: string) => {
    for (const im of text.matchAll(/\{([^}]+)\}/g)) {
      try {
        collectRefs(parseExpr(im[1]), interpIdents, interpItems);
      } catch { /* not an expression — leave it alone */ }
    }
  };
  for (const p of Object.values(game.passages)) {
    for (const s of p.steps) {
      if (s.kind === "say" || s.kind === "passive") scanText(s.text);
      else if (s.kind === "choice") scanText(s.choice.text);
    }
  }

  // Unreachable passages: walk every jump/choice/check edge from the start.
  const reachable = new Set<string>();
  const queue = [game.start];
  while (queue.length) {
    const id = queue.pop()!;
    const p = game.passages[id];
    if (!p || reachable.has(id)) continue;
    reachable.add(id);
    for (const s of p.steps) {
      if (s.kind === "goto") queue.push(s.target);
      else if (s.kind === "choice") {
        if (s.choice.target) queue.push(s.choice.target);
        if (s.choice.check) queue.push(s.choice.check.success, s.choice.check.fail);
      }
    }
  }
  for (const p of Object.values(game.passages)) {
    if (!reachable.has(p.id)) warnings.push({ line: p.line, message: `passage "${p.id}" can never be reached from "${game.start}"` });
  }

  const usedIdents = new Set(interpIdents);
  const usedItems = new Set(interpItems);
  for (const r of exprRefs) {
    for (const i of r.idents) usedIdents.add(i);
    for (const i of r.items) usedItems.add(i);
  }
  for (const it of Object.values(game.items)) {
    if (!usedItems.has(it.id)) warnings.push({ line: 0, message: `item "${it.id}" is declared but never given, equipped, or checked` });
  }
  for (const name of Object.keys(game.vars)) {
    if (game.stats.includes(name) || game.currency?.id === name) continue;
    if (!usedIdents.has(name)) warnings.push({ line: 0, message: `var "${name}" is declared but never used` });
  }

  return { game: errors.length === 0 || game.start ? game : null, errors, warnings };
}
