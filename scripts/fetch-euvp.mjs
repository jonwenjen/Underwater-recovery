/**
 * Real underwater photographs with reference images, for scoring auto:
 *   node scripts/fetch-euvp.mjs [outDir=/tmp/euvp]
 *
 * The EUVP test pairs (Islam et al., "Fast Underwater Image Enhancement for
 * Improved Visual Perception", RA-L 2020) ship in the FUnIE-GAN repository:
 * 23 raw frames (data/test/A) with reference restorations (data/test/GTr_A),
 * 256×256. They are fetched to a temporary folder — never committed — and
 * decoded once in Chromium to raw RGBA at the engine's analysis size, so
 * scripts/optimize.ts (--real) can score on them in plain Node.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? '/tmp/euvp';
const REPO = join(OUT, 'FUnIE-GAN');
const EDGE = 192; // ANALYSIS_EDGE in src/engine/auto.ts
mkdirSync(OUT, { recursive: true });

if (!existsSync(join(REPO, 'data/test/A'))) {
  execFileSync('git', ['clone', '-q', '--depth', '1', '--filter=blob:none', '--no-checkout', 'https://github.com/xahidbuffon/FUnIE-GAN', REPO], { stdio: 'inherit' });
  execFileSync('git', ['-C', REPO, 'checkout', '-q', 'HEAD', '--', 'data/test/A', 'data/test/GTr_A'], { stdio: 'inherit' });
}
const names = readdirSync(join(REPO, 'data/test/A')).filter((f) => /\.jpe?g$/i.test(f)).sort((a, b) => parseInt(a) - parseInt(b));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage();
const decode = (b64) =>
  page.evaluate(
    async ({ b64, EDGE }) => {
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([u]));
      const s = EDGE / Math.max(bmp.width, bmp.height);
      const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, 0, 0, w, h);
      return { w, h, px: Array.from(g.getImageData(0, 0, w, h).data) };
    },
    { b64, EDGE },
  );

const index = [];
for (const f of names) {
  const raw = await decode(readFileSync(join(REPO, 'data/test/A', f)).toString('base64'));
  const ref = await decode(readFileSync(join(REPO, 'data/test/GTr_A', f)).toString('base64'));
  const base = f.replace(/\.\w+$/, '');
  writeFileSync(join(OUT, `${base}-raw.rgba`), Uint8Array.from(raw.px));
  writeFileSync(join(OUT, `${base}-ref.rgba`), Uint8Array.from(ref.px));
  index.push({ name: base, w: raw.w, h: raw.h });
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1));
await browser.close();
console.log(`${index.length} pairs → ${OUT}`);
