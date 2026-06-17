// andstar server: serves the built frontend and a tiny publish API.
// Storage is the Node built-in SQLite (no native deps).

import express from "express";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "..", "dist");
// The engine version newly published games are stamped with. Drives version
// pinning: a published game always plays on the engine it was made under.
const ENGINE_VERSION = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8")).version;
// Point DATA_DIR at a persistent disk in production (e.g. /var/data on Render).
const dataDir = process.env.DATA_DIR || join(root, "..", "data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "games.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    author     TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL,
    edit_key   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version    TEXT NOT NULL DEFAULT '0.3.0'
  )
`);
// Migrate databases that predate pinning: add the column, defaulting existing
// rows to 0.3.0 (the last release before games carried a version).
try { db.exec("ALTER TABLE games ADD COLUMN version TEXT NOT NULL DEFAULT '0.3.0'"); } catch { /* column already present */ }

const insertGame = db.prepare(
  "INSERT INTO games (id, title, author, source, edit_key, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
);
const getGame = db.prepare("SELECT * FROM games WHERE id = ?");
// Republishing re-stamps to the current engine: you're editing on today's editor,
// so what you see there is what goes live.
const updateGame = db.prepare(
  "UPDATE games SET title = ?, author = ?, source = ?, updated_at = ?, version = ? WHERE id = ?",
);
const deleteGame = db.prepare("DELETE FROM games WHERE id = ?");

const MAX_SOURCE = 512 * 1024;

// Share-link ids avoid look-alike characters (0/O, 1/l/I) so links
// survive being read aloud or retyped.
const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
function newId(len = 10) {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

function validBody(body) {
  if (!body || typeof body !== "object") return "missing body";
  if (typeof body.source !== "string" || !body.source.trim()) return "source must be a non-empty string";
  if (body.source.length > MAX_SOURCE) return `source too large (max ${MAX_SOURCE} bytes)`;
  if (typeof body.title !== "string" || !body.title.trim()) return "title must be a non-empty string";
  return null;
}

// Per-IP sliding-window rate limiter (in-memory; fine for a single process).
const rateBuckets = new Map();
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const hits = (rateBuckets.get(key) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      return res.status(429).json({ error: "rate limit exceeded — try again later" });
    }
    hits.push(now);
    rateBuckets.set(key, hits);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateBuckets) {
    if (hits.every((t) => now - t > 3_600_000)) rateBuckets.delete(key);
  }
}, 3_600_000).unref();

const app = express();
// Behind a reverse proxy, set TRUST_PROXY=1 so req.ip is the real client.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);
app.use(express.json({ limit: "1mb" }));

app.post("/api/games", rateLimit("create", 20, 3_600_000), (req, res) => {
  const bad = validBody(req.body);
  if (bad) return res.status(400).json({ error: bad });
  const id = newId();
  const editKey = randomBytes(18).toString("base64url");
  const now = new Date().toISOString();
  insertGame.run(id, req.body.title.slice(0, 200), String(req.body.author ?? "").slice(0, 200), req.body.source, editKey, now, now, ENGINE_VERSION);
  res.status(201).json({ id, editKey });
});

app.put("/api/games/:id", rateLimit("update", 120, 3_600_000), (req, res) => {
  const bad = validBody(req.body);
  if (bad) return res.status(400).json({ error: bad });
  const row = getGame.get(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  if (typeof req.body.editKey !== "string" || req.body.editKey !== row.edit_key) {
    return res.status(403).json({ error: "wrong edit key" });
  }
  updateGame.run(req.body.title.slice(0, 200), String(req.body.author ?? "").slice(0, 200), req.body.source, new Date().toISOString(), ENGINE_VERSION, req.params.id);
  res.json({ id: req.params.id, ok: true });
});

// Unpublish: the author's edit key, or the ADMIN_TOKEN env var (abuse takedowns).
app.delete("/api/games/:id", (req, res) => {
  const row = getGame.get(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  const admin = process.env.ADMIN_TOKEN && req.get("x-admin-token") === process.env.ADMIN_TOKEN;
  if (!admin && (typeof req.body?.editKey !== "string" || req.body.editKey !== row.edit_key)) {
    return res.status(403).json({ error: "wrong edit key" });
  }
  deleteGame.run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/games/:id", (req, res) => {
  const row = getGame.get(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json({
    id: row.id,
    title: row.title,
    author: row.author,
    source: row.source,
    updated_at: row.updated_at,
    version: row.version,
  });
});

// Public play links: /play/:id is the SPA player page, with the game's title
// injected so shared links unfurl nicely. /create is the editor.
const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Scrapers want absolute og:image URLs; the host is only known per request.
const ogImage = (req) => `${req.protocol}://${req.get("host")}/og.png`;

app.get("/", (req, res) => {
  let html;
  try {
    html = readFileSync(join(dist, "index.html"), "utf8");
  } catch {
    return res.status(503).send("frontend not built — run: npm run build");
  }
  res.send(html.replace('content="/og.png"', `content="${ogImage(req)}"`));
});

const frozenDir = join(root, "..", "frozen");

app.get("/play/:id", (req, res) => {
  let title = "andstar";
  let desc = "an interactive dialogue game";
  let version = null; // the demo and unknown ids ride the current player
  if (req.params.id === "demo") {
    title = "Two Wings Good";
    desc = "the andstar demo: the night mail goes down in the desert, 1935";
  } else {
    const row = getGame.get(req.params.id);
    if (row) {
      title = row.title;
      if (row.author) desc = `a dialogue game by ${row.author}`;
      version = row.version;
    }
  }
  // Version pinning: serve the frozen player the game was published under, so the
  // engine moving on never restyles or re-behaves an old game. Fall back to the
  // current build when that version was never frozen (e.g. before its snapshot).
  const frozenPage = version ? join(frozenDir, version, "play.html") : null;
  let template;
  try {
    template = readFileSync(frozenPage && existsSync(frozenPage) ? frozenPage : join(dist, "play.html"), "utf8");
  } catch {
    return res.status(503).send("frontend not built — run: npm run build");
  }
  const head = [
    `<title>${escapeHtml(title)} — andstar</title>`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(desc)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:image" content="${ogImage(req)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ].join("\n    ");
  res.send(template.replace("<title>andstar</title>", head));
});

app.get("/create", (_req, res) => res.sendFile(join(dist, "create.html")));
app.get("/docs", (_req, res) => res.sendFile(join(dist, "docs.html")));

// Frozen per-version player bundles (immutable; committed). /v/0.4.0/assets/… etc.
app.use("/v", express.static(frozenDir, { immutable: true, maxAge: "1y" }));
app.use(express.static(dist));

app.use((_req, res) => {
  res.status(404).send(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>404 — andstar</title>` +
    `<body style="background:#0e0e0e;color:#8e8e8e;font-family:'Iowan Old Style',Palatino,Georgia,serif;display:flex;height:100vh;margin:0">` +
    `<div style="margin:auto;text-align:center"><p style="letter-spacing:.25em">404</p>` +
    `<p>nothing out here but geology and you.</p>` +
    `<p><a href="/" style="color:#d8d8d8">go home</a></p></div>`,
  );
});

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`andstar server listening on http://localhost:${port}`);
});
