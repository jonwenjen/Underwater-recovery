/**
 * Render the app icons from apps/icon.svg (Chromium via Playwright):
 *   node apps/render-icons.mjs
 * macOS: apps/mac/build/icon.png (1024², electron-builder makes the .icns).
 * Android: legacy / round / adaptive-foreground launcher icons per density,
 * and the launch splash in each existing size.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const here = import.meta.dirname;
const svg = readFileSync(join(here, 'icon.svg'), 'utf8');
const RES = join(here, 'android/app/src/main/res');
const BG = '#06121f';

/** An <img>-free page: the SVG inline with a chosen viewBox and optional plate. */
const page = (vb, { plate = true, round = false, bg = 'transparent' } = {}) => {
  const s = svg.replace(/viewBox="[^"]*"/, `viewBox="${vb}" preserveAspectRatio="xMidYMid meet"`);
  return `<!doctype html><style>html,body{margin:0;height:100%;background:${bg}}svg{display:block;width:100%;height:100%}
  ${plate ? '' : '#plate{display:none}'} ${round ? 'svg{clip-path:circle(50%)}' : ''}</style>${s}`;
};
const pngSize = (f) => {
  const b = readFileSync(f);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const shot = async (html, w, h, path, transparent = true) => {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(html);
  await p.screenshot({ path, omitBackground: transparent });
  await p.close();
  console.log(`${w}×${h}  ${path.replace(here + '/', '')}`);
};

await shot(page('0 0 1024 1024'), 1024, 1024, join(here, 'mac/build/icon.png'));

const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(DENSITY)) {
  const dir = join(RES, `mipmap-${d}`);
  await shot(page('100 100 824 824'), 48 * k, 48 * k, join(dir, 'ic_launcher.png'));
  await shot(page('100 100 824 824', { round: true }), 48 * k, 48 * k, join(dir, 'ic_launcher_round.png'));
  // adaptive foreground: 108 dp canvas, the lens inside the 66 dp safe circle
  await shot(page('50 50 924 924', { plate: false }), 108 * k, 108 * k, join(dir, 'ic_launcher_foreground.png'));
}

for (const d of readdirSync(RES).filter((x) => x.startsWith('drawable'))) {
  const f = join(RES, d, 'splash.png');
  let size;
  try {
    size = pngSize(f);
  } catch {
    continue;
  }
  const [w, h] = size;
  // the lens (554 of 1024 units with its ring) at 32 % of the short side
  const u = 554 / (Math.min(w, h) * 0.32);
  const vb = `${512 - (w * u) / 2} ${512 - (h * u) / 2} ${w * u} ${h * u}`;
  await shot(page(vb, { plate: false, bg: BG }), w, h, f, false);
}
await browser.close();
