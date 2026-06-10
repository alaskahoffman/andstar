// Builds a self-contained itch.io upload: index.html (engine + game baked in)
// plus the script source, packed into a stored (uncompressed) ZIP — written by
// hand so we stay dependency-free.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string; // ASCII paths only
  data: Uint8Array;
}

/** Minimal ZIP archive, method "stored" (no compression). */
export function makeZip(files: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const DOS_DATE = 0x0021; // 1980-01-01 — exports are reproducible

  for (const f of files) {
    const name = encoder.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // method: stored
    local.setUint16(10, 0, true); // mod time
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true); // compressed
    local.setUint32(22, f.data.length, true); // uncompressed
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true); // extra
    chunks.push(new Uint8Array(local.buffer), name, f.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); // central directory header
    cd.setUint16(4, 20, true); // made by
    cd.setUint16(6, 20, true); // needed
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, DOS_DATE, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    // extra/comment/disk/attrs all zero (30..37)
    cd.setUint32(42, offset, true); // local header offset
    central.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + f.data.length;
  }

  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); // end of central directory
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  chunks.push(...central, new Uint8Array(eocd.buffer));

  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** Read a file back out of a stored ZIP we made (IMPORT accepts exports). */
export function readZipEntry(zip: Uint8Array, wanted: string): string | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const decoder = new TextDecoder();
  let p = 0;
  while (p + 30 <= zip.length && view.getUint32(p, true) === 0x04034b50) {
    const method = view.getUint16(p + 8, true);
    const csize = view.getUint32(p + 18, true);
    const nameLen = view.getUint16(p + 26, true);
    const extraLen = view.getUint16(p + 28, true);
    const name = decoder.decode(zip.subarray(p + 30, p + 30 + nameLen));
    const dataStart = p + 30 + nameLen + extraLen;
    if (name === wanted) {
      if (method !== 0) return null; // compressed by another tool — can't read it here
      return decoder.decode(zip.subarray(dataStart, dataStart + csize));
    }
    p = dataStart + csize;
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Compose the single-file player page with the game baked in. */
export function buildItchHtml(title: string, source: string, bundle: string): string {
  // <-escape so game text like "</script>" can't break out of the tag;
  // same defensive replace on the bundle (a no-op for our own code).
  const gameJson = JSON.stringify({ source }).replace(/</g, "\\u003c");
  const safeBundle = bundle.replace(/<\/script/gi, "<\\/script");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    "<body>",
    `<script>window.__GAME__=${gameJson};</script>`,
    `<script>${safeBundle}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

/** Full itch.io ZIP: index.html plus the editable script as a backup. */
export function buildItchZip(title: string, source: string, bundle: string): Uint8Array {
  const enc = new TextEncoder();
  return makeZip([
    { name: "index.html", data: enc.encode(buildItchHtml(title, source, bundle)) },
    { name: "source.txt", data: enc.encode(source) },
  ]);
}
