/**
 * End-to-end verification of the built app in headless Chromium (WebGL2 via
 * SwiftShader, WebCodecs VP9). Drives the real UI code through `window.__uw`.
 *
 *   npm run build && node scripts/verify.mjs [outDir]
 *
 * Photo: a reef with known ground truth, degraded by the Jaffe–McGlamery
 * model, must come back measurably closer to the true colours.
 * Video: a clip that pans and descends in blue water, then cuts to green
 * water, must be tracked smoothly, cut-detected, and exported frame-exact.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] ?? join(root, 'verify-output');
mkdirSync(OUT, { recursive: true });
const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}/Underwater-recovery/`;

let failures = 0;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
const f1 = (x) => Number(x).toFixed(1);
const f3 = (x) => Number(x).toFixed(3);

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('preview server did not start')), 30000);
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(PORT))) {
      clearTimeout(t);
      res();
    }
  });
});

// CHROME_PATH: use an installed Chrome (CI uses the runner's preinstalled
// /usr/bin/google-chrome, which needs no apt dependency step); otherwise
// Playwright's bundled Chromium.
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const done = async (code) => {
  await browser.close().catch(() => {});
  server.kill();
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(code);
};

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript({ path: join(root, 'scripts/verify-scene.js') });
  await page.goto(BASE);
  await page.waitForFunction(() => !!window.__uw);

  /* ============================================================ photo */
  console.log('\n— photo: degraded reef with known ground truth (1600×1000, blue water, 8 m)');
  const photo = await page.evaluate(async () => {
    const S = window.__scene;
    const W = 1600, H = 1000;
    const t = S.truth(W, H);
    const deg = S.degrade(t, 'blue', 8);
    await window.__uw.addFiles([await S.toFile(deg, W, H, 'reef-blue.png')]);
    window.__uw.setView({ mode: 0 });
    const r = window.__uw.render();
    const o = window.__uw.outputPixels();
    // truth + source at the same analysis resolution for scoring
    const small = S.truth(o.w, o.h);
    const srcSmall = S.degrade(small, 'blue', 8);
    const before = S.chromaError(srcSmall, o.w, o.h, small);
    const after = S.chromaError(o.px, o.w, o.h, small);
    const coralBefore = S.chromaError(srcSmall, o.w, o.h, small, 'coral');
    const coralAfter = S.chromaError(o.px, o.w, o.h, small, 'coral');
    const coralTruth = S.chromaError(S.clean(small), o.w, o.h, small, 'coral');
    const slateAfter = S.chromaError(o.px, o.w, o.h, small, 'slate');
    // eyedropper on the white slate
    window.__uw.pickAt(0.865, 0.81);
    window.__uw.render();
    const o2 = window.__uw.outputPixels();
    const slatePicked = S.chromaError(o2.px, o2.w, o2.h, small, 'slate');
    const allPicked = S.chromaError(o2.px, o2.w, o2.h, small);
    const tc = S.clean(small);
    let tr = 0, tg = 0, tb = 0;
    for (let i = 0; i < tc.length; i += 4) { tr += tc[i]; tg += tc[i + 1]; tb += tc[i + 2]; }
    const truthStats = { r: tr / (tc.length / 4), g: tg / (tc.length / 4), b: tb / (tc.length / 4) };
    return { r, before, after, coralBefore, coralAfter, coralTruth, slateAfter, slatePicked, allPicked, truth: truthStats };
  });
  const { r } = photo;
  const cast = (s) => s.b - (s.r + s.g) / 2;
  console.log(`  source  r=${f1(r.src.r)} g=${f1(r.src.g)} b=${f1(r.src.b)} contrast=${f1(r.src.contrast)}`);
  console.log(`  output  r=${f1(r.out.r)} g=${f1(r.out.g)} b=${f1(r.out.b)} contrast=${f1(r.out.contrast)}`);
  check('underwater detected (blue water)', r.stats.underwater > 0.6 && r.stats.water === 'blue', `${f3(r.stats.underwater)} ${r.stats.water}`);
  // cast measured against the true scene (beige sand makes the truth itself
  // slightly yellow), not against zero
  check(
    'blue cast removed (> 75 % of the way to truth)',
    Math.abs(cast(r.out) - cast(photo.truth)) < 0.25 * Math.abs(cast(r.src) - cast(photo.truth)),
    `${f1(cast(r.src))} → ${f1(cast(r.out))} (truth ${f1(cast(photo.truth))})`,
  );
  check('red channel recovered', r.out.r > r.src.r * 1.4, `${f1(r.src.r)} → ${f1(r.out.r)}`);
  check('contrast increased (haze removed)', r.out.contrast > r.src.contrast * 1.3, `${f1(r.src.contrast)} → ${f1(r.out.contrast)}`);
  check(
    'colour error vs ground truth at least halved',
    photo.after.err < 0.5 * photo.before.err,
    `chroma L1 ${f3(photo.before.err)} → ${f3(photo.after.err)} (${f1((1 - photo.after.err / photo.before.err) * 100)} % better)`,
  );
  check(
    'coral reds restored toward truth',
    photo.coralAfter.redChroma > photo.coralBefore.redChroma + 0.1,
    `red chroma ${f3(photo.coralBefore.redChroma)} → ${f3(photo.coralAfter.redChroma)} (truth ${f3(photo.coralTruth.redChroma)})`,
  );
  check(
    'eyedropper on white slate neutralises it',
    photo.slatePicked.err < photo.slateAfter.err && photo.slatePicked.err < 0.06,
    `slate chroma err ${f3(photo.slateAfter.err)} → ${f3(photo.slatePicked.err)}; whole frame ${f3(photo.allPicked.err)}`,
  );
  await page.evaluate(() => window.__uw.preset('auto'));

  // split view screenshot + UI
  await page.evaluate(() => {
    window.__uw.setView({ mode: 1, split: 0.5 });
    window.__uw.render();
  });
  await page.screenshot({ path: join(OUT, 'studio-photo.png') });

  // live manual override: dragging a slider must change the image immediately
  const manual = await page.evaluate(() => {
    const auto = window.__uw.render();
    window.__uw.setParam('redComp', 0);
    const off = window.__uw.render();
    window.__uw.unlock('redComp');
    const back = window.__uw.render();
    return { auto: auto.out.r, off: off.out.r, back: back.out.r, eff: auto.effective.redComp, ms: off.ms };
  });
  check('manual slider overrides auto live', manual.off < manual.auto - 5, `red ${f1(manual.auto)} → ${f1(manual.off)} (redComp 0), re-render ${f1(manual.ms)} ms`);
  check('A badge returns control to auto', Math.abs(manual.back - manual.auto) < 0.5, `red back to ${f1(manual.back)}`);

  // 豐富色彩: press the real button, measure on the GPU output
  const vivid = await page.evaluate(() => {
    const S = window.__scene;
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const measure = (o, t) => {
      let C = 0, L = 0, c = 0, blown = 0;
      for (let y = 0; y < o.h; y++)
        for (let x = 0; x < o.w; x++) {
          const i = (y * o.w + x) * 4;
          const r = o.px[i] / 255, g = o.px[i + 1] / 255, b = o.px[i + 2] / 255;
          if (Math.min(r, g, b) >= 0.98) blown++;
          const ti = Math.min(t.h - 1, Math.floor(((y + 0.5) / o.h) * t.h)) * t.w + Math.min(t.w - 1, Math.floor(((x + 0.5) / o.w) * t.w));
          if (!t.object[ti]) continue;
          const lr = lin(r), lg = lin(g), lb = lin(b);
          const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
          const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
          const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
          const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
          const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
          C += Math.hypot(A, B);
          L += 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
          c++;
        }
      return { C: C / c, L: L / c, blown: blown / (o.w * o.h) };
    };
    window.__uw.preset('auto');
    window.__uw.setView({ mode: 0 });
    // full auto applies a mild dose itself: measure the option against OFF
    window.__uw.setParam('vivid', 0);
    window.__uw.render();
    const o0 = window.__uw.outputPixels();
    const t = S.truth(o0.w, o0.h);
    const src = S.degrade(t, 'blue', 8);
    const off = measure(o0, t);
    document.getElementById('vivid').click(); // the real UI toggle
    const r = window.__uw.render();
    const o1 = window.__uw.outputPixels();
    const on = measure(o1, t);
    const pressed = document.getElementById('vivid').getAttribute('aria-pressed');
    const readout = document.getElementById('fGain').textContent;
    return {
      off, on, pressed, readout, gain: r.effective && window.__uw.state().params.vivid,
      errSrc: S.chromaError(src, o0.w, o0.h, t).err,
      errOn: S.chromaError(o1.px, o1.w, o1.h, t).err,
      coralOff: S.chromaError(o0.px, o0.w, o0.h, t, 'coral').redChroma,
      coralOn: S.chromaError(o1.px, o1.w, o1.h, t, 'coral').redChroma,
    };
  });
  check('豐富色彩 button turns the option on', vivid.pressed === 'true' && vivid.readout.startsWith('×'), `pressed ${vivid.pressed}, readout ${vivid.readout}`);
  check('豐富色彩 (off → button): surface colour richer on the GPU (chroma +30 %)', vivid.on.C > vivid.off.C * 1.3, `OKLab C ${f3(vivid.off.C)} → ${f3(vivid.on.C)} (truth 0.077)`);
  check('豐富色彩: frame not darker, coral redder', vivid.on.L >= vivid.off.L - 0.005 && vivid.coralOn > vivid.coralOff, `L ${f3(vivid.off.L)} → ${f3(vivid.on.L)}, coral red ${f3(vivid.coralOff)} → ${f3(vivid.coralOn)}`);
  check('豐富色彩: no blown whites, still far closer to truth than the source', vivid.on.blown < 0.01 && vivid.errOn < 0.5 * vivid.errSrc, `blown ${f1(vivid.on.blown * 100)} %, colour error ${f3(vivid.errSrc)} → ${f3(vivid.errOn)}`);
  await page.evaluate(() => {
    window.__uw.setView({ mode: 1, split: 0.5 });
    window.__uw.render();
  });
  await page.screenshot({ path: join(OUT, 'studio-vivid.png') });
  await page.evaluate(() => document.getElementById('vivid').click()); // back off for the rest

  const ui = await page.evaluate(() => {
    const slider = document.querySelector('.srow input[aria-label="紅色補償"]');
    slider.value = '0.2';
    slider.dispatchEvent(new Event('input'));
    const st = window.__uw.state();
    const badge = slider.parentElement.querySelector('.abadge');
    const lockedBadge = badge.classList.contains('off');
    badge.click();
    return { locked: st.locked.includes('redComp'), preset: st.preset, lockedBadge, unlocked: !window.__uw.state().locked.includes('redComp') };
  });
  check('UI: moving a slider locks it, A badge unlocks', ui.locked && ui.lockedBadge && ui.unlocked && ui.preset === '');

  // Detail should be crisp, not crunchy: local-contrast energy of the final
  // GPU image (all passes, full resolution) against the true scene.
  const tex = await page.evaluate(async () => {
    const S = window.__scene;
    const W = 800, H = 500;
    const t = S.truth(W, H);
    await window.__uw.addFiles([await S.toFile(S.degrade(t, 'blue', 8), W, H, 'texture.png')]);
    window.__uw.preset('auto');
    window.__uw.setView({ mode: 0 });
    window.__uw.setPreview(0);
    window.__uw.render();
    const c2 = new OffscreenCanvas(W, H);
    const x2 = c2.getContext('2d');
    x2.drawImage(document.getElementById('view'), 0, 0);
    const out = x2.getImageData(0, 0, W, H).data;
    const energy = (px) => {
      const L = (i) => 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
      let e = 0, c = 0;
      for (let y = 2; y < H - 2; y++)
        for (let x = 2; x < W - 2; x++) {
          if (!t.object[y * W + x]) continue;
          let m = 0;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) m += L((y + dy) * W + x + dx);
          e += Math.abs(L(y * W + x) - m / 25);
          c++;
        }
      return e / c;
    };
    window.__uw.setPreview(1920);
    return { truth: energy(S.clean(t)), out: energy(out) };
  });
  const texRatio = tex.out / tex.truth;
  check('detail is crisp, not crunchy (1.2–2.0× truth local contrast)', texRatio > 1.2 && texRatio < 2.0, `${f1(tex.out)} vs truth ${f1(tex.truth)} (${texRatio.toFixed(2)}×)`);

  const harm = await page.evaluate(async () => {
    const S = window.__scene;
    const W = 800, H = 500;
    const t = S.truth(W, H);
    const clean = S.clean(t);
    await window.__uw.addFiles([await S.toFile(clean, W, H, 'clean.png')]);
    const r = window.__uw.render();
    const o = window.__uw.outputPixels();
    const small = S.truth(o.w, o.h);
    return { uw: r.stats.underwater, before: S.chromaError(S.clean(small), o.w, o.h, small).err, after: S.chromaError(o.px, o.w, o.h, small).err };
  });
  check('clean photo not flagged underwater', harm.uw < 0.35, `score ${f3(harm.uw)}`);
  check('clean photo colours preserved (no harm)', harm.after - harm.before < 0.03, `chroma err ${f3(harm.before)} → ${f3(harm.after)}`);

  const exp = await page.evaluate(async () => {
    const items = document.querySelectorAll('.thumb');
    items[0].click();
    await new Promise((r) => setTimeout(r, 100));
    const prev = window.__uw.render();
    const e = await window.__uw.exportPhoto('image/jpeg');
    return { prev: prev.out, e };
  });
  const dmax = Math.max(Math.abs(exp.prev.r - exp.e.stats.r), Math.abs(exp.prev.g - exp.e.stats.g), Math.abs(exp.prev.b - exp.e.stats.b));
  check('full-resolution JPEG export', exp.e.w === 1600 && exp.e.h === 1000 && exp.e.type === 'image/jpeg', `${exp.e.w}×${exp.e.h} ${(exp.e.size / 1e6).toFixed(2)} MB`);
  check('export matches preview (WYSIWYG)', dmax < 6, `max channel-mean diff ${f1(dmax)}`);

  const bench = await page.evaluate(() => {
    window.__uw.setPreview(1920);
    return window.__uw.bench(6);
  });
  check('photo re-render timing recorded', bench.msPerFrame > 0, `${f1(bench.msPerFrame)} ms/frame at ${bench.size.join('×')} on SwiftShader (CPU-emulated GPU)`);

  /* ====================================================== new controls */
  console.log('\n— presets, rotation, curves, HSL, 畫質修復');
  const feat = await page.evaluate(async () => {
    const S = window.__scene;
    const U = window.__uw;
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const lab = (r, g, b) => {
      const lr = lin(r / 255), lg = lin(g / 255), lb = lin(b / 255);
      const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
      const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
      const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
      return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
    };
    const meanOver = (o, t, mask, f) => {
      let a = 0, c = 0;
      for (let y = 0; y < o.h; y++)
        for (let x = 0; x < o.w; x++) {
          const ti = Math.min(t.h - 1, Math.floor(((y + 0.5) / o.h) * t.h)) * t.w + Math.min(t.w - 1, Math.floor(((x + 0.5) / o.w) * t.w));
          if (!mask(ti)) continue;
          const i = (y * o.w + x) * 4;
          a += f(o.px[i], o.px[i + 1], o.px[i + 2]);
          c++;
        }
      return a / Math.max(1, c);
    };
    const chroma = (r, g, b) => { const l = lab(r, g, b); return Math.hypot(l[1], l[2]); };
    const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const out = {};
    const W = 800, H = 500;
    const t = S.truth(W, H);
    await U.addFiles([await S.toFile(S.degrade(t, 'blue', 8), W, H, 'features.png')]);
    U.preset('auto');
    U.setView({ mode: 0 });

    // 原始: output must be the source
    U.preset('raw');
    U.render();
    const o0 = U.outputPixels(), s0 = U.sourcePixels();
    let d = 0;
    for (let i = 0; i < o0.px.length; i += 4) d += Math.abs(o0.px[i] - s0.px[i]) + Math.abs(o0.px[i + 1] - s0.px[i + 1]) + Math.abs(o0.px[i + 2] - s0.px[i + 2]);
    out.rawDiff = d / (o0.px.length / 4) / 3;
    U.preset('auto');
    const ra = U.render();
    const oA = U.outputPixels();
    const ts = S.truth(oA.w, oA.h);

    // rotation: 90° clockwise must be the same picture, turned
    U.setOrient({ rot: 1, flip: false });
    const rr = U.render();
    const oR = U.outputPixels();
    let rd = 0, rc = 0;
    for (let y = 0; y < oR.h; y += 3)
      for (let x = 0; x < oR.w; x += 3) {
        const sx = y, sy = oA.h - 1 - x; // CW: rotated (x, y) ← original (y, H-1-x)
        if (sy < 0 || sy >= oA.h || sx >= oA.w) continue;
        const i = (y * oR.w + x) * 4, j = (sy * oA.w + sx) * 4;
        rd += Math.abs(luma(oR.px[i], oR.px[i + 1], oR.px[i + 2]) - luma(oA.px[j], oA.px[j + 1], oA.px[j + 2]));
        rc++;
      }
    out.rot = { sizeBefore: ra.size, sizeAfter: rr.size, diff: rd / rc };
    const exp = await U.exportPhoto('image/jpeg');
    out.rotExport = [exp.w, exp.h];
    U.setOrient({ rot: 0, flip: true });
    U.render();
    const oF = U.outputPixels();
    let fd = 0, fc = 0;
    for (let y = 0; y < oF.h; y += 3)
      for (let x = 0; x < oF.w; x += 3) {
        const i = (y * oF.w + x) * 4, j = (y * oA.w + (oA.w - 1 - x)) * 4;
        fd += Math.abs(luma(oF.px[i], oF.px[i + 1], oF.px[i + 2]) - luma(oA.px[j], oA.px[j + 1], oA.px[j + 2]));
        fc++;
      }
    out.flipDiff = fd / fc;
    U.setOrient({ rot: 0, flip: false });
    U.render();

    // curves
    const lumaAll = (o) => { let a = 0; for (let i = 0; i < o.px.length; i += 4) a += luma(o.px[i], o.px[i + 1], o.px[i + 2]); return a / (o.px.length / 4); };
    const chan = (o, c) => { let a = 0; for (let i = 0; i < o.px.length; i += 4) a += o.px[i + c]; return a / (o.px.length / 4); };
    const base = U.outputPixels();
    const L = [[0, 0], [1, 1]];
    U.setLook({ curves: { rgb: [[0, 0], [0.5, 0.65], [1, 1]], r: L, g: L, b: L } });
    const oC = U.outputPixels();
    U.setLook({ curves: { rgb: L, r: [[0, 0], [0.5, 0.65], [1, 1]], g: L, b: L } });
    const oR2 = U.outputPixels();
    out.curves = {
      luma: [lumaAll(base), lumaAll(oC)],
      r: [chan(base, 0), chan(oR2, 0)], g: [chan(base, 1), chan(oR2, 1)], b: [chan(base, 2), chan(oR2, 2)],
    };
    U.resetLook();

    // HSL: blue saturation −100
    const water = (ti) => !ts.object[ti];
    const coral = (ti) => ts.coral[ti];
    const slate = (ti) => ts.slate[ti];
    const cw0 = meanOver(base, ts, water, chroma), cc0 = meanOver(base, ts, coral, chroma), cs0 = meanOver(base, ts, slate, chroma);
    U.setLook({ hsl: { h: new Array(8).fill(0), s: [0, 0, 0, 0, 0, -100, 0, 0], l: new Array(8).fill(0) } });
    const oH = U.outputPixels();
    out.hsl = { water: [cw0, meanOver(oH, ts, water, chroma)], coral: [cc0, meanOver(oH, ts, coral, chroma)], slate: [cs0, meanOver(oH, ts, slate, chroma)] };
    U.resetLook();

    // 畫質修復 on a noisy, blotchy frame (full resolution preview)
    let seed = 9;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const noisy = S.degrade(t, 'blue', 8);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const n = (rnd() + rnd() + rnd() - 1.5) * 28;
        const cb = 14 * Math.sin(x / 9 + rnd()) * Math.cos(y / 7); // colour blotches
        noisy[i] += n + cb; noisy[i + 1] += n; noisy[i + 2] += n - cb;
      }
    await U.addFiles([await S.toFile(noisy, W, H, 'noisy.png')]);
    U.setView({ mode: 0 });
    U.setPreview(0);
    const grab = () => {
      U.render();
      const c2 = new OffscreenCanvas(W, H);
      const x2 = c2.getContext('2d');
      x2.drawImage(document.getElementById('view'), 0, 0);
      return x2.getImageData(0, 0, W, H).data;
    };
    const energy = (px) => {
      let e = 0, c = 0, ch = 0;
      for (let y = 2; y < H - 2; y += 2)
        for (let x = 2; x < W - 2; x += 2) {
          if (t.object[y * W + x] && !t.coral[y * W + x] && !t.slate[y * W + x]) {
            const i = (y * W + x) * 4;
            let m = 0, mr = 0, mb = 0;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const k = ((y + dy) * W + x + dx) * 4; m += luma(px[k], px[k + 1], px[k + 2]); mr += px[k] - px[k + 1]; mb += px[k + 2] - px[k + 1]; }
            e += Math.abs(luma(px[i], px[i + 1], px[i + 2]) - m / 25);
            ch += Math.abs(px[i] - px[i + 1] - mr / 25) + Math.abs(px[i + 2] - px[i + 1] - mb / 25);
            c++;
          }
        }
      return { luma: e / c, chroma: ch / c };
    };
    const edge = (px) => {
      // luminance step across the white slate's left edge (x = 0.8 W)
      let a = 0, b = 0, c = 0;
      for (let y = Math.floor(0.74 * H); y < Math.floor(0.88 * H); y++) {
        const xi = Math.floor(0.8 * W);
        const i = (y * W + xi + 4) * 4, j = (y * W + xi - 5) * 4;
        a += luma(px[i], px[i + 1], px[i + 2]); b += luma(px[j], px[j + 1], px[j + 2]); c++;
      }
      return (a - b) / c;
    };
    U.setParam('restore', 0); // auto now engages 畫質修復 on grain: baseline is off
    const n0 = grab();
    U.setParam('restore', 0.8);
    const n1 = grab();
    U.setParam('restore', 0);
    out.restore = { before: energy(n0), after: energy(n1), edge: [edge(n0), edge(n1)] };
    U.setPreview(1920);

    // 淺水／陽光 on a sunlit shallow scene with light shafts
    const sun = S.degrade(t, 'blue', 2.5);
    for (let y = 0; y < H * 0.55; y++)
      for (let x = 0; x < W; x++) {
        const ray = Math.max(0, Math.sin((x + y * 0.6) / 40)) ** 8 * (1 - y / (H * 0.55));
        const i = (y * W + x) * 4;
        sun[i] += 70 * ray; sun[i + 1] += 90 * ray; sun[i + 2] += 90 * ray;
      }
    await U.addFiles([await S.toFile(sun, W, H, 'sunny.png')]);
    U.setView({ mode: 0 });
    const blown = (o) => { let b = 0; for (let i = 0; i < o.px.length; i += 4) if (Math.min(o.px[i], o.px[i + 1], o.px[i + 2]) >= 250) b++; return b / (o.px.length / 4); };
    U.preset('auto');
    U.render();
    const sa = U.outputPixels();
    U.preset('sunny');
    const sr = U.render();
    const ss = U.outputPixels();
    const tsun = S.truth(ss.w, ss.h);
    const srcSmall = S.degrade(tsun, 'blue', 2.5);
    out.sunny = {
      uw: sr.stats.underwater,
      blownAuto: blown(sa), blownSunny: blown(ss),
      errSrc: S.chromaError(srcSmall, ss.w, ss.h, tsun).err, errSunny: S.chromaError(ss.px, ss.w, ss.h, tsun).err,
      hl: U.state().params.highlights,
    };
    U.preset('auto');
    await new Promise((r) => setTimeout(r, 50));
    return out;
  });
  check('「原始」 preset shows the source unchanged (GPU)', feat.rawDiff < 1.5, `mean diff ${f3(feat.rawDiff)} / 255`);
  check('rotate 90°: frame turns, content matches', feat.rot.sizeAfter[0] === feat.rot.sizeBefore[1] && feat.rot.sizeAfter[1] === feat.rot.sizeBefore[0] && feat.rot.diff < 8,
    `${feat.rot.sizeBefore.join('×')} → ${feat.rot.sizeAfter.join('×')}, luma diff ${f1(feat.rot.diff)}`);
  check('rotated photo exports rotated at full resolution', feat.rotExport[0] === 500 && feat.rotExport[1] === 800, feat.rotExport.join('×'));
  check('horizontal flip mirrors the frame', feat.flipDiff < 8, `luma diff ${f1(feat.flipDiff)}`);
  check('RGB curve brightens mid-tones', feat.curves.luma[1] > feat.curves.luma[0] + 8, `${f1(feat.curves.luma[0])} → ${f1(feat.curves.luma[1])}`);
  check('R curve moves red only',
    feat.curves.r[1] > feat.curves.r[0] + 8 && Math.abs(feat.curves.g[1] - feat.curves.g[0]) < 1.5 && Math.abs(feat.curves.b[1] - feat.curves.b[0]) < 1.5,
    `R ${f1(feat.curves.r[0])} → ${f1(feat.curves.r[1])}, G ±${f1(Math.abs(feat.curves.g[1] - feat.curves.g[0]))}, B ±${f1(Math.abs(feat.curves.b[1] - feat.curves.b[0]))}`);
  // (a slightly blue-tinted slate may lose that tint too — it must just never gain colour)
  check('HSL 藍 飽和度 −100: water loses its blue, coral untouched, slate not tinted',
    feat.hsl.water[1] < 0.4 * feat.hsl.water[0] && Math.abs(feat.hsl.coral[1] - feat.hsl.coral[0]) < 0.02 && feat.hsl.slate[1] <= feat.hsl.slate[0] + 0.002,
    `water C ${f3(feat.hsl.water[0])} → ${f3(feat.hsl.water[1])}, coral ${f3(feat.hsl.coral[0])} → ${f3(feat.hsl.coral[1])}, slate ${f3(feat.hsl.slate[0])} → ${f3(feat.hsl.slate[1])}`);
  check('畫質修復 removes grain and colour blotches',
    feat.restore.after.luma < 0.65 * feat.restore.before.luma && feat.restore.after.chroma < 0.6 * feat.restore.before.chroma,
    `grain ${f1(feat.restore.before.luma)} → ${f1(feat.restore.after.luma)}, colour noise ${f1(feat.restore.before.chroma)} → ${f1(feat.restore.after.chroma)}`);
  check('畫質修復 keeps edges', feat.restore.edge[1] > 0.8 * feat.restore.edge[0], `slate edge step ${f1(feat.restore.edge[0])} → ${f1(feat.restore.edge[1])}`);
  check('「淺水／陽光」 protects the light shafts and still restores colour',
    feat.sunny.blownSunny <= feat.sunny.blownAuto && feat.sunny.errSunny < 0.6 * feat.sunny.errSrc,
    `blown ${f1(feat.sunny.blownAuto * 100)} % → ${f1(feat.sunny.blownSunny * 100)} %, colour error ${f3(feat.sunny.errSrc)} → ${f3(feat.sunny.errSunny)}`);

  // screenshot of the new controls in use (sunlit scene, S-curve, warmer orange)
  await page.evaluate(() => {
    const U = window.__uw;
    U.preset('sunny');
    U.setLook({
      curves: { rgb: [[0, 0], [0.25, 0.2], [0.75, 0.82], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] },
      hsl: { h: new Array(8).fill(0), s: [0, 30, 0, 0, 0, 0, 0, 0], l: new Array(8).fill(0) },
    });
    U.setView({ mode: 1, split: 0.5 });
    U.render();
    document.getElementById('curvesGroup').open = true;
    document.getElementById('hslGroup').open = true;
    document.querySelectorAll('details.group').forEach((d, i) => { if (i < 5) d.open = false; });
  });
  await page.screenshot({ path: join(OUT, 'studio-controls.png'), fullPage: true });
  await page.evaluate(() => {
    window.__uw.resetLook();
    window.__uw.preset('auto');
    document.querySelectorAll('details.group').forEach((d, i) => { d.open = i < 3; });
  });

  /* ============================================================ light */
  console.log('\n— light: sun beams, surface highlights, control points, auto 畫質修復');
  const light = await page.evaluate(async () => {
    const S = window.__scene, U = window.__uw;
    const W = 1200, H = 750;
    const t = S.truth(W, H);
    await U.addFiles([await S.toFile(S.degrade(t, 'blue', 2.5, 3, { beams: true, surface: true }), W, H, 'sun-beams.png')]);
    U.preset('auto');
    U.setView({ mode: 0 });
    const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const grab = () => {
      U.render();
      const cv = document.getElementById('view');
      const c2 = new OffscreenCanvas(cv.width, cv.height);
      const x2 = c2.getContext('2d');
      x2.drawImage(cv, 0, 0);
      return { w: cv.width, h: cv.height, px: x2.getImageData(0, 0, cv.width, cv.height).data };
    };
    // the scene's own beam geometry (verify-scene.js): source (0.7, −0.4)
    const rayAt = (u, v, aspect) => Math.max(0, Math.sin(Math.atan2((u - 0.7) * aspect, v + 0.4) * 26 + 1.3)) ** 6 * Math.max(0, 1 - v / 0.75);
    const beamContrast = (o) => {
      let a = 0, na = 0, b = 0, nb = 0;
      for (let y = Math.floor(0.16 * o.h); y < 0.45 * o.h; y += 2)
        for (let x = 0; x < o.w; x += 2) {
          const u = x / o.w, v = y / o.h;
          if (t.object[Math.floor(v * H) * W + Math.floor(u * W)]) continue;
          const r = rayAt(u, v, o.w / o.h), i = (y * o.w + x) * 4, L = luma(o.px[i], o.px[i + 1], o.px[i + 2]);
          if (r > 0.5) { a += L; na++; } else if (r < 0.02) { b += L; nb++; }
        }
      return a / na - b / nb;
    };
    const band = (o, v0, v1) => {
      let blown = 0, L = 0, n = 0;
      for (let y = Math.floor(v0 * o.h); y < v1 * o.h; y++)
        for (let x = 0; x < o.w; x++) {
          const i = (y * o.w + x) * 4;
          if (Math.min(o.px[i], o.px[i + 1], o.px[i + 2]) >= 250) blown++;
          L += luma(o.px[i], o.px[i + 1], o.px[i + 2]); n++;
        }
      return { blown: blown / n, L: L / n };
    };
    const r0 = U.render();
    const auto = { presence: r0.stats.beamPresence, surf: r0.stats.surfacePresence, eff: r0.effective, noise: r0.stats.noise };
    const oAuto = grab();
    // beams: off / enhanced / suppressed, source where the scene has it
    U.setParam('beamX', 0.7); U.setParam('beamY', -0.4);
    U.setParam('beams', 0); const oOff = grab();
    U.setParam('beams', 0.8); const oOn = grab();
    U.setParam('beams', -0.8); const oSup = grab();
    // wrong source: enhancing toward a point far to the left helps the beams less
    U.setParam('beamX', -1.2); U.setParam('beamY', 0.2); U.setParam('beams', 0.8); const oWrong = grab();
    U.preset('auto');
    // surface highlights: off vs full recovery
    U.setParam('surfaceHL', 0); const sOff = grab();
    U.setParam('surfaceHL', 1); const sOn = grab();
    U.preset('auto');
    const vivid0 = U.vividState();
    document.getElementById('vivid').click();
    const vivid1 = U.vividState();
    document.getElementById('vivid').click();
    const vivid2 = U.vividState();
    const cv = document.getElementById('view').getBoundingClientRect();
    return {
      auto,
      beams: { auto: beamContrast(oAuto), off: beamContrast(oOff), on: beamContrast(oOn), sup: beamContrast(oSup), wrong: beamContrast(oWrong) },
      surface: { off: band(sOff, 0, 0.1), on: band(sOn, 0, 0.1), lowOff: band(sOff, 0.6, 1), lowOn: band(sOn, 0.6, 1) },
      vivid: [vivid0, vivid1, vivid2],
      canvas: { x: cv.left, y: cv.top, w: cv.width, h: cv.height },
    };
  });
  const L = light;
  check('auto detects sun beams and a bright surface', L.auto.presence > 0.3 && L.auto.surf > 0.3 && L.auto.eff.surfaceHL > 0.15,
    `beam presence ${f3(L.auto.presence)}, surface ${f3(L.auto.surf)} → 水面高光壓制 ${f3(L.auto.eff.surfaceHL)}`);
  check('auto places the beam source above the frame, near the true one (0.70, −0.40)',
    Math.abs(L.auto.eff.beamX - 0.7) < 0.35 && L.auto.eff.beamY < 0 && L.auto.eff.beamY > -1.2,
    `(${f3(L.auto.eff.beamX)}, ${f3(L.auto.eff.beamY)})`);
  check('☀ 光束 + enhances the beams, − suppresses them',
    L.beams.on > L.beams.off * 1.15 && L.beams.sup < L.beams.off * 0.85,
    `beam − gap luma: off ${f1(L.beams.off)}, +0.8 ${f1(L.beams.on)}, −0.8 ${f1(L.beams.sup)} (auto ${f1(L.beams.auto)})`);
  check('beam source position matters (true source > wrong source)', L.beams.on > L.beams.wrong,
    `at (0.7, −0.4) ${f1(L.beams.on)} vs at (−1.2, 0.2) ${f1(L.beams.wrong)}`);
  check('水面高光壓制 recovers the clipped surface, leaves the lower frame alone',
    L.surface.on.blown < 0.5 * L.surface.off.blown && L.surface.on.L < L.surface.off.L && Math.abs(L.surface.lowOn.L - L.surface.lowOff.L) < 1,
    `blown in top band ${f1(L.surface.off.blown * 100)} % → ${f1(L.surface.on.blown * 100)} %, lower frame Δ ${f1(Math.abs(L.surface.lowOn.L - L.surface.lowOff.L))}`);
  check('✨ 豐富色彩 button: press locks a strong dose, press again hands back to auto',
    !L.vivid[0].pressed && L.vivid[1].pressed && L.vivid[1].locked && L.vivid[1].value >= 0.7 && !L.vivid[2].pressed && !L.vivid[2].locked,
    L.vivid.map((v) => `${v.pressed ? 'on' : 'off'}${v.locked ? '/locked' : ''}`).join(' → '));

  // control points: drag the ☀ handle and the surface B handle with the mouse
  const pts0 = await page.evaluate(() => window.__uw.showLightPoints(true));
  const cvr = L.canvas;
  const to = (u, v) => [cvr.x + u * cvr.w, cvr.y + v * cvr.h];
  const drag = async (from, [x, y]) => {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    await page.mouse.move((from[0] + x) / 2, (from[1] + y) / 2, { steps: 4 });
    await page.mouse.move(x, y, { steps: 4 });
    await page.mouse.up();
  };
  const before = await page.evaluate(() => window.__uw.render().out);
  await drag(pts0.beam, to(0.25, 0.05));
  const pts1 = await page.evaluate(() => window.__uw.showLightPoints(true));
  await drag(pts1.surfB, to(0.5, 0.45));
  const lp = await page.evaluate(() => ({ lp: window.__uw.lightPoints(), out: window.__uw.render().out }));
  check('dragging ☀ moves the beam source and locks it',
    Math.abs(lp.lp.beam[0] - 0.25) < 0.03 && Math.abs(lp.lp.beam[1] - 0.05) < 0.03 && lp.lp.locked.includes('beamX') && lp.lp.locked.includes('beamY'),
    `(${f3(lp.lp.beam[0])}, ${f3(lp.lp.beam[1])}), locked ${lp.lp.locked.join(',')}`);
  check('dragging B moves the surface gradient end', Math.abs(lp.lp.surfB[1] - 0.45) < 0.03 && lp.lp.locked.includes('surfBy'),
    `B (${f3(lp.lp.surfB[0])}, ${f3(lp.lp.surfB[1])})`);
  check('moving the control points changes the picture', Math.abs(lp.out.r - before.r) + Math.abs(lp.out.g - before.g) + Math.abs(lp.out.b - before.b) > 0.5,
    `mean RGB ${[before.r, before.g, before.b].map(f1).join('/')} → ${[lp.out.r, lp.out.g, lp.out.b].map(f1).join('/')}`);
  await page.evaluate(() => {
    window.__uw.setView({ mode: 1, split: 0.5 });
    window.__uw.render();
  });
  await page.screenshot({ path: join(OUT, 'studio-light.png') });
  const released = await page.evaluate(() => {
    document.querySelector('.lp-bar button').click();
    const r = window.__uw.lightPoints();
    window.__uw.showLightPoints(false);
    window.__uw.preset('auto');
    return r.locked;
  });
  check('自動定位 hands every control point back to auto', released.length === 0, released.length ? released.join(',') : 'all auto');

  // auto 畫質修復: engages on grain, stays off on a clean frame
  const grain = await page.evaluate(async () => {
    const S = window.__scene, U = window.__uw;
    const W = 1200, H = 750;
    const t = S.truth(W, H);
    await U.addFiles([await S.toFile(S.degrade(t, 'blue', 8, 3, { noise: 10 }), W, H, 'grainy.png')]);
    U.preset('auto');
    const a = U.render();
    await U.addFiles([await S.toFile(S.degrade(t, 'blue', 8), W, H, 'clean.png')]);
    const b = U.render();
    return { noisy: { sigma: a.stats.noise, restore: a.effective.restore, sharpen: a.effective.sharpen }, clean: { sigma: b.stats.noise, restore: b.effective.restore, sharpen: b.effective.sharpen } };
  });
  check('auto 畫質修復 engages on grain, stays off on a clean frame',
    grain.noisy.restore > 0.3 && grain.clean.restore < 0.1 && grain.noisy.sigma > grain.clean.sigma + 3,
    `σ ${f1(grain.clean.sigma)} → restore ${f3(grain.clean.restore)}; σ ${f1(grain.noisy.sigma)} → restore ${f3(grain.noisy.restore)}`);
  check('auto sharpening backs off on grain', grain.noisy.sharpen < grain.clean.sharpen,
    `sharpen ${f3(grain.clean.sharpen)} (clean) vs ${f3(grain.noisy.sharpen)} (grainy)`);

  /* ============================================================ video */
  console.log('\n— imported profiles: 全自動-bornfree / nikolajbech / T77701 / warplab');
  {
    const NAMES = ['全自動-bornfree', '全自動-nikolajbech', '全自動-T77701', '全自動-warplab'];
    const prof = await page.evaluate(async (NAMES) => {
      const U = window.__uw;
      const S = window.__scene;
      const mean = (o) => { let r = 0, g = 0, b = 0, n = 0; for (let i = 0; i < o.px.length; i += 4) { r += o.px[i]; g += o.px[i + 1]; b += o.px[i + 2]; n++; } return [r / n, g / n, b / n]; };
      const W = 900, H = 600;
      const t = S.truth(W, H);
      await U.addFiles([await S.toFile(S.degrade(t, 'blue', 9), W, H, 'profiles.png')]);
      U.setView({ mode: 0 });
      U.preset('auto');
      const ra = U.render();
      const oa = U.outputPixels();
      const ts = S.truth(oa.w, oa.h);
      const srcErr = S.chromaError(S.degrade(ts, 'blue', 9), oa.w, oa.h, ts).err;
      const base = mean(oa);
      const seen = {}, err = {}, amt = {}, eff = {};
      for (const name of NAMES) {
        U.preset(name);
        const r = U.render();
        const o = U.outputPixels();
        seen[name] = mean(o);
        err[name] = S.chromaError(o.px, o.w, o.h, ts).err;
        amt[name] = r.profile;
        eff[name] = { redComp: r.effective.redComp, wbStrength: r.effective.wbStrength, deCast: r.effective.deCast };
      }
      // switching profiles resets rather than accumulates
      U.preset('全自動-nikolajbech'); U.render();
      const once = mean(U.outputPixels());
      for (const n of NAMES) { U.preset(n); U.render(); }
      U.preset('全自動-nikolajbech'); U.render();
      const twice = mean(U.outputPixels());
      U.preset('auto');
      U.render();
      return { src: [ra.src.r, ra.src.g, ra.src.b], base, seen, err, amt, eff, srcErr, autoErr: S.chromaError(oa.px, oa.w, oa.h, ts).err, once, twice };
    }, NAMES);
    const d = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    console.log(`  source r=${f1(prof.src[0])} g=${f1(prof.src[1])} b=${f1(prof.src[2])} · auto r=${f1(prof.base[0])} g=${f1(prof.base[1])} b=${f1(prof.base[2])}`);
    const own = { '全自動-bornfree': 'mix', '全自動-nikolajbech': 'mix', '全自動-T77701': 'pull', '全自動-warplab': 'phys' };
    for (const name of NAMES) {
      const a = prof.amt[name];
      const on = Object.entries(a).filter(([, v]) => v > 0.0001).map(([k]) => k);
      check(`${name}: its own method is applied (and only it)`, on.length === 1 && on[0] === own[name] && a[own[name]] > 0.3,
        `mix ${f3(a.mix)} / pull ${f3(a.pull)} / phys ${f3(a.phys)}`);
      check(`${name}: replaces the engine colour correction and beats the source`,
        prof.eff[name].redComp === 0 && prof.eff[name].wbStrength === 0 && prof.eff[name].deCast === 0 && prof.err[name] < prof.srcErr,
        `colour error ${f3(prof.srcErr)} → ${f3(prof.err[name])} (全自動 ${f3(prof.autoErr)}); r=${f1(prof.seen[name][0])} g=${f1(prof.seen[name][1])} b=${f1(prof.seen[name][2])}`);
      check(`${name}: red recovered over the SOURCE`, prof.seen[name][0] > prof.src[0] + 20, `${f1(prof.src[0])} → ${f1(prof.seen[name][0])}`);
    }
    check('bornfree and nikolajbech differ (different analysis grid)',
      d(prof.seen['全自動-bornfree'], prof.seen['全自動-nikolajbech']) > 0.05,
      `Δ${f3(d(prof.seen['全自動-bornfree'], prof.seen['全自動-nikolajbech']))}`);
    const drift = d(prof.once, prof.twice);
    check('profiles do not stack when switched', drift < 0.6, `drift ${f3(drift)}`);
  }

  console.log('\n— video: 5 s clip — pan + descent in blue water, cut to green water at 3.0 s');
  const clip = await page.evaluate(async () => {
    const S = window.__scene;
    const mod = await window.__uw.loadExport();
    const W = 640, H = 360, FPS = 30, N = 150;
    const cv = new OffscreenCanvas(W, H);
    const cx = cv.getContext('2d');
    const tBlue = S.truth(W, H, 0, 7);
    const tGreen = S.truth(W, H, 0.3, 11);
    const blob = await mod.encodeCanvasClip(cv, N, FPS, (i) => {
      let rgba;
      if (i < 90) {
        const t = S.truth(W, H, i * 0.004, 7); // camera pans right
        rgba = S.degrade(t, 'blue', 5 + (i / 90) * 9, i); // and descends 5 → 14 m
      } else {
        rgba = S.degrade(tGreen, 'green', 6, i);
      }
      cx.putImageData(new ImageData(rgba, W, H), 0, 0);
    });
    void tBlue;
    const file = new File([blob], 'dive.webm', { type: 'video/webm' });
    await window.__uw.addFiles([file]);
    await new Promise((r) => setTimeout(r, 300));
    const r = window.__uw.render();
    return { size: blob.size, r };
  });
  check('test clip encoded (VP9 WebM)', clip.size > 10000, `${(clip.size / 1024).toFixed(0)} KB`);
  check('video first frame analysed', clip.r.stats.water === 'blue' && clip.r.stats.underwater > 0.5, `${clip.r.stats.water} ${f3(clip.r.stats.underwater)}`);
  await page.screenshot({ path: join(OUT, 'studio-video.png') });

  // Real playback: slow the clip down so the software GPU sees most frames.
  const play = await page.evaluate(() => window.__uw.playThrough(90000, 0.25));
  const tr = play.trace;
  const blue = tr.filter((s) => s.t > 0.3 && s.t < 2.9);
  const green = tr.filter((s) => s.t > 3.3);
  const cuts = tr.filter((s) => s.cut).map((s) => s.t);
  let maxStep = 0;
  for (let i = 1; i < blue.length; i++) maxStep = Math.max(maxStep, Math.abs(blue[i].illumR - blue[i - 1].illumR));
  const avgMs = tr.reduce((a, s) => a + s.ms, 0) / Math.max(1, tr.length);
  check('live playback processes frames', tr.length >= 20, `${tr.length} frames sampled, ${f1(avgMs)} ms/frame (SwiftShader)`);
  // The clip descends 5 → 14 m: red light fades, so the estimated illuminant's
  // red must fall steadily (the synthetic camera auto-exposes, so brightness
  // is not the signal here — colour is).
  // (red compensation runs first, so the illuminant keeps only the red deficit
  // it leaves: the drop is small but must be steady)
  let falls = 0;
  for (let i = 1; i < blue.length; i++) if (blue[i].illumR <= blue[i - 1].illumR + 1e-4) falls++;
  check(
    'auto white balance tracks the descent (illuminant red falls steadily)',
    blue.length > 5 && blue[blue.length - 1].illumR < blue[0].illumR - 0.02 && falls >= 0.9 * (blue.length - 1),
    `illum R ${f3(blue[0]?.illumR)} → ${f3(blue[blue.length - 1]?.illumR)}, falling in ${falls}/${blue.length - 1} steps`,
  );
  check('tracking is smooth within a scene (no jumps)', maxStep < 0.03, `max step ${f3(maxStep)} per sample`);
  const falseCuts = [...new Set(cuts.filter((t) => t < 2.7 || t > 3.6).map((t) => t.toFixed(1)))];
  check('no false scene cuts during the pan/descent', falseCuts.length === 0, falseCuts.length ? `false cuts at ${falseCuts.join(', ')} s` : 'none');
  check('scene cut detected at the blue→green cut', cuts.some((t) => t > 2.7 && t < 3.6), `cut at ${[...new Set(cuts.map(f1))].join(', ') || 'none'} s`);
  check(
    'after the cut: green water recognised, blue compensation on',
    green.length > 3 && green.every((s) => s.water === 'green') && green[green.length - 1].blueComp > 0.2,
    `blueComp ${f3(blue[blue.length - 1]?.blueComp ?? 0)} → ${f3(green[green.length - 1]?.blueComp ?? 0)}`,
  );

  const vexp = await page.evaluate(() => window.__uw.exportVideo({ maxEdge: 640, format: 'webm' }));
  check('video export completes, frame-exact', !vexp.canceled && vexp.frames === 150 && vexp.probe?.frames === 150, `${vexp.frames} frames processed, ${vexp.probe?.frames} in file`);
  check('export codec & size', vexp.codec === 'vp9' && vexp.probe.width === 640 && vexp.probe.height === 360, `${vexp.codec} ${vexp.probe.width}×${vexp.probe.height} ${(vexp.size / 1024).toFixed(0)} KB in ${f1(vexp.ms / 1000)} s`);
  const vf = await page.evaluate(async () => {
    const S = window.__scene;
    // true scene of each frame (the sand makes the truth itself yellowish)
    const mean = (px) => { let r = 0, g = 0, b = 0; for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; } const n = px.length / 4; return { r: r / n, g: g / n, b: b / n }; };
    return {
      blue: await window.__uw.exportedFrameStats(1.5),
      green: await window.__uw.exportedFrameStats(4.2),
      truthBlue: mean(S.clean(S.truth(320, 180, 45 * 0.004, 7))),
      truthGreen: mean(S.clean(S.truth(320, 180, 0.3, 11))),
    };
  });
  const gcast = (s) => s.g - (s.r + s.b) / 2;
  check('exported blue-water frame corrected (> 70 % of the way to truth)',
    Math.abs(cast(vf.blue.out) - cast(vf.truthBlue)) < 0.3 * Math.abs(cast(vf.blue.src) - cast(vf.truthBlue)),
    `blue cast ${f1(cast(vf.blue.src))} → ${f1(cast(vf.blue.out))} (truth ${f1(cast(vf.truthBlue))})`);
  check('exported green-water frame corrected (> 70 % of the way to truth)',
    Math.abs(gcast(vf.green.out) - gcast(vf.truthGreen)) < 0.3 * Math.abs(gcast(vf.green.src) - gcast(vf.truthGreen)),
    `green cast ${f1(gcast(vf.green.src))} → ${f1(gcast(vf.green.out))} (truth ${f1(gcast(vf.truthGreen))})`);

  // speed + rotation in the exporter, and the preview speed control
  const spd = await page.evaluate(async () => {
    const U = window.__uw;
    const sel = document.getElementById('playRate');
    sel.value = '0.5';
    sel.dispatchEvent(new Event('change'));
    const rate = U.videoRate();
    sel.value = '1';
    sel.dispatchEvent(new Event('change'));
    U.setOrient({ rot: 1, flip: false });
    const fast = await U.exportVideo({ maxEdge: 640, format: 'webm', speed: 2 });
    U.setOrient({ rot: 0, flip: false });
    const slow = await U.exportVideo({ maxEdge: 640, format: 'webm', speed: 0.5 });
    return { rate, fast: fast.probe, slow: slow.probe };
  });
  check('preview playback speed control', spd.rate === 0.5, `playbackRate ${spd.rate}`);
  check('2× export: half the length, source frame rate kept, rotated',
    Math.abs(spd.fast.duration - 2.5) < 0.2 && Math.abs(spd.fast.frames - 75) <= 2 && spd.fast.width === 360 && spd.fast.height === 640,
    `${f1(spd.fast.duration)} s, ${spd.fast.frames} frames, ${spd.fast.width}×${spd.fast.height}`);
  check('0.5× export: slow motion, every frame kept', Math.abs(spd.slow.duration - 10) < 0.3 && spd.slow.frames === 150,
    `${f1(spd.slow.duration)} s, ${spd.slow.frames} frames`);

  /* ============================================================ layout */
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await mobile.addInitScript({ path: join(root, 'scripts/verify-scene.js') });
  await mobile.goto(BASE);
  await mobile.waitForFunction(() => !!window.__uw);
  const mob = await mobile.evaluate(async () => {
    const S = window.__scene;
    const t = S.truth(900, 600);
    await window.__uw.addFiles([await S.toFile(S.degrade(t, 'blue', 8), 900, 600, 'm.png')]);
    window.__uw.render();
    return { scroll: document.documentElement.scrollWidth, inner: window.innerWidth };
  });
  await mobile.screenshot({ path: join(OUT, 'studio-mobile.png') });
  check('phone layout has no horizontal scroll', mob.scroll <= mob.inner, `${mob.scroll} ≤ ${mob.inner}`);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  writeFileSync(join(OUT, 'video-trace.json'), JSON.stringify(play, null, 1));
} catch (err) {
  console.error(err);
  failures++;
}

console.log(failures ? `\n${failures} FAILED` : '\nall verification checks passed');
await done(failures ? 1 : 0);
