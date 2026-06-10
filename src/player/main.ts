import "../styles.css";
import { parseGame } from "../dsl/parser";
import { mountPlayer, type SaveStore } from "../ui/player-view";
import { applyTheme } from "../ui/theme";
import type { SaveData } from "../engine/runtime";

const playerEl = document.getElementById("player")!;
const statusEl = document.getElementById("status-msg")!;
const titleEl = document.getElementById("game-title")!;
const bylineEl = document.getElementById("game-byline")!;

function gameId(): string | null {
  const m = location.pathname.match(/\/play\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return new URLSearchParams(location.search).get("id");
}

async function boot(): Promise<void> {
  const id = gameId();
  if (!id) {
    statusEl.textContent = "no game id in the URL";
    return;
  }
  let data: { source: string; updated_at: string };
  if (id === "demo") {
    // The built-in demo ships with the bundle — no server row needed.
    const { SAMPLE_GAME } = await import("../sample-game");
    data = { source: SAMPLE_GAME, updated_at: "demo" };
  } else {
    try {
      const res = await fetch(`/api/games/${id}`);
      if (res.status === 404) {
        statusEl.textContent = "this game does not exist (or was unpublished)";
        return;
      }
      if (!res.ok) throw new Error(`server said ${res.status}`);
      data = await res.json();
    } catch (e) {
      statusEl.textContent = `could not load the game: ${(e as Error).message}`;
      return;
    }
  }
  const { game, errors } = parseGame(data.source);
  if (!game || errors.length) {
    statusEl.textContent = "this game has script errors and cannot be played";
    return;
  }
  document.title = `${game.title} — andstar`;
  applyTheme(document.documentElement, game.theme);
  titleEl.textContent = game.title.toUpperCase();
  bylineEl.textContent = game.author ? `by ${game.author}` : "";
  statusEl.remove();

  // ~ save checkpoints persist per game id; a republished game invalidates them.
  const saveKey = `andstar.save.${id}`;
  const save: SaveStore = {
    load() {
      try {
        const wrapped = JSON.parse(localStorage.getItem(saveKey) ?? "null");
        if (!wrapped || wrapped.updatedAt !== data.updated_at) return null;
        return wrapped.snap as SaveData;
      } catch {
        return null;
      }
    },
    store(snap) {
      try {
        localStorage.setItem(saveKey, JSON.stringify({ updatedAt: data.updated_at, snap }));
      } catch { /* storage full/blocked — play on without saves */ }
    },
    clear() {
      localStorage.removeItem(saveKey);
    },
  };

  const handle = mountPlayer(playerEl as HTMLElement, game, { save, reveal: true });

  const restartWrap = document.getElementById("restart-wrap")!;
  restartWrap.hidden = false;
  document.getElementById("restart-link")!.onclick = (ev) => {
    ev.preventDefault();
    if (confirm("Restart from the beginning? Your checkpoint will be erased.")) {
      save.clear();
      handle.restart();
    }
  };
}

boot();
