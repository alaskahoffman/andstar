// Standalone player: the whole engine in one script, for itch.io exports.
// The exporter embeds the game as window.__GAME__ and this file does the rest —
// no server, no network, CSS inlined.

import css from "../styles.css?inline";
import { parseGame } from "../dsl/parser";
import { mountPlayer, type SaveStore } from "../ui/player-view";
import { applyTheme } from "../ui/theme";
import { mountReaderMenu } from "../ui/reader-settings";
import type { SaveData } from "../engine/runtime";

declare global {
  interface Window {
    __GAME__?: { source: string };
  }
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Save key derives from the source text, so re-uploading a changed build
// automatically invalidates old checkpoints.
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function boot(): void {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);

  const page = el("div", "play-page");
  const header = el("header", "play-header");
  const h1 = el("h1", "", "…");
  const byline = el("span", "byline");
  const madeWith = el("span", "byline", " · made with &*");
  const restartWrap = el("span", "byline");
  restartWrap.append(" · ");
  const restartLink = el("a", "", "restart") as HTMLAnchorElement;
  restartLink.href = "#";
  restartWrap.append(restartLink);
  header.append(h1, byline, madeWith, restartWrap);
  const playerEl = el("div", "player");
  page.append(header, playerEl);
  document.body.append(page);

  const source = window.__GAME__?.source;
  if (!source) {
    playerEl.append(el("p", "center-msg", "no game embedded in this build"));
    return;
  }
  const { game, errors } = parseGame(source);
  if (!game || errors.length) {
    playerEl.append(el("p", "center-msg", "this game has script errors and cannot be played"));
    return;
  }

  document.title = game.title;
  applyTheme(document.documentElement, game.theme);
  h1.textContent = game.title.toUpperCase();
  byline.textContent = game.author ? `by ${game.author}` : "";

  const saveKey = `andstar.itch.${hash(source)}`;
  const save: SaveStore = {
    load() {
      try {
        return JSON.parse(localStorage.getItem(saveKey) ?? "null") as SaveData | null;
      } catch {
        return null;
      }
    },
    store(snap) {
      try {
        localStorage.setItem(saveKey, JSON.stringify(snap));
      } catch { /* storage blocked (some embeds) — play on without saves */ }
    },
    clear() {
      try {
        localStorage.removeItem(saveKey);
      } catch { /* ignore */ }
    },
  };

  const handle = mountPlayer(playerEl, game, { save, reveal: true });
  mountReaderMenu(header, () => [document.documentElement, playerEl]);
  restartLink.onclick = (ev) => {
    ev.preventDefault();
    if (confirm("Restart from the beginning? Your checkpoint will be erased.")) {
      save.clear();
      handle.restart();
    }
  };
}

boot();
