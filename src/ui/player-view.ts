// DOM renderer for a running game: build screen, dialogue log, choice list,
// character sheet. Used by both the editor's live preview and the public
// /play page.

import type { GameDef } from "../dsl/types";
import { Runtime, type LogEntry, type VisibleChoice, type SaveData } from "../engine/runtime";
import { applyTheme } from "./theme";
import { applyReader, loadReader } from "./reader-settings";

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

// Apply an author-chosen color (skill/character name, check tag). E-ink mode
// overrides these to its two tones via !important CSS.
function setInk(elm: HTMLElement, color: string): void {
  elm.style.color = color;
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
  applyReader(container, loadReader()); // reader prefs sit on top of author theme

  const main = el("div", "player-main");
  const logEl = el("div", "log");
  logEl.setAttribute("aria-live", "polite"); // announce new lines to screen readers
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
  // Pacing: the author's @reveal setting, honored only where opts.reveal is on
  // (play pages); the editor preview always renders instantly.
  const revealMode: "click" | "paced" | "off" = opts.reveal ? game.reveal : "off";
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
    // Build-screen skill range: a hard floor of 1, and a ceiling of the
    // author's max if set, otherwise 9.
    const FLOOR = 1;
    const ceiling = points.max ?? 9;
    const minAlloc = (s: typeof skills[number]) => FLOOR - s.base;
    const maxAlloc = (s: typeof skills[number]) => ceiling - s.base;
    if (lastBuild && lastBuild.sig === sig) {
      // Restore the previous allocation, clamped to each skill's valid range.
      for (const s of skills) {
        alloc[s.id] = Math.max(minAlloc(s), Math.min(lastBuild.alloc[s.id] ?? 0, maxAlloc(s)));
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
        `Distribute ${points.pool} point${points.pool === 1 ? "" : "s"} among your skills (max ${ceiling} each).`,
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
        const v = s.base + alloc[s.id];
        const row = el("div", "build-row");
        const label = el("div", "build-label");
        const name = el("span", "build-name", s.name.toUpperCase());
        setInk(name, s.color);
        label.append(name);
        if (s.desc) label.append(el("span", "build-desc", s.desc));
        const controls = el("div", "build-controls");
        const minus = el("button", "build-btn", "−") as HTMLButtonElement;
        const value = el("span", "build-value", String(v));
        const plus = el("button", "build-btn", "+") as HTMLButtonElement;
        minus.disabled = v <= FLOOR;
        plus.disabled = remaining() <= 0 || v >= ceiling;
        minus.onclick = () => { if (v > FLOOR) { alloc[s.id]--; redraw(); } };
        plus.onclick = () => { if (remaining() > 0 && v < ceiling) { alloc[s.id]++; redraw(); } };
        controls.append(minus, value, plus);
        row.append(label, controls);
        rows.append(row);
      }
      const r = remaining();
      poolEl.textContent =
        r > 0 ? `${r} point${r === 1 ? "" : "s"} remaining` : r < 0 ? `${-r} over budget` : "all points spent";
      poolEl.classList.toggle("pool-left", r > 0);
      poolEl.classList.toggle("pool-over", r < 0);
      begin.disabled = r < 0;
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
        // "» ..." lines are the player's own pick echoed back — keep those dim
        return el("p", entry.text.startsWith("» ") ? "narration echo" : "narration", entry.text);
      }
      case "dialogue": {
        const p = el("p", entry.isSkill ? "dialogue skill-voice" : "dialogue");
        const name = el("span", "speaker", entry.name.toUpperCase());
        setInk(name, entry.color);
        p.append(name, el("span", "sep", " — "), el("span", "", entry.text));
        return p;
      }
      case "passive": {
        const p = el("p", "dialogue skill-voice passive");
        const name = el("span", "speaker", entry.name.toUpperCase());
        setInk(name, entry.color);
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
        setInk(name, r.color);
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
    const ceiling = game.points?.max ?? 9; // same per-skill ceiling as the build screen
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
        const v = rt!.skillBase(s.id) + alloc[s.id];
        const row = el("div", "build-row");
        const label = el("div", "build-label");
        const name = el("span", "build-name", s.name.toUpperCase());
        setInk(name, s.color);
        label.append(name);
        const controls = el("div", "build-controls");
        const minus = el("button", "build-btn", "−") as HTMLButtonElement;
        const value = el("span", "build-value", String(v));
        const plus = el("button", "build-btn", "+") as HTMLButtonElement;
        minus.disabled = alloc[s.id] <= 0;
        plus.disabled = remaining() <= 0 || v >= ceiling;
        minus.onclick = () => { if (alloc[s.id] > 0) { alloc[s.id]--; redraw(); } };
        plus.onclick = () => { if (remaining() > 0 && v < ceiling) { alloc[s.id]++; redraw(); } };
        controls.append(minus, value, plus);
        row.append(label, controls);
        rows.append(row);
      }
      const r = remaining();
      // If every skill is already at the ceiling there's nowhere to put the
      // points — let the player confirm anyway rather than soft-lock.
      const canSpend = skills.some((s) => rt!.skillBase(s.id) + alloc[s.id] < ceiling);
      confirm.disabled = r > 0 && canSpend;
      confirm.textContent = r > 0 && canSpend ? `CONFIRM (${r} left to spend)` : "CONFIRM";
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
        btn.append(el("span", "check-tag currency-tag", `[${sign}${c.cost.amount.toFixed(2)} ${c.cost.name.toUpperCase()}]`));
        locked = locked || c.cost.locked;
      }
      if (c.check) {
        const suffix = c.check.locked ? "· failed" : `· ${Math.round(c.check.chance * 100)}%`;
        const tag = el(
          "span",
          `check-tag ${c.check.type === "red" ? "check-red" : "check-white"}`,
          `[${c.check.skillName.toUpperCase()} — ${c.check.difficultyLabel} ${c.check.difficulty} ${suffix}]`,
        );
        setInk(tag, c.check.color);
        btn.append(tag);
        if (c.check.type === "red") btn.classList.add("choice-red");
        locked = locked || c.check.locked;
      }
      btn.append(el("span", "choice-text", c.text));
      if (c.used) btn.classList.add("choice-used"); // been here before — runs red
      if (c.locked) {
        // a spent [once]: visible, red, dead
        btn.disabled = true;
        btn.classList.add("choice-spent");
      } else if (locked) {
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
    if (game.stats.length) {
      side.append(el("h3", "", "STATUS"));
      const dl = el("div", "stat-list");
      for (const s of game.stats) {
        if (s.max && s.max > 0) {
          // A capped stat reads as a gauge — filled pips for the value, empty to the
          // cap — stacked under its label so a wide gauge never fights the sidebar.
          const val = Math.max(0, Math.min(Number(rt.statValue(s.name)) || 0, s.max));
          const gauge = el("div", "stat-gauge");
          gauge.title = `${rt.statValue(s.name)} / ${s.max}`;
          gauge.append(el("div", "stat-name", s.name.toUpperCase()));
          const pips = el("div", "stat-pips");
          for (let i = 0; i < s.max; i++) pips.append(el("span", i < val ? "pip on" : "pip off", i < val ? "◆" : "◇"));
          gauge.append(pips);
          dl.append(gauge);
        } else {
          const row = el("div", "stat-row");
          row.append(el("span", "stat-name", s.name.toUpperCase()), el("span", "stat-val", String(rt.statValue(s.name))));
          dl.append(row);
        }
      }
      side.append(dl);
    }
    const skills = Object.values(game.skills);
    if (skills.length) {
      side.append(el("h3", "", "SKILLS"));
      const dl = el("div", "stat-list");
      for (const s of skills) {
        const row = el("div", "stat-row");
        if (s.desc) row.title = s.desc;
        const name = el("span", "stat-name", s.name.toUpperCase());
        setInk(name, s.color);
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

      const itemRow = (it: (typeof inv)[number]) => {
        const row = el("button", "stat-row item-row") as HTMLButtonElement;
        const modsTxt = Object.entries(it.mods)
          .map(([k, v]) => `${v > 0 ? "+" : ""}${v} ${game.skills[k]?.name ?? k}`)
          .join(", ");
        row.disabled = !unlocked;
        if (unlocked) row.title = `${modsTxt} — click to ${it.equipped ? "unequip" : "equip"}`;
        row.append(
          el("span", "stat-name", `${it.equipped ? "■" : "□"} ${it.name}${it.count > 1 ? ` ×${it.count}` : ""}`),
          el("span", "stat-val item-mods", modsTxt),
        );
        row.onclick = () => {
          rt!.toggleEquip(it.id);
          render();
        };
        return row;
      };

      // EQUIPMENT: slotted items grouped by slot (each headed by a worn/limit
      // tally so a full slot is legible), then any slotless equippable items.
      const equippable = inv.filter((it) => it.equippable);
      if (equippable.length) {
        side.append(el("h3", "", "EQUIPMENT"));
        const dl = el("div", "stat-list");
        const grouped = new Set<string>();
        for (const [slotId, def] of Object.entries(game.slots)) {
          const members = equippable.filter((it) => it.slot === slotId);
          if (!members.length) continue;
          const worn = members.filter((it) => it.equipped).length;
          const head = el("div", "slot-head");
          head.append(el("span", "slot-name", def.name), el("span", "slot-fill", `${worn}/${def.limit}`));
          dl.append(head);
          for (const it of members) { dl.append(itemRow(it)); grouped.add(it.id); }
        }
        for (const it of equippable) {
          if (!grouped.has(it.id)) dl.append(itemRow(it));
        }
        side.append(dl);
      }

      // ITEMS: things that aren't worn. Consumables (clickable, actionable) always
      // sit above key items (just carried); order within each group is preserved.
      const carried = inv
        .filter((it) => !it.equippable)
        .sort((a, b) => Number(!a.consumable) - Number(!b.consumable));
      if (carried.length) {
        side.append(el("h3", "", "ITEMS"));
        const dl = el("div", "stat-list");
        for (const it of carried) {
          const qty = it.count > 1 ? ` ×${it.count}` : "";
          if (it.consumable) {
            const fx = Object.entries(it.consumable)
              .map(([k, v]) => `${v > 0 ? "+" : ""}${v} ${k[0].toUpperCase()}${k.slice(1)}`)
              .join(", ");
            const row = el("button", "stat-row item-row") as HTMLButtonElement;
            row.title = `${fx} — click to use`;
            row.append(
              el("span", "stat-name", `${it.name}${qty}`),
              el("span", "stat-val item-mods", fx),
            );
            row.onclick = () => { rt!.useItem(it.id); render(); };
            dl.append(row);
          } else {
            const row = el("div", "stat-row plain-item");
            row.append(el("span", "stat-name", it.name));
            if (it.count > 1) row.append(el("span", "stat-val", qty.trim()));
            dl.append(row);
          }
        }
        side.append(dl);
      }
    }

    // Currency lives at the foot of the sidebar, apart from the vital stats up top.
    if (game.currency) {
      const dl = el("div", "stat-list currency-block");
      const row = el("div", "stat-row");
      row.append(
        el("span", "stat-name currency-name", game.currency.name.toUpperCase()),
        el("span", "stat-val", Number(rt.statValue(game.currency.id)).toFixed(2)),
      );
      dl.append(row);
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
    dimPast();
    revealing = false;
    finishRender();
  }

  // Read text recedes: it scales down (via CSS transform — no reflow, unlike
  // animating font-size) and a matching negative margin lets the line below
  // slide up to close the gap the scale leaves. PAST_SCALE must match the
  // scale() in `.log p.past`.
  const PAST_SCALE = 0.84;
  function markPast(elm: Element | null): void {
    if (!(elm instanceof HTMLElement) || elm.classList.contains("past")) return;
    const mb = parseFloat(getComputedStyle(elm).marginBottom) || 0;
    const lost = (1 - PAST_SCALE) * elm.offsetHeight;
    elm.classList.add("past");
    elm.style.marginBottom = `${mb - lost}px`;
  }

  // Everything above the newest line recedes — the bright edge is the cursor.
  function dimPast(): void {
    const kids = logEl.children;
    for (let i = 0; i < kids.length - 1; i++) markPast(kids[i]);
  }

  // Lines that don't need a deliberate tap to advance past: the echo of the
  // choice the reader just made, and bookkeeping notices (item acquired,
  // progress saved). These reveal themselves so only real prose waits.
  function isAuto(e: LogEntry): boolean {
    return e.kind === "system" || (e.kind === "narration" && e.text.startsWith("» "));
  }

  // How long an auto line lingers before the next reveals: bookkeeping notices
  // flick by; the echo of your choice gets a beat to register.
  function autoDelay(e: LogEntry): number {
    return e.kind === "system" ? 250 : 750;
  }

  function revealNode(entry: LogEntry): void {
    markPast(logEl.lastElementChild);
    const p = renderLogEntry(entry);
    p.classList.add("reveal");
    logEl.append(p);
    main.scrollTop = main.scrollHeight;
  }

  function showContinueHint(): void {
    choicesEl.innerHTML = "";
    choicesEl.append(el("p", "continue-hint", "▼"));
  }

  function clearRevealTimer(): void {
    if (revealTimer !== null) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
  }

  // Reveal the next queued line, then decide what happens after it.
  function stepNext(): void {
    const e = revealQueue.shift();
    if (!e) {
      revealing = false;
      finishRender();
      return;
    }
    revealNode(e);
    afterReveal(e);
  }

  // Auto lines (the choice echo, item/save notices) appear normally and then
  // advance on their own — no jarring instant flash, no wasted tap. Real prose
  // waits for a tap (in paced mode it too is timed).
  function afterReveal(prev: LogEntry): void {
    if (!revealQueue.length) {
      revealing = false;
      clearRevealTimer();
      finishRender();
      return;
    }
    revealing = true;
    if (isAuto(prev)) {
      revealTimer = window.setTimeout(stepNext, autoDelay(prev));
    } else if (revealMode === "paced") {
      revealTimer = window.setTimeout(stepNext, 1500); // paced: prose on a timer too
    } else {
      showContinueHint(); // click: prose waits for a tap
    }
  }

  // A tap reveals the next line immediately, then resumes the cascade.
  function clickAdvance(): void {
    clearRevealTimer();
    stepNext();
  }

  function render(): void {
    if (!rt) return;
    if (rt.ended && !savedCleared) {
      opts.save?.clear(); // finished games start fresh next visit
      savedCleared = true;
    }
    const fresh = rt.log.slice(rendered);
    rendered = rt.log.length;
    if (fresh.length === 0) {
      // a re-render with no new log (e.g. equipping mid-scene): refresh the
      // panels without disturbing an in-progress reveal
      renderSheet();
      if (!revealing) renderChoices();
      return;
    }
    if (revealMode === "off" || instantNext) {
      instantNext = false;
      for (const e of fresh) logEl.append(renderLogEntry(e));
      dimPast();
      if (!revealing) finishRender();
      return;
    }
    revealQueue.push(...fresh);
    choicesEl.innerHTML = ""; // choices appear once the prose has arrived
    if (!revealing) stepNext();
  }

  function restart(): void {
    beginFresh();
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLInputElement) return;
    if (revealing && (ev.key === " " || ev.key === "Enter")) {
      ev.preventDefault();
      if (revealMode === "click") clickAdvance();
      else flushReveal();
      return;
    }
    const n = parseInt(ev.key, 10);
    if (!Number.isNaN(n) && n >= 1) {
      const btns = choicesEl.querySelectorAll<HTMLButtonElement>("button.choice:not(.restart-btn)");
      btns[n - 1]?.click();
    }
  }
  document.addEventListener("keydown", onKey);
  // Tap/click in the prose: in click mode it reveals the next line (DE-style);
  // in paced mode it skips the rest of the stagger.
  // (Ignore the button click that started the reveal, bubbling up.)
  main.addEventListener("click", (ev) => {
    if (!revealing) return;
    if ((ev.target as HTMLElement).closest("button, a")) return;
    if (revealMode === "click") clickAdvance();
    else flushReveal();
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
