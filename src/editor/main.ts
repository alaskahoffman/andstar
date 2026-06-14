import "../styles.css";
import { buildItchZip, readZipEntry } from "./itch-export";
import { parseGame } from "../dsl/parser";
import { mountPlayer, type PlayerHandle } from "../ui/player-view";
import { mountReaderMenu } from "../ui/reader-settings";
import { SAMPLE_GAME } from "../sample-game";
import type { GameDef } from "../dsl/types";

const SOURCE_KEY = "andstar.source";
const PUBLISH_KEY = "andstar.publish";

// One-time migration from the VOICEBOX-era keys.
if (!localStorage.getItem(SOURCE_KEY) && localStorage.getItem("voicebox.source")) {
  localStorage.setItem(SOURCE_KEY, localStorage.getItem("voicebox.source")!);
  const oldPub = localStorage.getItem("voicebox.publish");
  if (oldPub) localStorage.setItem(PUBLISH_KEY, oldPub);
}

const sourceEl = document.getElementById("source") as HTMLTextAreaElement;
const errorsEl = document.getElementById("errors")!;
const previewEl = document.getElementById("preview")!;
const docTitleEl = document.getElementById("doc-title")!;
const saveStateEl = document.getElementById("save-state")!;
const shareBox = document.getElementById("share-box")!;
const shareUrl = document.getElementById("share-url") as HTMLInputElement;
const publishBtn = document.getElementById("publish-btn") as HTMLButtonElement;
const jumpSelect = document.getElementById("jump-select") as HTMLSelectElement;

const BLANK = `@title Untitled
@author anonymous

skill logic "Logic" #6cb9ff = 3

char someone "Someone" #f0c987

== start
someone: "Hello. Write your game here."
* Begin -> END
`;

let player: PlayerHandle | null = null;
let lastGood: GameDef | null = null;
let publish: { id: string; editKey: string } | null = null;

try {
  publish = JSON.parse(localStorage.getItem(PUBLISH_KEY) ?? "null");
} catch { /* ignore */ }

function compile(remountPreview: boolean): void {
  const { game, errors, warnings } = parseGame(sourceEl.value);
  errorsEl.innerHTML = "";
  for (const e of errors) {
    const div = document.createElement("div");
    div.className = "error-line";
    const b = document.createElement("b");
    b.textContent = e.line > 0 ? `L${e.line}` : "file";
    div.append(b, ` ${e.message}`);
    div.onclick = () => jumpToLine(e.line);
    errorsEl.append(div);
  }
  for (const w of warnings) {
    const div = document.createElement("div");
    div.className = "warn-line";
    const b = document.createElement("b");
    b.textContent = w.line > 0 ? `L${w.line}` : "file";
    div.append(b, ` ${w.message}`);
    div.onclick = () => jumpToLine(w.line);
    errorsEl.append(div);
  }
  if (game && errors.length === 0) {
    docTitleEl.textContent = `· ${game.title}${game.author ? ` — ${game.author}` : ""}`;
    lastGood = game;
    refreshJumpSelect(game);
    if (remountPreview) remount(game);
  }
  publishBtn.disabled = errors.length > 0;
}

// Playtest jump: start the preview from any passage.
function refreshJumpSelect(game: GameDef): void {
  const prev = jumpSelect.value;
  jumpSelect.innerHTML = "";
  for (const id of Object.keys(game.passages)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id === game.start ? `${id} (start)` : id;
    jumpSelect.append(opt);
  }
  jumpSelect.value = game.passages[prev] ? prev : game.start;
}

function remount(game: GameDef): void {
  player?.destroy();
  const startAt = game.passages[jumpSelect.value] ? jumpSelect.value : undefined;
  player = mountPlayer(previewEl as HTMLElement, game, { autoBuild: true, startAt });
}

function jumpToLine(line: number): void {
  if (line < 1) return;
  const lines = sourceEl.value.split("\n");
  let pos = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
  sourceEl.focus();
  sourceEl.setSelectionRange(pos, pos + (lines[line - 1]?.length ?? 0));
}

let saveTimer: number | undefined;
sourceEl.addEventListener("input", () => {
  saveStateEl.textContent = "…";
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    localStorage.setItem(SOURCE_KEY, sourceEl.value);
    saveStateEl.textContent = "saved";
    compile(true);
  }, 400);
});

// Tab inserts spaces instead of leaving the textarea.
sourceEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Tab") {
    ev.preventDefault();
    const { selectionStart: s, selectionEnd: e } = sourceEl;
    sourceEl.setRangeText("    ", s, e, "end");
  }
});

document.getElementById("restart-btn")!.onclick = () => {
  if (lastGood) remount(lastGood);
};
jumpSelect.onchange = () => {
  if (lastGood) remount(lastGood);
};

// ---- export (zip: playable build + source.txt) / import (.txt or that zip) ----

function slugName(): string {
  return (lastGood?.title ?? "game").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "game";
}

function download(blob: Blob, filename: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById("export-btn")!.onclick = async () => {
  if (!lastGood || publishBtn.disabled) {
    alert("Fix the script errors first — the export embeds the current script.");
    return;
  }
  let bundle: string | null = null;
  try {
    const res = await fetch("/standalone.js");
    if (res.ok) bundle = await res.text();
  } catch { /* fall through */ }
  if (bundle === null) {
    // No playable build available (dev server) — at least save the script.
    if (confirm("Couldn't load the playable build. Export the script as a plain .txt instead?")) {
      download(new Blob([sourceEl.value], { type: "text/plain;charset=utf-8" }), `${slugName()}.txt`);
    }
    return;
  }
  const zip = buildItchZip(lastGood.title, sourceEl.value, bundle);
  download(new Blob([zip as BlobPart], { type: "application/zip" }), `${slugName()}.zip`);
};

const importFile = document.getElementById("import-file") as HTMLInputElement;
document.getElementById("import-btn")!.onclick = () => importFile.click();
importFile.onchange = async () => {
  const file = importFile.files?.[0];
  importFile.value = "";
  if (!file) return;
  let text: string;
  if (/\.zip$/i.test(file.name)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const inner = readZipEntry(bytes, "source.txt");
    if (inner === null) {
      alert("Couldn't find source.txt in that zip — extract it and import the .txt directly.");
      return;
    }
    text = inner;
  } else {
    text = await file.text();
  }
  if (confirm(`Replace the current script with "${file.name}"? (This also detaches the published link.)`)) {
    loadDoc(text);
  }
};

function loadDoc(text: string): void {
  sourceEl.value = text;
  localStorage.setItem(SOURCE_KEY, text);
  setPublish(null);
  compile(true);
}

document.getElementById("new-btn")!.onclick = () => {
  if (confirm("Replace the current script with a blank one? (This also detaches the published link.)")) loadDoc(BLANK);
};
document.getElementById("sample-btn")!.onclick = () => {
  if (confirm("Replace the current script with the sample game? (This also detaches the published link.)")) loadDoc(SAMPLE_GAME);
};

function setPublish(p: { id: string; editKey: string } | null): void {
  publish = p;
  if (p) localStorage.setItem(PUBLISH_KEY, JSON.stringify(p));
  else localStorage.removeItem(PUBLISH_KEY);
  renderShare();
}

function renderShare(): void {
  if (publish) {
    shareBox.hidden = false;
    shareUrl.value = `${location.origin}/play/${publish.id}`;
    publishBtn.textContent = "UPDATE";
  } else {
    shareBox.hidden = true;
    publishBtn.textContent = "PUBLISH";
  }
}

document.getElementById("unpublish-btn")!.onclick = async () => {
  if (!publish) return;
  if (!confirm("Unpublish this game? The public link will stop working.")) return;
  try {
    const res = await fetch(`/api/games/${publish.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editKey: publish.editKey }),
    });
    if (!res.ok && res.status !== 404) {
      let msg = `server said ${res.status}`;
      try { msg = (await res.json()).error ?? msg; } catch { /* non-JSON */ }
      throw new Error(msg);
    }
    setPublish(null);
  } catch (e) {
    alert(`Unpublish failed: ${(e as Error).message}`);
  }
};

document.getElementById("copy-btn")!.onclick = async () => {
  await navigator.clipboard.writeText(shareUrl.value);
  const btn = document.getElementById("copy-btn")!;
  btn.textContent = "COPIED";
  setTimeout(() => (btn.textContent = "COPY"), 1200);
};

publishBtn.onclick = async () => {
  if (!lastGood) return;
  publishBtn.disabled = true;
  const body = {
    source: sourceEl.value,
    title: lastGood.title,
    author: lastGood.author,
    editKey: publish?.editKey,
  };
  try {
    const res = await fetch(publish ? `/api/games/${publish.id}` : "/api/games", {
      method: publish ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 403 || res.status === 404) {
      // Stale local publish record (e.g. server data reset) — publish fresh.
      setPublish(null);
      publishBtn.disabled = false;
      publishBtn.onclick!(new MouseEvent("click") as never);
      return;
    }
    if (!res.ok) {
      let msg = `server said ${res.status}`;
      try {
        msg = (await res.json()).error ?? msg;
      } catch { /* non-JSON error body */ }
      throw new Error(msg);
    }
    const data = await res.json();
    if (!publish) setPublish({ id: data.id, editKey: data.editKey });
    else renderShare();
    shareUrl.select();
  } catch (e) {
    alert(`Publish failed: ${(e as Error).message}\nIs the API server running? (npm run server)`);
  } finally {
    publishBtn.disabled = false;
  }
};

// Reading settings affect the preview surface, so the gear lives in its head
// (the .pane-head just above the errors strip and the preview).
mountReaderMenu(errorsEl.previousElementSibling as HTMLElement, () => [previewEl as HTMLElement], "btn");

// ---- boot ----
sourceEl.value = localStorage.getItem(SOURCE_KEY) ?? SAMPLE_GAME;
renderShare();
compile(true);
