/**
 * Fetch a handful of images out of a huge public Google Drive zip using HTTP
 * range requests, instead of downloading the whole archive.

The Drive folder the user pointed at holds a 13+ GB underwater dataset. The
zip central directory lives at the end of the file, so a few range requests
are enough to list it, and one small range request per image is enough to
extract just that image. 1 MB of traffic instead of 13 GB.

  node scripts/fetch-drive-zip.mjs <fileId> <outDir> [count]
 */
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

const [, , FILE_ID, OUT_DIR, COUNT = '8', PATTERN = /\.(jpe?g|png)$/i] = process.argv;
const BASE = `https://drive.usercontent.google.com/download?id=${FILE_ID}&export=download&confirm=t`;

const range = (start, end) =>
  new Promise((res, rej) => {
    const c = spawn('curl', ['-sL', '-r', `${start}-${end}`, BASE]);
    const bufs = [];
    c.stdout.on('data', (d) => bufs.push(d));
    c.on('close', (code) =>
      code === 0 || bufs.length ? res(Buffer.concat(bufs)) : rej(new Error(`curl ${code}`)),
    );
    c.on('error', rej);
  });

const total = await new Promise((res) => {
  const c = spawn('curl', ['-sIL', BASE]);
  let out = '';
  c.stdout.on('data', (d) => (out += d));
  c.on('close', () => {
    const m = [...out.matchAll(/content-length:\s*(\d+)/gi)].map((x) => Number(x[1]));
    res(m.length ? m[m.length - 1] : 0);
  });
});
if (!total) throw new Error('could not read content-length');
console.log(`archive size ${(total / 1e9).toFixed(2)} GB`);

// End of central directory: scan the last 64 KiB backwards for PK\x05\x06.
const tailStart = Math.max(0, total - 65536);
const tail = await range(tailStart, total - 1);
let eocd = -1;
for (let i = tail.length - 22; i >= 0; i--) {
  if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error('no end-of-central-directory record');
const cdCount = tail.readUInt16LE(eocd + 10);
const cdSize = tail.readUInt32LE(eocd + 12);
const cdOffset = tail.readUInt32LE(eocd + 16);

// ZIP64: a 34 GB archive is one, and 0xFFFFFFFF/0xFFFF in the classic record
// mean "look in the ZIP64 record", not "that is the value".
let count = cdCount;
let size = cdSize;
let offset = cdOffset;
if (cdOffset === 0xffffffff || cdSize === 0xffffffff || cdCount === 0xffff) {
  // ZIP64 end-of-central-directory locator sits 20 bytes before the EOCD.
  const loc = eocd - 20;
  if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('no ZIP64 locator');
  const z64 = Number(tail.readBigUInt64LE(loc + 8));
  const rec = await range(z64, z64 + 55);
  if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error('no ZIP64 end-of-central-directory');
  count = Number(rec.readBigUInt64LE(32));
  size = Number(rec.readBigUInt64LE(40));
  offset = Number(rec.readBigUInt64LE(48));
  console.log(`ZIP64: ${count} entries, central directory ${(size / 1e6).toFixed(1)} MB at ${offset}`);
}

// Fetch the directory outright. Reusing the tail only works when the whole
// directory happens to fall inside it, and here it starts ~19 MB before the
// tail does — a tail-reuse guard silently yields zero entries.
const cd = await range(offset, Math.min(total - 1, offset + size - 1));

const entries = [];
let p = 0;
while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
  const method = cd.readUInt16LE(p + 10);
  let compSize = cd.readUInt32LE(p + 20);
  let localOff = cd.readUInt32LE(p + 42);
  const nameLen = cd.readUInt16LE(p + 28);
  const extraLen = cd.readUInt16LE(p + 30);
  const commentLen = cd.readUInt16LE(p + 32);
  const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
  // ZIP64 extended information extra field (0x0001) carries the real values.
  if (localOff === 0xffffffff || compSize === 0xffffffff) {
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = cd.readUInt16LE(e);
      const sz = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (cd.readUInt32LE(p + 24) === 0xffffffff) q += 8; // uncompressed size
        if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (localOff === 0xffffffff) localOff = Number(cd.readBigUInt64LE(q));
        break;
      }
      e += 4 + sz;
    }
  }
  if (!name.endsWith('/')) entries.push({ name, method, compSize, localOff });
  p += 46 + nameLen + extraLen + commentLen;
}
const imgs = entries.filter((e) => PATTERN.test(e.name));
console.log(`${entries.length} files, ${imgs.length} images`);

await mkdir(OUT_DIR, { recursive: true });
const want = imgs.slice(0, Number(COUNT));
let got = 0;
for (const e of want) {
  // local header: 30 bytes fixed + name + extra, then the data
  const lh = await range(e.localOff, e.localOff + 29);
  const nameLen = lh.readUInt16LE(26);
  const extraLen = lh.readUInt16LE(28);
  const dataStart = e.localOff + 30 + nameLen + extraLen;
  const raw = await range(dataStart, dataStart + e.compSize - 1);
  let out = raw;
  if (e.method === 8) out = inflateRawSync(raw);
  const safe = e.name.split('/').pop().replace(/[^\w.\-]+/g, '_');
  await writeFile(`${OUT_DIR}/${String(got).padStart(2, '0')}-${safe}`, out);
  got++;
  console.log(`  ${safe}  ${(out.length / 1024).toFixed(0)} KB`);
}
console.log(`extracted ${got} images to ${OUT_DIR}`);
void createWriteStream;
