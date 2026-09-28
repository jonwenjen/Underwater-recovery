
/** Renders the four imported profiles on a real underwater photograph. */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'verify-output');
mkdirSync(OUT, { recursive: true });
const PORT = 4600 + Math.floor(Math.random() * 300);
const URL_PHOTO = process.argv[2] ?? 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=1400&q=80';

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

const stats = async (label) => {
  const s = await page.evaluate(() => {
    const o = window.__uw.outputPixels();
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < o.px.length; i += 4) { r += o.px[i]; g += o.px[i + 1]; b += o.px[i + 2]; n++; }
    return { r: r / n, g: g / n, b: b / n, w: o.w, h: o.h };
  });
  const cast = s.b - (s.r + s.g) / 2;
  console.log(`${label.padEnd(22)} r=${s.r.toFixed(1)} g=${s.g.toFixed(1)} b=${s.b.toFixed(1)}  blueCast=${cast.toFixed(1)}`);
  const url = await page.evaluate(() => {
    const o = window.__uw.outputPixels();
    const c = document.createElement('canvas'); c.width = o.w; c.height = o.h;
    const g2 = c.getContext('2d'); const id = g2.createImageData(o.w, o.h);
    id.data.set(new Uint8ClampedArray(o.px)); g2.putImageData(id, 0, 0);
    return c.toDataURL('image/png');
  });
  writeFileSync(join(OUT, `real-${label}.png`), Buffer.from(url.split(',')[1], 'base64'));
  return s;
};

const b64 = Buffer.from((await (await fetch(URL_PHOTO)).arrayBuffer())).toString('base64');
await page.evaluate(async (d) => {
  const bin = atob(d); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const f = new File([u], 'p.jpg', { type: 'image/jpeg' });
  await window.__uw.addFiles([f]);
}, b64);
await new Promise((r) => setTimeout(r, 2500));
await stats('原片 source');
for (const p of ['全自動-bornfree', '全自動-nikolajbech', '全自動-T77701', '全自動-warplab']) {
  await page.evaluate((n) => { window.__uw.preset(n); window.__uw.render(); }, p);
  await new Promise((r) => setTimeout(r, 900));
  await stats(p);
}
await page.evaluate(() => { window.__uw.preset('auto'); window.__uw.render(); });
await stats('auto 對照');
await browser.close(); server.kill();
