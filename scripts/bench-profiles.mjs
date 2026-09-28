/**
 * Score the four imported 全自動 profiles on a real underwater benchmark
 * (UIEB raw images with ground-truth references).
 *
 *   npm run build && node scripts/bench-profiles.mjs [imageDir]
 *
 * Two numbers per image, because the question that matters is not "does it
 * look red" but "where did it land":
 *
 *   castErr  colour cast error against the GROUND TRUTH reference
 *   drift   how far the profile moved from the engine's own 全自動 result
 *
 * A profile is only "an alternative route to the same place" if drift is
 * small AND castErr is no worse than auto. This is the harness that decides
 * that, rather than eyeballing screenshots.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'verify-output');
mkdirSync(OUT, { recursive: true });
const DIR = process.argv[2] ?? '/tmp/uwbench/imgs';
const PORT = 4700 + Math.floor(Math.random() * 200);
const PROFILES = ['全自動-bornfree', '全自動-nikolajbech', '全自動-T77701', '全自動-warplab'];

const raws = readdirSync(DIR).filter((f) => f.endsWith('-raw.jpg')).sort();
if (!raws.length) throw new Error(`no *-raw.jpg in ${DIR}`);

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('preview did not start')), 30000);
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && (clearTimeout(t), res()));
});
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(`http://localhost:${PORT}/Underwater-recovery/`);
await page.waitForFunction(() => !!window.__uw);

const rows = [];
for (const file of raws) {
  const gt = file.replace('-raw.jpg', '-gt.jpg');
  const b64 = readFileSync(join(DIR, file)).toString('base64');
  const gtStats = await page.evaluate(async (d) => {
    const bin = atob(d);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u]));
    const c = document.createElement('canvas');
    const S = 128;
    c.width = S; c.height = Math.max(1, Math.round((bmp.height / bmp.width) * S));
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; n++; }
    return { r: r / n, g: gg / n, b: b / n, w: c.width, h: c.height };
  }, readFileSync(join(DIR, gt)).toString('base64'));

  await page.evaluate((g) => { window.__gtSize = g; }, gtStats);
  const out = await page.evaluate(async (d) => {
    const bin = atob(d);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    await window.__uw.addFiles([new File([u], 'i.jpg', { type: 'image/jpeg' })]);
    window.__uw.setView({ mode: 0 });
    const meas = (label) => {
      window.__uw.render();
      const o = window.__uw.outputPixels();
      // downsample to the GT's size so cast is compared like for like
      const c = document.createElement('canvas');
      c.width = o.w; c.height = o.h;
      const id = c.getContext('2d').createImageData(o.w, o.h);
      id.data.set(new Uint8ClampedArray(o.px));
      c.getContext('2d').putImageData(id, 0, 0);
      const t = document.createElement('canvas');
      t.width = window.__gtSize.w; t.height = window.__gtSize.h;
      const g2 = t.getContext('2d');
      g2.drawImage(c, 0, 0, t.width, t.height);
      const px = g2.getImageData(0, 0, t.width, t.height).data;
      let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; n++; }
      return { label, r: r / n, g: gg / n, b: b / n };
    };
    const res = {};
    window.__uw.preset('auto');
    res.auto = meas('auto');
    for (const p of ['全自動-bornfree', '全自動-nikolajbech', '全自動-T77701', '全自動-warplab']) {
      window.__uw.preset(p);
      res[p] = meas(p);
    }
    window.__uw.preset('auto');
    return res;
  }, b64);
  void gtStats;
  rows.push({ file, gt: gtStats, out });
  console.log(`processed ${file}`);
}

// score
const cast = (m) => m.b - (m.r + m.g) / 2;      // >0 blue cast, <0 warm cast
const f = (x) => Number(x).toFixed(1);
console.log(`\nimage                          | ${PROFILES.map((p) => p.replace('全自動-', '').padEnd(13)).join('| ')}`);
console.log('—'.repeat(90));
let acc = { auto: { c: 0, d: 0 }, };
for (const p of PROFILES) acc[p] = { c: 0, d: 0 };
for (const r of rows) {
  const gtCast = cast(r.gt);
  const line = [`${r.file.slice(0, 3)} truth ${f(gtCast)}`.padEnd(29)];
  const autoCast = cast(r.out.auto);
  for (const p of ['auto', ...PROFILES]) {
    const c = Math.abs(cast(r.out[p]) - gtCast);
    const d = p === 'auto' ? 0 : Math.abs(cast(r.out[p]) - autoCast);
    acc[p].c += c; acc[p].d += d;
    line.push(p === 'auto' ? `err ${f(c)}`.padEnd(13) : `e${f(c)} d${f(d)}`.padEnd(13));
  }
  console.log(line.join('| '));
}
const n = rows.length;
console.log('—'.repeat(90));
const avg = ['avg'.padEnd(29)];
for (const p of ['auto', ...PROFILES]) {
  avg.push(`e${f(acc[p].c / n)} d${f(acc[p].d / n)}`.padEnd(13));
}
console.log(avg.join('| '));
console.log('\ne = |cast error vs ground truth|, d = |cast drift from the engine\'s own 全自動|');
writeFileSync(join(OUT, 'profile-bench.json'), JSON.stringify(rows, null, 2));
await browser.close();
server.kill();
