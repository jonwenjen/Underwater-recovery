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
  check('豐富色彩: surface colour richer on the GPU (chroma +30 %)', vivid.on.C > vivid.off.C * 1.3, `OKLab C ${f3(vivid.off.C)} → ${f3(vivid.on.C)} (truth 0.077)`);
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

  /* ============================================================ video */
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
  check(
    'auto white balance tracks the descent (illuminant red falls)',
    blue.length > 5 && blue[blue.length - 1].illumR < blue[0].illumR - 0.03,
    `illum R ${f3(blue[0]?.illumR)} → ${f3(blue[blue.length - 1]?.illumR)}`,
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
  const vf = await page.evaluate(async () => ({ blue: await window.__uw.exportedFrameStats(1.5), green: await window.__uw.exportedFrameStats(4.2) }));
  const gcast = (s) => s.g - (s.r + s.b) / 2;
  check('exported blue-water frame corrected', Math.abs(cast(vf.blue.out)) < 0.3 * cast(vf.blue.src), `blue cast ${f1(cast(vf.blue.src))} → ${f1(cast(vf.blue.out))}`);
  check('exported green-water frame corrected', Math.abs(gcast(vf.green.out)) < 0.3 * gcast(vf.green.src), `green cast ${f1(gcast(vf.green.src))} → ${f1(gcast(vf.green.out))}`);

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
