// Compiled game definition — the output of the parser, the input of the runtime.

export type Value = number | boolean | string;

export type Expr =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "ident"; name: string }
  | { t: "has"; item: string }
  | { t: "un"; op: "not" | "neg"; e: Expr }
  | { t: "bin"; op: BinOp; l: Expr; r: Expr };

export type BinOp =
  | "or" | "and"
  | "==" | "!=" | ">=" | "<=" | ">" | "<"
  | "+" | "-" | "*" | "/";

export interface SkillDef {
  id: string;
  name: string;
  color: string;
  base: number;
}

export interface CharDef {
  id: string;
  name: string;
  color: string;
}

export interface ItemDef {
  id: string;
  name: string;
  mods: Record<string, number>; // skill id -> modifier
}

export type CheckType = "white" | "red";

export interface Check {
  type: CheckType;
  skill: string;
  difficulty: number;
  success: string; // target passage
  fail: string;    // target passage
}

export interface Choice {
  id: string; // stable: "<passage>#<n>"
  text: string;
  cond?: Expr;
  check?: Check;
  /** [pay 20] / [earn 5] — shown as a tag; pay greys out when unaffordable. */
  cost?: { kind: "pay" | "earn"; amount: number };
  /** [once] — the choice disappears after being picked. */
  once?: boolean;
  target?: string; // for plain choices; "END" ends the game
  line: number;
}

export type Effect =
  | { kind: "set"; name: string; expr: Expr }
  | { kind: "give" | "take" | "equip" | "unequip"; item: string }
  | { kind: "wardrobe"; open: boolean }
  | { kind: "pay" | "earn"; expr: Expr }
  | { kind: "save" }
  | { kind: "points"; amount: number };

// Non-choice steps may carry a line condition ([expr]) and/or [once];
// the step is skipped when the condition is falsy or it already ran.
export interface LineGate {
  cond?: Expr;
  once?: boolean;
}

export type Step =
  | ({ kind: "say"; speaker: string; text: string } & LineGate) // speaker "" = narration
  | ({ kind: "passive"; id: string; skill: string; difficulty: number; text: string } & LineGate)
  | ({ kind: "effect"; effect: Effect; line: number } & LineGate)
  | { kind: "choice"; choice: Choice }
  | ({ kind: "goto"; target: string } & LineGate);

export interface Passage {
  id: string;
  line: number;
  steps: Step[];
}

export type FontChoice = "mono" | "serif" | "book" | "sans" | "humanist";

export interface Theme {
  bg?: string;
  accent?: string;
  font?: FontChoice;
}

export interface GameDef {
  title: string;
  author: string;
  start: string;
  theme: Theme;
  /** When set, players distribute this many extra skill points before play. */
  points: { pool: number; max?: number } | null;
  /** Whether players may freely equip/unequip from the start (default: locked). */
  wardrobe: boolean;
  /** Money: a var (id) rendered in the HUD, spent/gained via ~ pay / ~ earn. */
  currency: { id: string; name: string } | null;
  /** Fail rules (@fail expr "msg"): when true after a state change, the run
   *  fails and the player returns to the last checkpoint. */
  fails: { cond: Expr; message?: string }[];
  skills: Record<string, SkillDef>;
  chars: Record<string, CharDef>;
  items: Record<string, ItemDef>;
  vars: Record<string, Value>;
  stats: string[]; // var names shown in the HUD, in order
  passages: Record<string, Passage>;
}

export interface ParseError {
  line: number; // 1-based; 0 = whole document
  message: string;
}

export interface ParseResult {
  game: GameDef | null; // null when errors prevent a usable game
  errors: ParseError[];
  /** Non-blocking structural issues: unreachable passages, unused items/vars. */
  warnings: ParseError[];
}
