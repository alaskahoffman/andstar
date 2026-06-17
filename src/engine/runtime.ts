// Game runtime: executes a compiled GameDef, producing a log of entries
// and a set of currently-available choices. Pure state machine — no DOM.

import type { GameDef, Expr, Value, Choice, Effect } from "../dsl/types";
import { parseExpr } from "../dsl/expr";

export interface RollDetail {
  type: "white" | "red";
  skill: string;
  skillName: string;
  color: string;
  difficulty: number;
  difficultyLabel: string;
  d1: number;
  d2: number;
  skillValue: number; // base value (without equipment)
  mods: { name: string; value: number }[]; // equipment contributions
  total: number;
  success: boolean;
  crit: "success" | "fail" | null;
}

export type LogEntry =
  | { kind: "narration"; text: string }
  | { kind: "dialogue"; name: string; color: string; isSkill: boolean; text: string }
  | { kind: "passive"; name: string; color: string; difficulty: number; text: string }
  | { kind: "roll"; roll: RollDetail }
  | { kind: "system"; text: string }
  | { kind: "fail"; text?: string }
  | { kind: "end" };

export interface VisibleChoice {
  id: string;
  text: string;
  /** Picked before — renders red, DE-style. */
  used?: boolean;
  /** A used [once] choice: still listed, but dead. */
  locked?: boolean;
  /** [pay]/[earn] tag; locked = can't afford the pay. */
  cost?: { kind: "pay" | "earn"; amount: number; name: string; locked: boolean };
  check?: {
    type: "white" | "red";
    skillName: string;
    color: string;
    difficulty: number;
    difficultyLabel: string;
    chance: number; // 0..1 success probability at current totals
    failedBefore: boolean;
    /** Failed white check, and the skill total hasn't improved since — not selectable. */
    locked: boolean;
  };
}

interface CheckOutcome {
  result: "passed" | "failed";
  /** BASE skill at the moment of a white-check failure. Retries unlock only
   *  when the skill itself grows past this — equipment affects rolls, but
   *  re-dressing can't reopen a failed check. */
  atValue: number;
}

/** Snapshot produced by the ~ save effect; restorable via RuntimeOptions.restore. */
export interface SaveData {
  v: 1;
  at: { passage: string; step: number };
  vars: Record<string, Value>;
  inventory: Record<string, number>; // item id -> count (older saves may be a string[])
  equipped: string[];
  firedPassives: string[];
  checkState: Record<string, CheckOutcome>;
  pendingChoiceIds: string[];
  wardrobeOpen: boolean;
  pendingPoints: number;
  /** [once] lines already shown (passage#step). */
  firedOnce?: string[];
  /** Legacy name for chosenEver — older saves only recorded [once] picks. */
  chosenOnce?: string[];
  /** Every choice id ever picked (used-choice display + [once] locking). */
  chosenEver?: string[];
  log: LogEntry[];
}

export interface RuntimeOptions {
  rng?: () => number;
  /** Final skill values from the character build screen. */
  build?: Record<string, number>;
  /** Begin at this passage instead of the game's start (playtesting). */
  startAt?: string;
  /** Resume from a ~ save snapshot instead of starting fresh. */
  restore?: SaveData;
  /** Called whenever a ~ save effect runs. */
  onSave?: (snap: SaveData) => void;
}

export function difficultyLabel(d: number): string {
  if (d <= 6) return "Trivial";
  if (d <= 8) return "Easy";
  if (d <= 10) return "Medium";
  if (d <= 12) return "Challenging";
  if (d <= 14) return "Formidable";
  if (d <= 16) return "Legendary";
  if (d <= 18) return "Heroic";
  return "Impossible";
}

// P(2d6 + bonus >= difficulty), with double-1 auto-fail / double-6 auto-success.
function successChance(bonus: number, difficulty: number): number {
  let wins = 0;
  for (let a = 1; a <= 6; a++) {
    for (let b = 1; b <= 6; b++) {
      if (a === 1 && b === 1) continue; // crit fail
      if ((a === 6 && b === 6) || a + b + bonus >= difficulty) wins++;
    }
  }
  return wins / 36;
}

export class Runtime {
  log: LogEntry[] = [];
  ended = false;
  /** A fail state was reached; the player should return to the last checkpoint. */
  failed = false;
  /** Whether the player may freely toggle equipment right now. */
  wardrobeOpen: boolean;
  /** Skill points granted by ~ points and not yet allocated. */
  pendingPoints = 0;

  private vars = new Map<string, Value>();
  private inventory = new Map<string, number>(); // item id -> count held
  private equipped = new Set<string>();
  private firedPassives = new Set<string>();
  private firedOnce = new Set<string>(); // [once] lines, keyed passage#step
  private chosenEver = new Set<string>(); // every picked choice id
  // choice id -> outcome of its check
  private checkState = new Map<string, CheckOutcome>();
  private pendingChoices: Choice[] = [];
  private choiceIndex = new Map<string, Choice>();
  private rng: () => number;
  private onSave?: (snap: SaveData) => void;

  constructor(public game: GameDef, opts: RuntimeOptions = {}) {
    this.rng = opts.rng ?? Math.random;
    this.onSave = opts.onSave;
    this.wardrobeOpen = game.wardrobe;
    for (const p of Object.values(game.passages)) {
      for (const s of p.steps) if (s.kind === "choice") this.choiceIndex.set(s.choice.id, s.choice);
    }
    for (const [k, v] of Object.entries(game.vars)) this.vars.set(k, v);
    for (const s of Object.values(game.skills)) this.vars.set(s.id, opts.build?.[s.id] ?? s.base);

    if (opts.restore) {
      const snap = opts.restore;
      this.vars = new Map(Object.entries(snap.vars));
      // Older saves stored inventory as a string[] (each item count 1).
      this.inventory = Array.isArray(snap.inventory)
        ? new Map((snap.inventory as string[]).map((id) => [id, 1]))
        : new Map(Object.entries(snap.inventory));
      this.equipped = new Set(snap.equipped);
      this.firedPassives = new Set(snap.firedPassives);
      this.firedOnce = new Set(snap.firedOnce ?? []);
      this.chosenEver = new Set([...(snap.chosenEver ?? []), ...(snap.chosenOnce ?? [])]);
      this.checkState = new Map(Object.entries(snap.checkState));
      this.wardrobeOpen = snap.wardrobeOpen;
      this.pendingPoints = snap.pendingPoints;
      this.log = snap.log.slice();
      this.pendingChoices = snap.pendingChoiceIds
        .map((id) => this.choiceIndex.get(id))
        .filter((c): c is Choice => !!c);
      if (!game.passages[snap.at.passage]) throw new Error(`saved passage "${snap.at.passage}" no longer exists`);
      // Re-run the rest of the checkpoint's passage (deterministic: no dice in steps).
      this.enterPassage(snap.at.passage, snap.at.step + 1);
    } else {
      this.enterPassage(opts.startAt ?? game.start);
    }
  }

  // ---- public API ----

  getChoices(): VisibleChoice[] {
    if (this.failed) return [];
    const out: VisibleChoice[] = [];
    for (const c of this.pendingChoices) {
      if (c.cond && !truthy(this.evalExpr(c.cond))) continue;
      const used = this.chosenEver.has(c.id);
      const vc: VisibleChoice = { id: c.id, text: this.interpolate(c.text) };
      if (used) {
        vc.used = true;
        if (c.once) vc.locked = true; // stays visible, but dead
      }
      if (c.cost) {
        const cur = this.game.currency!;
        const balance = Number(this.vars.get(cur.id) ?? 0);
        vc.cost = {
          kind: c.cost.kind,
          amount: c.cost.amount,
          name: cur.name,
          locked: c.cost.kind === "pay" && balance < c.cost.amount,
        };
      }
      if (c.check) {
        const prior = this.checkState.get(c.id);
        if (prior?.result === "passed") continue; // already won this one
        if (prior?.result === "failed" && c.check.type === "red") continue; // red = one shot
        const skill = this.game.skills[c.check.skill];
        const bonus = this.effectiveSkill(c.check.skill);
        const failedBefore = prior?.result === "failed";
        vc.check = {
          type: c.check.type,
          skillName: skill?.name ?? c.check.skill,
          color: skill?.color ?? "#fff",
          difficulty: c.check.difficulty,
          difficultyLabel: difficultyLabel(c.check.difficulty),
          chance: successChance(bonus, c.check.difficulty),
          failedBefore,
          // Locked until the skill itself is upgraded past its fail-time value.
          locked: failedBefore && this.skillBase(c.check.skill) <= prior!.atValue,
        };
      }
      out.push(vc);
    }
    return out;
  }

  choose(choiceId: string): void {
    if (this.ended || this.failed) return;
    const c = this.pendingChoices.find((x) => x.id === choiceId);
    if (!c) return;
    if (c.check) {
      const prior = this.checkState.get(c.id);
      if (prior?.result === "passed") return;
      if (prior?.result === "failed" &&
          (c.check.type === "red" || this.skillBase(c.check.skill) <= prior.atValue)) {
        return; // locked
      }
    }
    if (c.once && this.chosenEver.has(c.id)) return;
    if (c.cost?.kind === "pay" &&
        Number(this.vars.get(this.game.currency!.id) ?? 0) < c.cost.amount) {
      return; // can't afford it
    }
    this.chosenEver.add(c.id);
    this.log.push({ kind: "narration", text: `» ${this.interpolate(c.text)}` });
    if (c.cost) {
      this.applyEffect({ kind: c.cost.kind, expr: { t: "num", v: c.cost.amount } });
    }
    if (c.check) {
      const roll = this.rollCheck(c);
      this.log.push({ kind: "roll", roll });
      this.checkState.set(c.id, {
        result: roll.success ? "passed" : "failed",
        atValue: this.skillBase(c.check.skill),
      });
      this.enterPassage(roll.success ? c.check.success : c.check.fail);
    } else {
      this.enterPassage(c.target!);
    }
  }

  /** Spend all pending skill points. alloc maps skill id -> points to add. */
  allocatePoints(alloc: Record<string, number>): boolean {
    const total = Object.values(alloc).reduce((a, b) => a + b, 0);
    // Can't overspend; spending fewer than granted forfeits the rest (only
    // reachable when every skill is already at its ceiling).
    if (total > this.pendingPoints) return false;
    for (const [id, n] of Object.entries(alloc)) {
      if (n < 0 || !this.game.skills[id]) return false;
    }
    for (const [id, n] of Object.entries(alloc)) {
      if (n > 0) this.vars.set(id, Number(this.vars.get(id) ?? 0) + n);
    }
    this.pendingPoints = 0;
    return true;
  }

  effectiveSkill(id: string): number {
    let v = Number(this.vars.get(id) ?? 0);
    for (const itemId of this.equipped) {
      v += this.game.items[itemId]?.mods[id] ?? 0;
    }
    return v;
  }

  skillBase(id: string): number {
    return Number(this.vars.get(id) ?? 0);
  }

  statValue(name: string): Value {
    return this.vars.get(name) ?? 0;
  }

  getInventory(): { id: string; name: string; count: number; equipped: boolean; equippable: boolean; mods: Record<string, number>; consumable?: Record<string, number>; slot?: string }[] {
    return [...this.inventory].map(([id, count]) => {
      const def = this.game.items[id];
      const mods = def?.mods ?? {};
      return {
        id,
        name: def?.name ?? id,
        count,
        equipped: this.equipped.has(id),
        equippable: Object.keys(mods).length > 0,
        mods,
        consumable: def?.consumable,
        slot: def?.slot,
      };
    });
  }

  toggleEquip(itemId: string): void {
    if (!this.wardrobeOpen || !this.inventory.has(itemId)) return;
    if (Object.keys(this.game.items[itemId]?.mods ?? {}).length === 0) return; // plain possession
    if (this.equipped.has(itemId)) this.equipped.delete(itemId);
    else this.equipItem(itemId);
  }

  // Use a consumable: apply its stat changes (clamped at a capped stat's max),
  // spend one, and re-check fail rules. Allowed any time — it touches stats, not
  // the skills a roll depends on, so it can't be used to game a check.
  useItem(itemId: string): void {
    const def = this.game.items[itemId];
    if (!def?.consumable || (this.inventory.get(itemId) ?? 0) <= 0) return;
    for (const [target, delta] of Object.entries(def.consumable)) {
      let v = Number(this.vars.get(target) ?? 0) + delta;
      const cap = this.game.stats.find((s) => s.name === target)?.max;
      if (cap !== undefined && v > cap) v = cap;
      this.vars.set(target, v);
    }
    const left = this.inventory.get(itemId)! - 1;
    if (left > 0) this.inventory.set(itemId, left);
    else this.inventory.delete(itemId);
    this.log.push({ kind: "system", text: `Used ${def.name}` });
    this.checkFailRules();
  }

  // Equip an item, honoring its slot limit. A slot caps how many of its items
  // may be worn at once; equipping into a full one evicts the item equipped
  // longest ago (Set iterates in insertion order), so a limit-1 slot acts as a
  // swap and a limit-N slot as a budget you rotate through.
  private equipItem(itemId: string): void {
    if (this.equipped.has(itemId)) return;
    const slot = this.game.items[itemId]?.slot;
    const limit = slot ? this.game.slots[slot]?.limit : undefined;
    if (slot && limit) {
      const worn = [...this.equipped].filter((id) => this.game.items[id]?.slot === slot);
      while (worn.length >= limit) this.equipped.delete(worn.shift()!);
    }
    this.equipped.add(itemId);
  }

  // ---- internals ----

  private enterPassage(id: string, fromStep = 0): void {
    if (fromStep === 0) this.pendingChoices = []; // restore pre-seeds choices
    let current = id;
    let skip = fromStep;
    for (let hops = 0; hops < 100; hops++) {
      if (current === "end") {
        this.ended = true;
        this.log.push({ kind: "end" });
        return;
      }
      if (current === "fail") {
        this.doFail();
        return;
      }
      const p = this.game.passages[current];
      if (!p) {
        this.log.push({ kind: "system", text: `runtime error: passage "${current}" not found` });
        this.ended = true;
        return;
      }
      let jumped = false;
      for (let si = skip; si < p.steps.length; si++) {
        const step = p.steps[si];
        // [condition] and [once] line gates (choices handle their own).
        if (step.kind !== "choice") {
          if (step.cond && !truthy(this.evalExpr(step.cond))) continue;
          if (step.once) {
            const key = `${current}#${si}`;
            if (this.firedOnce.has(key)) continue;
            this.firedOnce.add(key);
          }
        }
        switch (step.kind) {
          case "say": {
            const text = this.interpolate(step.text);
            if (!step.speaker) {
              this.log.push({ kind: "narration", text });
            } else {
              const ch = this.game.chars[step.speaker];
              const sk = this.game.skills[step.speaker];
              this.log.push({
                kind: "dialogue",
                name: (ch ?? sk)?.name ?? step.speaker,
                color: (ch ?? sk)?.color ?? "#fff",
                isSkill: !!sk,
                text,
              });
            }
            break;
          }
          case "passive": {
            if (this.firedPassives.has(step.id)) break;
            if (this.effectiveSkill(step.skill) >= step.difficulty) {
              this.firedPassives.add(step.id);
              const sk = this.game.skills[step.skill];
              this.log.push({
                kind: "passive",
                name: sk?.name ?? step.skill,
                color: sk?.color ?? "#fff",
                difficulty: step.difficulty,
                text: this.interpolate(step.text),
              });
            }
            break;
          }
          case "effect":
            if (step.effect.kind === "save") this.checkpoint(current, si);
            else {
              this.applyEffect(step.effect);
              if (this.checkFailRules()) return; // state change hit a @fail rule
            }
            break;
          case "choice":
            this.pendingChoices.push(step.choice);
            break;
          case "goto":
            current = step.target;
            jumped = true;
            break;
        }
        if (jumped) break;
      }
      skip = 0;
      if (!jumped) {
        if (this.pendingChoices.length === 0 && !this.ended) {
          // Dead end with no choices: treat as an ending.
          this.ended = true;
          this.log.push({ kind: "end" });
        }
        return;
      }
    }
    this.log.push({ kind: "system", text: "runtime error: too many consecutive jumps (loop?)" });
    this.ended = true;
  }

  private applyEffect(e: Effect): void {
    switch (e.kind) {
      case "set": {
        let v = this.evalExpr(e.expr);
        // A capped stat never rises above its max (the floor is free, so @fail
        // rules that watch for <= 0 still fire).
        const cap = this.game.stats.find((s) => s.name === e.name)?.max;
        if (cap !== undefined && typeof v === "number" && v > cap) v = cap;
        this.vars.set(e.name, v);
        break;
      }
        break;
      case "give": {
        const n = e.amount ?? 1;
        this.inventory.set(e.item, (this.inventory.get(e.item) ?? 0) + n);
        const nm = this.game.items[e.item]?.name ?? e.item;
        this.log.push({ kind: "system", text: `Item acquired: ${nm}${n > 1 ? ` ×${n}` : ""}` });
        break;
      }
      case "take": {
        const have = this.inventory.get(e.item) ?? 0;
        if (have <= 0) break;
        const left = have - (e.amount ?? 1);
        if (left > 0) {
          this.inventory.set(e.item, left); // still holding some — the sidebar count is the signal
        } else {
          this.inventory.delete(e.item);
          this.equipped.delete(e.item);
          this.log.push({ kind: "system", text: `Item lost: ${this.game.items[e.item]?.name ?? e.item}` });
        }
        break;
      }
      case "equip":
        if (!this.inventory.has(e.item)) {
          this.inventory.set(e.item, 1);
          this.log.push({ kind: "system", text: `Item acquired: ${this.game.items[e.item]?.name ?? e.item}` });
        }
        this.equipItem(e.item);
        break;
      case "unequip":
        this.equipped.delete(e.item);
        break;
      case "points":
        this.pendingPoints += e.amount;
        this.log.push({ kind: "system", text: `+${e.amount} skill point${e.amount === 1 ? "" : "s"}` });
        break;
      case "skillmod": {
        this.vars.set(e.skill, Number(this.vars.get(e.skill) ?? 0) + e.amount);
        const name = this.game.skills[e.skill]?.name ?? e.skill;
        this.log.push({
          kind: "system",
          text: `${name} ${e.amount > 0 ? "+" : "−"}${Math.abs(e.amount)}`,
        });
        break;
      }
      case "pay":
      case "earn": {
        const cur = this.game.currency;
        if (!cur) break;
        const amt = Number(this.evalExpr(e.expr));
        const delta = e.kind === "pay" ? -amt : amt;
        this.vars.set(cur.id, Number(this.vars.get(cur.id) ?? 0) + delta);
        this.log.push({ kind: "system", text: `${delta < 0 ? "−" : "+"}${Math.abs(amt).toFixed(2)} ${cur.name}` });
        break;
      }
      case "wardrobe":
        this.wardrobeOpen = e.open; // silent — the sidebar state is the signal
        break;
    }
  }

  private checkFailRules(): boolean {
    for (const rule of this.game.fails) {
      if (truthy(this.evalExpr(rule.cond))) {
        this.doFail(rule.message);
        return true;
      }
    }
    return false;
  }

  private doFail(message?: string): void {
    this.failed = true;
    this.pendingChoices = [];
    this.log.push({ kind: "fail", text: message });
  }

  private checkpoint(passage: string, step: number): void {
    this.log.push({ kind: "system", text: "Progress saved" });
    if (!this.onSave) return;
    this.onSave({
      v: 1,
      at: { passage, step },
      vars: Object.fromEntries(this.vars),
      inventory: Object.fromEntries(this.inventory),
      equipped: [...this.equipped],
      firedPassives: [...this.firedPassives],
      checkState: Object.fromEntries(this.checkState),
      pendingChoiceIds: this.pendingChoices.map((c) => c.id),
      wardrobeOpen: this.wardrobeOpen,
      pendingPoints: this.pendingPoints,
      firedOnce: [...this.firedOnce],
      chosenEver: [...this.chosenEver],
      log: this.log.slice(),
    });
  }

  private rollCheck(c: Choice): RollDetail {
    const check = c.check!;
    const d1 = 1 + Math.floor(this.rng() * 6);
    const d2 = 1 + Math.floor(this.rng() * 6);
    const skillValue = this.skillBase(check.skill);
    const mods: { name: string; value: number }[] = [];
    for (const itemId of this.equipped) {
      const m = this.game.items[itemId]?.mods[check.skill];
      if (m) mods.push({ name: this.game.items[itemId].name, value: m });
    }
    const modSum = mods.reduce((a, m) => a + m.value, 0);
    const total = d1 + d2 + skillValue + modSum;
    let crit: RollDetail["crit"] = null;
    let success: boolean;
    if (d1 === 1 && d2 === 1) { crit = "fail"; success = false; }
    else if (d1 === 6 && d2 === 6) { crit = "success"; success = true; }
    else success = total >= check.difficulty;
    const sk = this.game.skills[check.skill];
    return {
      type: check.type,
      skill: check.skill,
      skillName: sk?.name ?? check.skill,
      color: sk?.color ?? "#fff",
      difficulty: check.difficulty,
      difficultyLabel: difficultyLabel(check.difficulty),
      d1, d2, skillValue, mods, total, success, crit,
    };
  }

  private interpolate(text: string): string {
    return text.replace(/\{([^}]+)\}/g, (whole, inner) => {
      try {
        return String(this.evalExpr(parseExpr(inner)));
      } catch {
        return whole;
      }
    });
  }

  private evalExpr(e: Expr): Value {
    switch (e.t) {
      case "num": return e.v;
      case "str": return e.v;
      case "bool": return e.v;
      case "ident":
        if (this.game.skills[e.name]) return this.effectiveSkill(e.name);
        return this.vars.get(e.name) ?? 0;
      case "has": return this.inventory.get(e.item) ?? 0; // the count held: truthy (>=1) in a bare gate, comparable/printable as a number
      case "un":
        return e.op === "not" ? !truthy(this.evalExpr(e.e)) : -Number(this.evalExpr(e.e));
      case "bin": {
        if (e.op === "and") return truthy(this.evalExpr(e.l)) ? this.evalExpr(e.r) : false;
        if (e.op === "or") {
          const l = this.evalExpr(e.l);
          return truthy(l) ? l : this.evalExpr(e.r);
        }
        const l = this.evalExpr(e.l), r = this.evalExpr(e.r);
        switch (e.op) {
          case "==": return l === r;
          case "!=": return l !== r;
          case ">=": return Number(l) >= Number(r);
          case "<=": return Number(l) <= Number(r);
          case ">": return Number(l) > Number(r);
          case "<": return Number(l) < Number(r);
          case "+": return typeof l === "string" || typeof r === "string" ? String(l) + String(r) : Number(l) + Number(r);
          case "-": return Number(l) - Number(r);
          case "*": return Number(l) * Number(r);
          case "/": return Number(l) / Number(r);
        }
      }
    }
    return 0;
  }
}

function truthy(v: Value): boolean {
  return typeof v === "string" ? v.length > 0 : !!v;
}
