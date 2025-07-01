// Minimal STORE-mode (no compression) ZIP builder for session export packages.
// Implements just enough of the ZIP spec (APPNOTE.TXT) for our use case.

const enc = new TextEncoder();

function crc32(data: Uint8Array<ArrayBufferLike>): number {
  // IEEE 802.3 CRC-32 lookup table (reversed polynomial 0xEDB88320).
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

function cat(parts: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

export type ZipEntry = { name: string; data: Uint8Array<ArrayBufferLike> };

export function buildZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const { time, date } = dosNow();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const sz = data.length;

    const local = cat([
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // local file header signature
      u16(20), u16(0), u16(0),                  // version needed, flags, method=STORE
      u16(time), u16(date),
      u32(crc), u32(sz), u32(sz),               // crc, compressed size, uncompressed size
      u16(nameBytes.length), u16(0),            // name length, extra field length
      nameBytes, data,
    ]);

    const central = cat([
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]), // central directory signature
      u16(20), u16(20),                         // version made by, version needed
      u16(0), u16(0),                           // flags, method=STORE
      u16(time), u16(date),
      u32(crc), u32(sz), u32(sz),
      u16(nameBytes.length), u16(0), u16(0),   // name len, extra len, comment len
      u16(0), u16(0),                           // disk start, internal attrs
      u32(0), u32(offset),                      // external attrs, local header offset
      nameBytes,
    ]);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = cat([
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]), // end of central directory signature
    u16(0), u16(0),                           // disk number, disk with start of CD
    u16(entries.length), u16(entries.length), // entries on disk, total entries
    u32(cdSize), u32(offset),                 // central directory size and offset
    u16(0),                                   // comment length
  ]);

  return cat([...locals, ...centrals, eocd]);
}
