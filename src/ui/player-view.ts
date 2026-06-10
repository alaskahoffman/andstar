// DOM renderer for a running game: build screen, dialogue log, choice list,
// character sheet. Used by both the editor's live preview and the public
// /play page.

import type { GameDef } from "../dsl/types";
import { Runtime, type LogEntry, type VisibleChoice, type SaveData } from "../engine/runtime";
import { applyTheme } from "./theme";

export interface SaveStore {
  load(): SaveData | null;
  store(snap: SaveData): void;
  clear(): void;
}

export interface PlayerHandle {
  restart(): void;
  destroy(): void;
}

// Remember the last point allocation so the editor preview (which remounts on
// every edit) and in-game restarts don't make you re-spec from scratch.
let lastBuild: { sig: string; alloc: Record<string, number> } | null = null;

function buildSig(game: GameDef): string {
  return Object.keys(game.skills).sort().join(",");
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface MountOptions {
  /** Skip the build screen when a previous allocation fits (editor preview). */
  autoBuild?: boolean;
  /** Begin at this passage instead of the start (playtesting). */
  startAt?: string;
  /** Persistence for ~ save checkpoints (the public play page). */
  save?: SaveStore;
  /** Reveal new lines one at a time (play pages; the editor preview is instant). */
  reveal?: boolean;
}

export function mountPlayer(container: HTMLElement, game: GameDef, opts: MountOptions = {}): PlayerHandle {
  container.innerHTML = "";
  container.classList.add("player");
  container.removeAttribute("style");
  applyTheme(container, game.theme);

  const main = el("div", "player-main");
  const logEl = el("div", "log");
  const choicesEl = el("div", "choices");
  main.append(logEl, choicesEl);

  const side = el("aside", "sheet");
  side.hidden = true;
  const sheetToggle = el("button", "sheet-toggle", "SHEET") as HTMLButtonElement;
  sheetToggle.hidden = true;
  sheetToggle.onclick = () => {
    const open = container.classList.toggle("sheet-open");
    sheetToggle.textContent = open ? "✕" : "SHEET";
  };
  container.append(main, side, sheetToggle);

  let rt: Runtime | null = null;
  let rendered = 0;
  let savedCleared = false;
  // staggered line reveal
  let revealTimer: number | null = null;
  let revealing = false;
  let instantNext = false; // restored logs render at once, not line by line
  const revealQueue: LogEntry[] = [];
  // Last checkpoint this session — fail states reload it (works in preview too,
  // where nothing is persisted).
  let lastSnap: SaveData | null = null;

  const onSave = (snap: SaveData) => {
    lastSnap = snap;
    opts.save?.store(snap);
  };

  // ---- character build screen ----

  function showBuild(): void {
    cancelReveal();
    rt = null;
    side.hidden = true;
    logEl.innerHTML = "";
    choicesEl.innerHTML = "";
    rendered = 0;

    const points = game.points!;
    const skills = Object.values(game.skills);
    const alloc: Record<string, number> = {};
    const sig = buildSig(game);
    if (lastBuild && lastBuild.sig === sig) {
      // Re-apply the previous allocation as far as the pool allows.
      let left = points.pool;
      for (const s of skills) {
        const want = Math.max(0, lastBuild.alloc[s.id] ?? 0);
        const give = Math.min(want, left, points.max !== undefined ? points.max - s.base : want);
        alloc[s.id] = Math.max(0, give);
        left -= alloc[s.id];
      }
    } else {
      for (const s of skills) alloc[s.id] = 0;
    }

    const box = el("div", "build");
    box.append(el("h2", "", "CHARACTER"));
    box.append(
      el(
        "p",
        "build-intro",
        `Distribute ${points.pool} point${points.pool === 1 ? "" : "s"} among your skills${
          points.max !== undefined ? ` (max ${points.max} per skill)` : ""
        }.`,
      ),
    );
    const rows = el("div", "build-rows");
    box.append(rows);
    const poolEl = el("p", "build-pool");
    const begin = el("button", "btn primary begin-btn", "BEGIN") as HTMLButtonElement;
    box.append(poolEl, begin);

    const remaining = () => points.pool - Object.values(alloc).reduce((a, b) => a + b, 0);

    function redraw(): void {
      rows.innerHTML = "";
      for (const s of skills) {
        const row = el("div", "build-row");
        const name = el("span", "build-name", s.name.toUpperCase());
        name.style.color = s.color;
        const minus = el("button", "build-btn", "−") as HTMLButtonElement;
        const value = el("span", "build-value", String(s.base + alloc[s.id]));
        const plus = el("button", "build-btn", "+") as HTMLButtonElement;
        minus.disabled = alloc[s.id] <= 0;
        plus.disabled =
          remaining() <= 0 || (points.max !== undefined && s.base + alloc[s.id] >= points.max);
        minus.onclick = () => { alloc[s.id]--; redraw(); };
        plus.onclick = () => { alloc[s.id]++; redraw(); };
        row.append(name, minus, value, plus);
        rows.append(row);
      }
      const r = remaining();
      poolEl.textContent = r > 0 ? `${r} point${r === 1 ? "" : "s"} remaining` : "all points spent";
      poolEl.classList.toggle("pool-left", r > 0);
      begin.textContent = r > 0 ? `BEGIN (${r} unspent)` : "BEGIN";
    }

    begin.onclick = () => {
      lastBuild = { sig, alloc: { ...alloc } };
      const build: Record<string, number> = {};
      for (const s of skills) build[s.id] = s.base + alloc[s.id];
      logEl.innerHTML = "";
      startGame(build);
    };

    redraw();
    logEl.append(box);
  }

  // ---- saved-game screen ----

  function showContinue(snap: SaveData): void {
    cancelReveal();
    rt = null;
    side.hidden = true;
    logEl.innerHTML = "";
    choicesEl.innerHTML = "";
    rendered = 0;
    const box = el("div", "build");
    box.append(el("h2", "", "SAVED GAME"));
    box.append(el("p", "build-intro", "A checkpoint exists for this game."));
    const cont = el("button", "btn primary begin-btn", "CONTINUE") as HTMLButtonElement;
    const fresh = el("button", "btn begin-btn", "START OVER") as HTMLButtonElement;
    cont.onclick = () => restoreFrom(snap);
    fresh.onclick = () => {
      opts.save?.clear();
      beginFresh();
    };
    box.append(cont, fresh);
    logEl.append(box);
  }

  function restoreFrom(snap: SaveData): void {
    try {
      cancelReveal();
      rt = new Runtime(game, { restore: snap, onSave });
      lastSnap = snap;
      rendered = 0;
      savedCleared = false;
      instantNext = true; // replayed history arrives all at once
      logEl.innerHTML = "";
      side.hidden = false;
      render();
    } catch {
      // The game changed since this save was made — start fresh.
      opts.save?.clear();
      lastSnap = null;
      beginFresh();
    }
  }

  function beginFresh(): void {
    if (game.points) showBuild();
    else startGame();
  }

  // ---- play ----

  function startGame(build?: Record<string, number>): void {
    cancelReveal();
    rt = new Runtime(game, { build, startAt: opts.startAt, onSave });
    lastSnap = null; // fresh run — no checkpoint yet
    rendered = 0;
    savedCleared = false;
    logEl.innerHTML = "";
    side.hidden = false;
    render();
  }

  function renderLogEntry(entry: LogEntry): HTMLElement {
    switch (entry.kind) {
      case "narration": {
        return el("p", "narration", entry.text);
      }
      case "dialogue": {
        const p = el("p", entry.isSkill ? "dialogue skill-voice" : "dialogue");
        const name = el("span", "speaker", entry.name.toUpperCase());
        name.style.color = entry.color;
        p.append(name, el("span", "sep", " — "), el("span", "", entry.text));
        return p;
      }
      case "passive": {
        const p = el("p", "dialogue skill-voice passive");
        const name = el("span", "speaker", entry.name.toUpperCase());
        name.style.color = entry.color;
        p.append(
          name,
          el("span", "check-tag", ` [Passive] `),
          el("span", "sep", "— "),
          el("span", "", entry.text),
        );
        return p;
      }
      case "roll": {
        const r = entry.roll;
        const p = el("p", `roll ${r.success ? "roll-success" : "roll-fail"}`);
        const name = el("span", "speaker", r.skillName.toUpperCase());
        name.style.color = r.color;
        const parts: string[] = [` [${r.type === "red" ? "Red" : "White"}: ${r.difficultyLabel} ${r.difficulty}]  `];
        parts.push(`2d6 → ${r.d1}+${r.d2}`);
        parts.push(` +${r.skillValue} ${r.skillName}`);
        for (const m of r.mods) parts.push(` ${m.value >= 0 ? "+" : ""}${m.value} ${m.name}`);
        parts.push(` = ${r.total}`);
        p.append(name, el("span", "", parts.join("")));
        const verdict = el(
          "span",
          "verdict",
          r.crit === "success" ? "  ✓ CRITICAL SUCCESS" :
          r.crit === "fail" ? "  ✗ CRITICAL FAILURE" :
          r.success ? "  ✓ SUCCESS" : "  ✗ FAILURE",
        );
        p.append(verdict);
        return p;
      }
      case "system":
        return el("p", "system", `· ${entry.text} ·`);
      case "fail": {
        const p = el("p", "the-end fail-banner");
        p.append(el("span", "", "■  FAILURE"));
        if (entry.text) p.append(el("span", "fail-text", `  ${entry.text}`));
        return p;
      }
      case "end": {
        const p = el("p", "the-end");
        p.append(el("span", "", "■  FIN"));
        return p;
      }
    }
  }

  // Mid-game skill points: replaces the choice list until they're spent.
  function renderAllocator(): void {
    const points = rt!.pendingPoints;
    const skills = Object.values(game.skills);
    const alloc: Record<string, number> = {};
    for (const s of skills) alloc[s.id] = 0;
    const box = el("div", "build levelup");
    box.append(el("h2", "", `+${points} SKILL POINT${points === 1 ? "" : "S"}`));
    const rows = el("div", "build-rows");
    const confirm = el("button", "btn primary begin-btn", "CONFIRM") as HTMLButtonElement;
    box.append(rows, confirm);
    const remaining = () => points - Object.values(alloc).reduce((a, b) => a + b, 0);
    function redraw(): void {
      rows.innerHTML = "";
      for (const s of skills) {
        const row = el("div", "build-row");
        const name = el("span", "build-name", s.name.toUpperCase());
        name.style.color = s.color;
        const minus = el("button", "build-btn", "−") as HTMLButtonElement;
        const value = el("span", "build-value", String(rt!.skillBase(s.id) + alloc[s.id]));
        const plus = el("button", "build-btn", "+") as HTMLButtonElement;
        minus.disabled = alloc[s.id] <= 0;
        plus.disabled = remaining() <= 0;
        minus.onclick = () => { alloc[s.id]--; redraw(); };
        plus.onclick = () => { alloc[s.id]++; redraw(); };
        row.append(name, minus, value, plus);
        rows.append(row);
      }
      const r = remaining();
      confirm.disabled = r > 0;
      confirm.textContent = r > 0 ? `CONFIRM (${r} left to spend)` : "CONFIRM";
    }
    confirm.onclick = () => {
      if (rt!.allocatePoints(alloc)) render();
    };
    redraw();
    choicesEl.append(box);
  }

  function renderChoices(): void {
    if (!rt) return;
    choicesEl.innerHTML = "";
    if (rt.failed) {
      const snap = lastSnap;
      const btn = el(
        "button",
        "choice restart-btn",
        snap ? "⟲  RETURN TO LAST SAVE" : "↺  START OVER",
      ) as HTMLButtonElement;
      btn.onclick = () => (snap ? restoreFrom(snap) : restart());
      choicesEl.append(btn);
      return;
    }
    if (rt.ended) {
      const btn = el("button", "choice restart-btn", "↺  PLAY AGAIN") as HTMLButtonElement;
      btn.onclick = () => restart();
      choicesEl.append(btn);
      return;
    }
    if (rt.pendingPoints > 0) {
      renderAllocator();
      return;
    }
    const choices = rt.getChoices();
    choices.forEach((c: VisibleChoice, i: number) => {
      const btn = el("button", "choice") as HTMLButtonElement;
      btn.append(el("span", "choice-num", `${i + 1}.`));
      let locked = false;
      if (c.cost) {
        const sign = c.cost.kind === "pay" ? "−" : "+";
        btn.append(el("span", "check-tag currency-tag", `[${sign}${c.cost.amount} ${c.cost.name.toUpperCase()}] `));
        locked = locked || c.cost.locked;
      }
      if (c.check) {
        const suffix = c.check.locked ? "· failed" : `· ${Math.round(c.check.chance * 100)}%`;
        const tag = el(
          "span",
          `check-tag ${c.check.type === "red" ? "check-red" : "check-white"}`,
          `[${c.check.skillName.toUpperCase()} — ${c.check.difficultyLabel} ${c.check.difficulty} ${suffix}] `,
        );
        tag.style.color = c.check.color;
        btn.append(tag);
        if (c.check.type === "red") btn.classList.add("choice-red");
        locked = locked || c.check.locked;
      }
      btn.append(el("span", "", `${c.cost || c.check ? "" : " "}${c.text}`));
      if (locked) {
        btn.disabled = true;
        btn.classList.add("choice-locked");
      } else if (c.check?.failedBefore) {
        btn.append(el("span", "retry-tag", "  (retry)"));
      }
      btn.onclick = () => {
        rt!.choose(c.id);
        render();
      };
      choicesEl.append(btn);
    });
  }

  function renderSheet(): void {
    if (!rt) return;
    side.innerHTML = "";
    if (game.stats.length || game.currency) {
      side.append(el("h3", "", "STATUS"));
      const dl = el("div", "stat-list");
      for (const s of game.stats) {
        const row = el("div", "stat-row");
        row.append(el("span", "stat-name", s.toUpperCase()), el("span", "stat-val", String(rt.statValue(s))));
        dl.append(row);
      }
      // money reads as an afterthought, not a vital sign — it goes last
      if (game.currency) {
        const row = el("div", "stat-row");
        const name = el("span", "stat-name currency-name", game.currency.name.toUpperCase());
        row.append(name, el("span", "stat-val", String(rt.statValue(game.currency.id))));
        dl.append(row);
      }
      side.append(dl);
    }
    const skills = Object.values(game.skills);
    if (skills.length) {
      side.append(el("h3", "", "SKILLS"));
      const dl = el("div", "stat-list");
      for (const s of skills) {
        const row = el("div", "stat-row");
        const name = el("span", "stat-name", s.name.toUpperCase());
        name.style.color = s.color;
        const eff = rt.effectiveSkill(s.id);
        const base = rt.skillBase(s.id);
        const val = el("span", "stat-val", eff !== base ? `${base}${eff > base ? "+" : ""}${eff - base} = ${eff}` : String(eff));
        row.append(name, val);
        dl.append(row);
      }
      side.append(dl);
    }
    const inv = rt.getInventory();
    if (inv.length) {
      const unlocked = rt.wardrobeOpen;
      side.append(el("h3", "", "INVENTORY"));
      const dl = el("div", "stat-list");
      for (const it of inv) {
        if (!it.equippable) {
          const row = el("div", "stat-row plain-item");
          row.append(el("span", "stat-name", it.name));
          dl.append(row);
          continue;
        }
        const row = el("button", "stat-row item-row") as HTMLButtonElement;
        const modsTxt = Object.entries(it.mods)
          .map(([k, v]) => `${v > 0 ? "+" : ""}${v} ${game.skills[k]?.name ?? k}`)
          .join(", ");
        row.disabled = !unlocked;
        if (unlocked) row.title = `${modsTxt} — click to ${it.equipped ? "unequip" : "equip"}`;
        row.append(
          el("span", "stat-name", `${it.equipped ? "■" : "□"} ${it.name}`),
          el("span", "stat-val item-mods", modsTxt),
        );
        row.onclick = () => {
          rt!.toggleEquip(it.id);
          render();
        };
        dl.append(row);
      }
      side.append(dl);
    }
  }

  function finishRender(): void {
    renderChoices();
    renderSheet();
    sheetToggle.hidden = side.hidden;
    main.scrollTop = main.scrollHeight;
  }

  function cancelReveal(): void {
    if (revealTimer !== null) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    revealQueue.length = 0;
    revealing = false;
  }

  function flushReveal(): void {
    if (!revealing) return;
    if (revealTimer !== null) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    while (revealQueue.length) logEl.append(renderLogEntry(revealQueue.shift()!));
    revealing = false;
    finishRender();
  }

  function revealStep(): void {
    const entry = revealQueue.shift();
    if (entry) {
      const p = renderLogEntry(entry);
      p.classList.add("reveal");
      logEl.append(p);
      main.scrollTop = main.scrollHeight;
    }
    if (revealQueue.length) {
      // chrome lines (item pickups etc.) tick by faster than prose
      const delay = revealQueue[0].kind === "system" ? 450 : 1000;
      revealTimer = window.setTimeout(revealStep, delay);
    } else {
      revealTimer = null;
      revealing = false;
      finishRender();
    }
  }

  function render(): void {
    if (!rt) return;
    if (rt.ended && !savedCleared) {
      opts.save?.clear(); // finished games start fresh next visit
      savedCleared = true;
    }
    const fresh = rt.log.slice(rendered);
    rendered = rt.log.length;
    if (!opts.reveal || instantNext || (fresh.length <= 1 && !revealing)) {
      instantNext = false;
      for (const e of fresh) logEl.append(renderLogEntry(e));
      if (!revealing) finishRender();
      return;
    }
    revealQueue.push(...fresh);
    choicesEl.innerHTML = ""; // choices appear once the prose has arrived
    if (!revealing) {
      revealing = true;
      revealStep();
    }
  }

  function restart(): void {
    beginFresh();
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLInputElement) return;
    const n = parseInt(ev.key, 10);
    if (!Number.isNaN(n) && n >= 1) {
      const btns = choicesEl.querySelectorAll<HTMLButtonElement>("button.choice:not(.restart-btn)");
      btns[n - 1]?.click();
    }
  }
  document.addEventListener("keydown", onKey);
  // tap/click anywhere in the prose to skip the staggered reveal
  // (ignore the button click that started it, bubbling up)
  main.addEventListener("click", (ev) => {
    if (!revealing) return;
    if ((ev.target as HTMLElement).closest("button, a")) return;
    flushReveal();
  });

  const existingSave = opts.save?.load() ?? null;
  if (existingSave) {
    showContinue(existingSave);
  } else if (!game.points) {
    startGame();
  } else if (opts.autoBuild && lastBuild && lastBuild.sig === buildSig(game)) {
    const pool = game.points.pool;
    let left = pool;
    const build: Record<string, number> = {};
    for (const s of Object.values(game.skills)) {
      const give = Math.min(Math.max(0, lastBuild.alloc[s.id] ?? 0), left);
      build[s.id] = s.base + give;
      left -= give;
    }
    startGame(build);
  } else {
    showBuild();
  }

  return {
    restart,
    destroy() {
      cancelReveal();
      document.removeEventListener("keydown", onKey);
      container.innerHTML = "";
    },
  };
}
