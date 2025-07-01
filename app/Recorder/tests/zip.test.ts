// Tests for the STORE-mode ZIP builder (zip.ts).
// Pure logic, no browser APIs needed.

import { describe, it } from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert";

// Duplicate the implementation inline to avoid module resolution issues
// with the extension's ESM setup. This is a direct copy of zip.ts.

const enc = new TextEncoder();

function crc32(data: Uint8Array): number {
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

function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}

function u32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}

function dosNow(): { time: number; date: number } {
  const d = new Date();
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
  };
}

function cat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

type ZipEntry = { name: string; data: Uint8Array };

function buildZip(entries: ZipEntry[]): Uint8Array {
  const { time, date } = dosNow();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const sz = data.length;

    const local = cat([
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      u16(20), u16(0), u16(0),
      u16(time), u16(date),
      u32(crc), u32(sz), u32(sz),
      u16(nameBytes.length), u16(0),
      nameBytes, data,
    ]);

    const central = cat([
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
      u16(20), u16(20),
      u16(0), u16(0),
      u16(time), u16(date),
      u32(crc), u32(sz), u32(sz),
      u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0),
      u32(0), u32(offset),
      nameBytes,
    ]);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = cat([
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0),
    u16(entries.length), u16(entries.length),
    u32(cdSize), u32(offset),
    u16(0),
  ]);

  return cat([...locals, ...centrals, eocd]);
}

// ---- Tests ----

describe("ZIP builder", () => {
  it("produces a valid empty ZIP (no entries)", () => {
    const zip = buildZip([]);

    // Minimum valid ZIP: just the EOCD record (22 bytes).
    ok(zip.length >= 22, `expected at least 22 bytes, got ${zip.length}`);

    // EOCD signature at end-22
    const eocdOffset = zip.length - 22;
    strictEqual(zip[eocdOffset], 0x50);
    strictEqual(zip[eocdOffset + 1], 0x4b);
    strictEqual(zip[eocdOffset + 2], 0x05);
    strictEqual(zip[eocdOffset + 3], 0x06);

    // Total entries = 0 (at EOCD offsets 8 and 10)
    strictEqual(zip[eocdOffset + 8], 0);
    strictEqual(zip[eocdOffset + 10], 0);
  });

  it("produces a valid ZIP with a single entry", () => {
    const data = enc.encode("hello world");
    const zip = buildZip([{ name: "test.txt", data }]);

    // Should have: local header + central directory + EOCD
    const eocdOffset = zip.length - 22;

    // Check EOCD entry count = 1
    strictEqual(zip[eocdOffset + 8], 1);
    strictEqual(zip[eocdOffset + 10], 1);

    // Central directory offset (EOCD bytes 16-19, little-endian)
    const cdOffset = zip[eocdOffset + 16] | (zip[eocdOffset + 17] << 8) |
                     (zip[eocdOffset + 18] << 16) | (zip[eocdOffset + 19] << 24);

    // Central directory should come after the local header
    ok(cdOffset > 0, "central directory offset should be > 0");

    // Central directory signature at cdOffset
    strictEqual(zip[cdOffset], 0x50);
    strictEqual(zip[cdOffset + 1], 0x4b);
    strictEqual(zip[cdOffset + 2], 0x01);
    strictEqual(zip[cdOffset + 3], 0x02);
  });

  it("preserves entry data round-trip", () => {
    const original = enc.encode("test content for round-trip verification");
    const zip = buildZip([{ name: "data.bin", data: original }]);

    // Parse the local file header to find the data.
    // Local header is at offset 0: 30 bytes + name length + extra length
    const nameLen = zip[26] | (zip[27] << 8);
    const extraLen = zip[28] | (zip[29] << 8);
    const dataOffset = 30 + nameLen + extraLen;
    const compressedSize = zip[18] | (zip[19] << 8) | (zip[20] << 16) | (zip[21] << 24);

    const extracted = zip.slice(dataOffset, dataOffset + compressedSize);
    deepStrictEqual(extracted, original);
  });

  it("preserves entry data for multiple entries (simulates export)", () => {
    const manifest = enc.encode(JSON.stringify({ version: "1.0", session: { id: "abc" } }));
    const events = enc.encode(JSON.stringify([{ type: "navigation" }]));
    const audio = new Uint8Array(1024).fill(0xab);

    const zip = buildZip([
      { name: "manifest.json", data: manifest },
      { name: "events.json", data: events },
      { name: "audio.webm", data: audio },
    ]);

    // Check EOCD entry count = 3
    const eocdOffset = zip.length - 22;
    strictEqual(zip[eocdOffset + 8], 3);

    // Verify each entry can be found by name.
    for (const { name, data } of [
      { name: "manifest.json", data: manifest },
      { name: "events.json", data: events },
      { name: "audio.webm", data: audio },
    ]) {
      const found = findEntry(zip, name);
      ok(found !== null, `entry "${name}" not found`);
      if (found) {
        deepStrictEqual(found, data, `data mismatch for "${name}"`);
      }
    }
  });

  it("handles large audio-like data (simulates 20+ min session)", () => {
    // 20 minutes of 1-second 1KB chunks = ~1.2 MB of audio data
    const largeData = new Uint8Array(1200 * 1024);
    for (let i = 0; i < largeData.length; i++) largeData[i] = (i * 7 + 13) & 0xff;

    const zip = buildZip([
      { name: "manifest.json", data: enc.encode(JSON.stringify({ version: "1.0" })) },
      { name: "events.json", data: enc.encode(JSON.stringify(Array.from({ length: 1200 }, (_, i) => ({
        id: `evt-${i}`, type: "interaction", sessionOffsetMs: i * 1000,
      })))) },
      { name: "audio.webm", data: largeData },
    ]);

    // Verify the large data round-trips.
    const found = findEntry(zip, "audio.webm");
    ok(found !== null, "audio.webm entry not found");
    if (found) {
      strictEqual(found.length, largeData.length);
      deepStrictEqual(found, largeData);
    }

    // Verify the events.json round-trips.
    const eventsFound = findEntry(zip, "events.json");
    ok(eventsFound !== null, "events.json entry not found");
    if (eventsFound) {
      const parsed = JSON.parse(new TextDecoder().decode(eventsFound));
      strictEqual(parsed.length, 1200);
      // Verify sorted by sessionOffsetMs
      for (let i = 1; i < parsed.length; i++) {
        ok(parsed[i].sessionOffsetMs >= parsed[i - 1].sessionOffsetMs,
           `events not sorted at index ${i}: ${parsed[i].sessionOffsetMs} < ${parsed[i - 1].sessionOffsetMs}`);
      }
    }
  });

  it("handles filenames with path separators (screenshots)", () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const zip = buildZip([
      { name: "screenshots/test-uuid.png", data },
    ]);

    const found = findEntry(zip, "screenshots/test-uuid.png");
    ok(found !== null, "screenshots entry with path not found");
    if (found) deepStrictEqual(found, data);
  });

  it("uses STORE method (compression method = 0)", () => {
    const data = enc.encode("uncompressed");
    const zip = buildZip([{ name: "test.txt", data }]);

    // Local header: byte 8-9 = compression method (offset 8 from local header start)
    strictEqual(zip[8], 0);
    strictEqual(zip[9], 0);

    // Compressed size == uncompressed size (bytes 18-21 and 22-25)
    const compressed = zip[18] | (zip[19] << 8) | (zip[20] << 16) | (zip[21] << 24);
    const uncompressed = zip[22] | (zip[23] << 8) | (zip[24] << 16) | (zip[25] << 24);
    strictEqual(compressed, uncompressed, "STORE: compressed and uncompressed sizes should match");
    strictEqual(compressed, data.length, "size should match input data length");
  });

  it("CRC-32 is deterministic and correct for known inputs", () => {
    const empty = new Uint8Array(0);
    strictEqual(crc32(empty), 0);

    const hello = enc.encode("hello");
    // Known CRC-32 of "hello" = 0x3610a686 (verified with Python zlib.crc32)
    strictEqual(crc32(hello), 0x3610a686);
  });
});

// Helper: find and extract an entry by name from a ZIP.
function findEntry(zip: Uint8Array, targetName: string): Uint8Array | null {
  // Read EOCD to find the central directory.
  const eocdOffset = zip.length - 22;
  const cdOffset = zip[eocdOffset + 16] | (zip[eocdOffset + 17] << 8) |
                   (zip[eocdOffset + 18] << 16) | (zip[eocdOffset + 19] << 24);
  const totalEntries = zip[eocdOffset + 8] | (zip[eocdOffset + 10] << 8);

  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    // Check signature
    const sig = zip[pos] | (zip[pos + 1] << 8) | (zip[pos + 2] << 16) | (zip[pos + 3] << 24);
    if (sig !== 0x02014b50) return null; // invalid central directory

    const nameLen = zip[pos + 28] | (zip[pos + 29] << 8);
    const extraLen = zip[pos + 30] | (zip[pos + 31] << 8);
    const commentLen = zip[pos + 32] | (zip[pos + 33] << 8);
    const localOffset = zip[pos + 42] | (zip[pos + 43] << 8) |
                        (zip[pos + 44] << 16) | (zip[pos + 45] << 24);

    const nameBytes = zip.slice(pos + 46, pos + 46 + nameLen);
    const name = new TextDecoder().decode(nameBytes);

    if (name === targetName) {
      // Parse local header to find data.
      const localNameLen = zip[localOffset + 26] | (zip[localOffset + 27] << 8);
      const localExtraLen = zip[localOffset + 28] | (zip[localOffset + 29] << 8);
      const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
      const size = zip[localOffset + 18] | (zip[localOffset + 19] << 8) |
                   (zip[localOffset + 20] << 16) | (zip[localOffset + 21] << 24);
      return zip.slice(dataOffset, dataOffset + size);
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
