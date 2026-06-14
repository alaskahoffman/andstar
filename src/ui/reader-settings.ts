// Reader accessibility settings — distinct from author theming. These are the
// reader's own needs (bigger text, an e-ink-style two-color view), saved
// per-device for every game, and layered ON TOP of whatever the author chose.
// E-ink wins over author theme because the CSS uses !important custom
// properties, which beat the inline vars applyTheme() sets.

export interface ReaderSettings {
  size: 0 | 1 | 2 | 3; // text-scale level
  eink: boolean;       // force a light two-color view, override author colors
}

const KEY = "andstar.reader";
const DEFAULT: ReaderSettings = { size: 0, eink: false };
const SIZE_LABELS = ["100%", "115%", "130%", "150%"];

export function loadReader(): ReaderSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!s || typeof s !== "object") return { ...DEFAULT };
    return {
      size: [0, 1, 2, 3].includes(s.size) ? s.size : 0,
      eink: !!s.eink,
    };
  } catch {
    return { ...DEFAULT };
  }
}

function saveReader(s: ReaderSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* storage blocked — settings just won't persist */ }
}

/** Toggle the reader classes on one element (the same root author theme uses). */
export function applyReader(el: HTMLElement, s: ReaderSettings): void {
  el.classList.toggle("rsize-1", s.size === 1);
  el.classList.toggle("rsize-2", s.size === 2);
  el.classList.toggle("rsize-3", s.size === 3);
  el.classList.toggle("reink", s.eink);
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Add a gear button + settings panel to a header. `getRoots` returns the
 * elements the settings should be applied to (the page root, the player
 * container, etc.) — a function so callers can hand back a freshly mounted
 * container each time.
 */
export function mountReaderMenu(
  host: HTMLElement,
  getRoots: () => HTMLElement[],
  variant: "btn" | "byline" = "byline",
): void {
  let settings = loadReader();
  const apply = () => getRoots().forEach((r) => applyReader(r, settings));
  apply();

  const wrap = el("span", variant === "byline" ? "reader-wrap byline" : "reader-wrap");
  if (variant === "byline") wrap.append("· ");
  const gear = el("button", variant === "btn" ? "reader-gear btn" : "reader-gear") as HTMLButtonElement;
  gear.type = "button";
  // match the casing of the neighbouring controls: byline links are lowercase,
  // the editor's pane-head buttons are uppercase.
  gear.textContent = variant === "btn" ? "SETTINGS" : "settings";
  gear.title = "reading settings";
  gear.setAttribute("aria-label", "reading settings");

  const menu = el("div", "reader-menu");
  menu.hidden = true;

  menu.append(el("h4", "", "READING"));

  // text size stepper
  const sizeRow = el("div", "rm-row");
  sizeRow.append(el("span", "", "Text size"));
  const stepper = el("span", "rm-stepper");
  const minus = el("button", "", "−") as HTMLButtonElement;
  const sizeVal = el("span", "rm-val");
  const plus = el("button", "", "+") as HTMLButtonElement;
  stepper.append(minus, sizeVal, plus);
  sizeRow.append(stepper);
  menu.append(sizeRow);

  // toggle
  const einkBtn = el("button", "rm-toggle") as HTMLButtonElement;
  einkBtn.append(el("span", "rm-box"), el("span", "", "E-ink mode"));
  menu.append(einkBtn);
  menu.append(el("p", "rm-note", "saved on this device, for every game"));

  function refresh(): void {
    sizeVal.textContent = SIZE_LABELS[settings.size];
    minus.disabled = settings.size === 0;
    plus.disabled = settings.size === 3;
    einkBtn.setAttribute("aria-pressed", String(settings.eink));
  }

  function commit(): void {
    saveReader(settings);
    apply();
    refresh();
  }

  minus.onclick = () => { if (settings.size > 0) { settings = { ...settings, size: (settings.size - 1) as 0 }; commit(); } };
  plus.onclick = () => { if (settings.size < 3) { settings = { ...settings, size: (settings.size + 1) as 1 }; commit(); } };
  einkBtn.onclick = () => { settings = { ...settings, eink: !settings.eink }; commit(); };

  function place(): void {
    const r = gear.getBoundingClientRect();
    const w = menu.offsetWidth || 232;
    // Anchor the menu's right edge under the gear, but never let it run off
    // either side of the viewport (matters on narrow phones).
    let right = window.innerWidth - r.right;
    right = Math.min(right, window.innerWidth - w - 8);
    right = Math.max(right, 8);
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.right = `${Math.round(right)}px`;
  }
  function open(): void {
    menu.hidden = false; // unhide first so offsetWidth is measurable
    place();
    gear.setAttribute("aria-expanded", "true");
  }
  function close(): void {
    menu.hidden = true;
    gear.setAttribute("aria-expanded", "false");
  }
  gear.onclick = (ev) => {
    ev.stopPropagation();
    if (menu.hidden) open(); else close();
  };
  document.addEventListener("click", (ev) => {
    if (!menu.hidden && !menu.contains(ev.target as Node) && ev.target !== gear) close();
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });
  window.addEventListener("resize", () => { if (!menu.hidden) place(); });

  refresh();
  wrap.append(gear);
  host.append(wrap);
  document.body.append(menu); // body-level so header overflow can't clip it
}
