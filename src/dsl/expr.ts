// Tiny expression language used in choice conditions, ~set effects,
// and {curly} interpolation. Recursive descent over a hand-rolled tokenizer.

import type { Expr, BinOp } from "./types";

interface Tok {
  t: "num" | "str" | "ident" | "op";
  v: string;
}

const OPS = ["==", "!=", ">=", "<=", "&&", "||", ">", "<", "+", "-", "*", "/", "(", ")", "!", ","];

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== q) { s += src[j]; j++; }
      if (j >= src.length) throw new Error("unterminated string");
      toks.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      toks.push({ t: "num", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /\w/.test(src[j])) j++;
      toks.push({ t: "ident", v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS.includes(two)) { toks.push({ t: "op", v: two }); i += 2; continue; }
    if (OPS.includes(c)) { toks.push({ t: "op", v: c }); i += 1; continue; }
    throw new Error(`unexpected character '${c}'`);
  }
  return toks;
}

class P {
  pos = 0;
  constructor(public toks: Tok[]) {}
  peek(): Tok | undefined { return this.toks[this.pos]; }
  next(): Tok | undefined { return this.toks[this.pos++]; }
  expectOp(v: string) {
    const t = this.next();
    if (!t || t.t !== "op" || t.v !== v) throw new Error(`expected '${v}'`);
  }

  // or -> and -> cmp -> add -> mul -> unary -> atom
  parseOr(): Expr {
    let l = this.parseAnd();
    while (this.isWord("or") || this.isOp("||")) {
      this.next();
      l = { t: "bin", op: "or", l, r: this.parseAnd() };
    }
    return l;
  }
  parseAnd(): Expr {
    let l = this.parseCmp();
    while (this.isWord("and") || this.isOp("&&")) {
      this.next();
      l = { t: "bin", op: "and", l, r: this.parseCmp() };
    }
    return l;
  }
  parseCmp(): Expr {
    let l = this.parseAdd();
    const t = this.peek();
    if (t && t.t === "op" && ["==", "!=", ">=", "<=", ">", "<"].includes(t.v)) {
      this.next();
      l = { t: "bin", op: t.v as BinOp, l, r: this.parseAdd() };
    }
    return l;
  }
  parseAdd(): Expr {
    let l = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t && t.t === "op" && (t.v === "+" || t.v === "-")) {
        this.next();
        l = { t: "bin", op: t.v as BinOp, l, r: this.parseMul() };
      } else return l;
    }
  }
  parseMul(): Expr {
    let l = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t && t.t === "op" && (t.v === "*" || t.v === "/")) {
        this.next();
        l = { t: "bin", op: t.v as BinOp, l, r: this.parseUnary() };
      } else return l;
    }
  }
  parseUnary(): Expr {
    if (this.isOp("!") || this.isWord("not")) {
      this.next();
      return { t: "un", op: "not", e: this.parseUnary() };
    }
    if (this.isOp("-")) {
      this.next();
      return { t: "un", op: "neg", e: this.parseUnary() };
    }
    return this.parseAtom();
  }
  parseAtom(): Expr {
    const t = this.next();
    if (!t) throw new Error("unexpected end of expression");
    if (t.t === "num") return { t: "num", v: parseFloat(t.v) };
    if (t.t === "str") return { t: "str", v: t.v };
    if (t.t === "ident") {
      if (t.v === "true") return { t: "bool", v: true };
      if (t.v === "false") return { t: "bool", v: false };
      if (t.v === "has" && this.isOp("(")) {
        this.next();
        const id = this.next();
        if (!id || id.t !== "ident") throw new Error("has() expects an item id");
        this.expectOp(")");
        return { t: "has", item: id.v.toLowerCase() };
      }
      return { t: "ident", name: t.v.toLowerCase() };
    }
    if (t.t === "op" && t.v === "(") {
      const e = this.parseOr();
      this.expectOp(")");
      return e;
    }
    throw new Error(`unexpected '${t.v}'`);
  }
  isOp(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === "op" && t.v === v;
  }
  isWord(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === "ident" && t.v === v;
  }
}

/** Parse an expression; throws Error with a human-readable message. */
export function parseExpr(src: string): Expr {
  const p = new P(tokenize(src));
  const e = p.parseOr();
  if (p.pos < p.toks.length) throw new Error(`unexpected '${p.toks[p.pos].v}'`);
  return e;
}

/** Collect every identifier (and has() item) referenced, for compile-time validation. */
export function collectRefs(e: Expr, idents: Set<string>, items: Set<string>): void {
  switch (e.t) {
    case "ident": idents.add(e.name); break;
    case "has": items.add(e.item); break;
    case "un": collectRefs(e.e, idents, items); break;
    case "bin":
      collectRefs(e.l, idents, items);
      collectRefs(e.r, idents, items);
      break;
  }
}
