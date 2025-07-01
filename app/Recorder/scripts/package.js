// Packages dist/ into an installable extension archive.
//
// Firefox requires manifest.json at the ROOT of the archive — zipping the dist
// folder itself (producing dist/manifest.json inside the zip) yields "does not
// contain a valid manifest" on load. This script always writes paths relative to
// dist/, so the layout is correct regardless of where it is run from.

import { deflateRawSync } from "zlib";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, posix, relative, sep } from "path";

const SOURCE_DIR = "dist";
const OUTPUT_DIR = "build";

// ---- ZIP writer (DEFLATE, no directory entries) ----

function crc32(data) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date) {
  return {
    time:
      ((date.getHours() & 0x1f) << 11) |
      ((date.getMinutes() & 0x3f) << 5) |
      ((date.getSeconds() >> 1) & 0x1f),
    date:
      (((date.getFullYear() - 1980) & 0x7f) << 9) |
      (((date.getMonth() + 1) & 0x0f) << 5) |
      (date.getDate() & 0x1f),
  };
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

// entries: [{ name, data, mtime }] where name is a "/"-separated archive path.
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data, mtime } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const { time, date } = dosTimestamp(mtime);
    const crc = crc32(data);
    const compressed = deflateRawSync(data, { level: 9 });
    // DEFLATE can exceed the input on incompressible data; fall back to STORE.
    const deflated = compressed.length < data.length;
    const payload = deflated ? compressed : data;
    const method = deflated ? 8 : 0;

    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), // local file header signature
      u16(20), u16(0), u16(method),           // version needed, flags, method
      u16(time), u16(date),
      u32(crc), u32(payload.length), u32(data.length),
      u16(nameBytes.length), u16(0),          // name length, extra field length
      nameBytes, payload,
    ]);

    const central = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]), // central directory signature
      u16(20), u16(20),                       // version made by, version needed
      u16(0), u16(method),                    // flags, method
      u16(time), u16(date),
      u32(crc), u32(payload.length), u32(data.length),
      u16(nameBytes.length), u16(0), u16(0), // name len, extra len, comment len
      u16(0), u16(0),                         // disk start, internal attrs
      u32(0), u32(offset),                    // external attrs, local header offset
      nameBytes,
    ]);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]), // end of central directory signature
    u16(0), u16(0),                         // disk number, disk with start of CD
    u16(entries.length), u16(entries.length),
    u32(centralSize), u32(offset),
    u16(0),                                 // comment length
  ]);

  return Buffer.concat([...locals, ...centrals, eocd]);
}

// ---- Collect dist/ ----

function collectFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectFiles(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

let files;
try {
  files = collectFiles(SOURCE_DIR);
} catch {
  console.error(`No ${SOURCE_DIR}/ directory — run \`npm run build\` first.`);
  process.exit(1);
}

const manifestPath = join(SOURCE_DIR, "manifest.json");
if (!files.includes(manifestPath)) {
  console.error(`No manifest.json in ${SOURCE_DIR}/ — the build is incomplete.`);
  process.exit(1);
}

const { name, version } = JSON.parse(readFileSync(manifestPath, "utf8"));

// manifest.json first so it lands at the head of the archive, as Firefox expects.
const entries = [manifestPath, ...files.filter((f) => f !== manifestPath).sort()].map(
  (file) => ({
    name: relative(SOURCE_DIR, file).split(sep).join(posix.sep),
    data: readFileSync(file),
    mtime: statSync(file).mtime,
  })
);

const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const outputPath = join(OUTPUT_DIR, `${slug}-${version}.zip`);

mkdirSync(OUTPUT_DIR, { recursive: true });
const zip = buildZip(entries);
writeFileSync(outputPath, zip);

const sizeKb = (zip.length / 1024).toFixed(1);
console.log(`Packaged ${entries.length} files → ${outputPath} (${sizeKb} KB)`);
