/**
 * Engine unit tests — run in plain Node, no browser:
 *   node --experimental-strip-types test/engine.test.ts
 *
 * Covers the colour math, LUT builders, auto analysis and the temporal
 * tracker, plus end-to-end recovery goals on the CPU mirror of the shader.
 */
import { ANALYSIS_EDGE, AutoEngine, gamutFit, mirrorRender, type FrameState } from '../src/engine/auto.ts';
import { apply3, boostChroma, luma, srgbToLinear, toOklab, whiteBalanceMatrix, type Vec3 } from '../src/engine/color.ts';
import { guidedCoefficients } from '../src/engine/filters.ts';
import { buildClahe, buildCurve, sampleCurve } from '../src/engine/luts.ts';
import { DEFAULT_PARAMS, type AutoKey, type Params } from '../src/engine/params.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/* ------------------------------------------------------------ fixtures */

const W = 256,
  H = 144;

/** Coral on the left, blue-green veil increasing with depth (y). */
function underwater(tint: 'blue' | 'green' = 'blue', shift = 0): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const depth = y / H;
      const tex = 22 * Math.sin((x + shift) / 5) * Math.cos(y / 7);
      const subject = x + shift < W * 0.4 ? 160 : 30;
      let r = (subject + tex) * (1 - depth * 0.8);
      let g = (95 + tex) * (1 - depth * 0.4);
      let b = (75 + tex) * (1 + depth * 0.4);
      if (tint === 'blue') {
        r += 15 + depth * 20;
        g += 55 + depth * 40;
        b += 90 + depth * 60;
      } else {
        r += 15 + depth * 20;
        g += 90 + depth * 60;
        b += 45 + depth * 25;
      }
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  return d;
}

function grey(): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = 90 + 70 * Math.sin(i / 300) * Math.cos(i / 1700);
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  return d;
}

function stats8(d: Uint8ClampedArray) {
  let r = 0, g = 0, b = 0, l = 0, l2 = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i]; g += d[i + 1]; b += d[i + 2];
    const y = luma(d[i], d[i + 1], d[i + 2]);
    l += y; l2 += y * y;
  }
  return { r: r / n, g: g / n, b: b / n, contrast: Math.sqrt(l2 / n - (l / n) ** 2) };
}
function statsF(o: Float32Array) {
  let r = 0, g = 0, b = 0, l = 0, l2 = 0;
  const n = o.length / 3;
  for (let q = 0; q < o.length; q += 3) {
    r += o[q] * 255; g += o[q + 1] * 255; b += o[q + 2] * 255;
    const y = luma(o[q], o[q + 1], o[q + 2]) * 255;
    l += y; l2 += y * y;
  }
  return { r: r / n, g: g / n, b: b / n, contrast: Math.sqrt(l2 / n - (l / n) ** 2) };
}

const none = new Set<AutoKey>();
const run = (img: Uint8ClampedArray, params: Params = DEFAULT_PARAMS, eng = new AutoEngine()): FrameState =>
  eng.step(img, W, H, { params, locked: none, dt: 0 });

/* ------------------------------------------------------------ colour math */

{
  const ill: Vec3 = [0.35, 1.05, 1.6];
  const m = whiteBalanceMatrix(ill, 0, 0);
  const out = apply3(m, ill);
  const y = luma(ill[0], ill[1], ill[2]);
  check(
    'Bradford WB maps the illuminant to a neutral of equal luminance',
    near(out[0], y, 1e-3) && near(out[1], y, 1e-3) && near(out[2], y, 1e-3),
    out.map((v) => v.toFixed(4)).join(','),
  );
  const id = whiteBalanceMatrix([1, 1, 1], 0, 0);
  check('WB of a neutral illuminant is the identity', id.every((v, i) => near(v, i % 4 === 0 ? 1 : 0, 1e-3)));
  const warm = apply3(whiteBalanceMatrix([1, 1, 1], 0.5, 0), [0.5, 0.5, 0.5]);
  check('temp > 0 warms (R up, B down) at constant luminance',
    warm[0] > 0.5 && warm[2] < 0.5 && near(luma(...warm), 0.5, 1e-3));
}

/* ------------------------------------------------------------ LUTs */

{
  const c = buildCurve({ blacks: 0, whites: 1, contrast: 0, highlights: 0, shadows: 0 });
  let maxErr = 0;
  for (let i = 0; i <= 100; i++) maxErr = Math.max(maxErr, Math.abs(sampleCurve(c, i / 100) - i / 100));
  check('neutral tone curve is the identity', maxErr < 1e-3, `max err ${maxErr.toExponential(1)}`);
  let mono = true;
  for (const contrast of [-1, 1]) for (const hl of [-1, 1]) for (const sh of [-1, 1]) {
    const k = buildCurve({ blacks: 0.1, whites: 0.8, contrast, highlights: hl, shadows: sh });
    for (let i = 1; i < k.length; i++) if (k[i] < k[i - 1]) mono = false;
  }
  check('tone curve monotonic at every slider extreme', mono);

  const L = new Float32Array(64 * 64);
  for (let i = 0; i < L.length; i++) L[i] = 0.4 + 0.05 * Math.sin(i / 3);
  const lut = buildClahe(L, 64, 64, 4, 3);
  let lmono = true;
  for (let t = 0; t < 16; t++) for (let b = 1; b < 256; b++) if (lut[t * 256 + b] < lut[t * 256 + b - 1]) lmono = false;
  check('CLAHE maps are monotonic', lmono);
  const lo = lut[Math.round(0.36 * 255)], hi = lut[Math.round(0.44 * 255)];
  check('CLAHE stretches a compressed range', hi - lo > 0.2, `0.36→${lo.toFixed(2)} 0.44→${hi.toFixed(2)}`);
}

{
  // guided filter: a constant input comes back unchanged
  const n = 32 * 32;
  const I = new Float32Array(n).map((_, i) => (i % 7) / 7);
  const p = new Float32Array(n).fill(0.6);
  const { a, b } = guidedCoefficients(I, p, 32, 32, 3, 1e-3);
  let err = 0;
  for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(a[i] * I[i] + b[i] - 0.6));
  check('guided filter preserves a constant map', err < 1e-5);
}

/* ------------------------------------------------------------ recovery goals */

{
  const src = underwater('blue');
  const s = run(src);
  const before = stats8(src);
  const after = statsF(mirrorRender(src, W, H, s));
  const cast = (x: { r: number; g: number; b: number }) => x.b - (x.r + x.g) / 2;
  console.log('  blue water  before', fmt(before), '\n              after ', fmt(after));
  check('detects underwater (blue)', s.stats.underwater > 0.6 && s.stats.water === 'blue',
    `score ${s.stats.underwater.toFixed(2)} ${s.stats.water}`);
  // ≥ 75 % rather than ~0: open water intentionally keeps some blue (水色保留)
  check('blue cast removed (≥ 75 %)', Math.abs(cast(after)) < 0.25 * cast(before) && cast(before) > 40,
    `${cast(before).toFixed(1)} → ${cast(after).toFixed(1)}`);
  check('red recovered (up ≥ 1.3× and back in balance with green)',
    after.r > before.r * 1.3 && after.r / after.g > 0.8,
    `${before.r.toFixed(1)} → ${after.r.toFixed(1)}, r/g ${(before.r / before.g).toFixed(2)} → ${(after.r / after.g).toFixed(2)}`);
  check('contrast increased', after.contrast > before.contrast * 1.3,
    `${before.contrast.toFixed(1)} → ${after.contrast.toFixed(1)}`);
  check('dehaze engaged', s.dehazeOn && s.stats.haze > 0.1, `haze ${s.stats.haze.toFixed(2)}`);
}
{
  const src = underwater('green');
  const s = run(src);
  const before = stats8(src);
  const after = statsF(mirrorRender(src, W, H, s));
  const gcast = (x: { r: number; g: number; b: number }) => x.g - (x.r + x.b) / 2;
  console.log('  green water before', fmt(before), '\n              after ', fmt(after));
  check('detects green water', s.stats.water === 'green', s.stats.water);
  check('blue compensation engages for green water', s.aB > 0.2, `aB ${s.aB.toFixed(2)}`);
  check('green cast removed', Math.abs(gcast(after)) < 15, `${gcast(before).toFixed(1)} → ${gcast(after).toFixed(1)}`);
}
{
  const src = grey();
  const s = run(src);
  const after = statsF(mirrorRender(src, W, H, s));
  check('neutral grey not flagged underwater', s.stats.underwater < 0.3, `score ${s.stats.underwater.toFixed(2)}`);
  check('neutral grey stays neutral', Math.abs(after.r - after.b) < 3 && Math.abs(after.g - after.b) < 3, fmt(after));
  check('non-underwater frame gets only light dehaze', s.effective.dehaze < 0.4, `dehaze ${s.effective.dehaze.toFixed(2)}`);
}

/* ------------------------------------------------------------ manual & tracking */

{
  const src = underwater('blue');
  const locked = new Set<AutoKey>(['redComp']);
  const s = new AutoEngine().step(src, W, H, { params: { ...DEFAULT_PARAMS, redComp: 0 }, locked, dt: 0 });
  check('locked slider overrides auto', s.aR === 0 && s.effective.redComp === 0);
  const s2 = new AutoEngine().step(src, W, H, { params: { ...DEFAULT_PARAMS, auto: false, dehaze: 0 }, locked: none, dt: 0 });
  check('master auto off uses manual values', !s2.dehazeOn && s2.effective.dehaze === 0);
}
{
  // Temporal smoothing: after a slow drift the estimate lags, after a cut it snaps.
  const eng = new AutoEngine();
  const p = { ...DEFAULT_PARAMS, response: 1 };
  const blue = underwater('blue');
  eng.step(blue, W, H, { params: p, locked: none, dt: 0 });
  // a small pan (shifted texture) must not register as a cut
  const pan = eng.step(underwater('blue', 6), W, H, { params: p, locked: none, dt: 1 / 30 });
  check('camera pan is not a scene cut', !pan.stats.sceneCut);
  const e0 = pan.effective.exposure;
  // brighter frame of the same scene: the gain should move, but only part-way
  const bright = underwater('blue', 6).map((v, i) => (i % 4 === 3 ? v : Math.min(255, v * 1.1)));
  const target = new AutoEngine().step(bright, W, H, { params: p, locked: none, dt: 0 }).effective.exposure;
  const s1 = eng.step(bright, W, H, { params: p, locked: none, dt: 1 / 30 });
  check('10% brightness change is not a scene cut', !s1.stats.sceneCut);
  const moved = (s1.effective.exposure - e0) / (target - e0);
  check('auto exposure glides (EMA), not jumps', moved > 0.005 && moved < 0.1, `moved ${(moved * 100).toFixed(1)}% in 1 frame`);
  let s = s1;
  for (let f = 0; f < 150; f++) s = eng.step(bright, W, H, { params: p, locked: none, dt: 1 / 30 });
  check('auto exposure converges after 5 s', near(s.effective.exposure, target, 0.02),
    `${s.effective.exposure.toFixed(3)} vs ${target.toFixed(3)}`);
  const cut = eng.step(underwater('green'), W, H, { params: p, locked: none, dt: 1 / 30 });
  const fresh = new AutoEngine().step(underwater('green'), W, H, { params: p, locked: none, dt: 0 });
  check('scene cut detected and snapped', cut.stats.sceneCut && near(cut.aB, fresh.aB, 1e-6), `aB ${cut.aB.toFixed(3)}`);
}
{
  const eng = new AutoEngine();
  const src = underwater('blue');
  eng.step(src, W, H, { params: DEFAULT_PARAMS, locked: none, dt: 0 });
  eng.pickAt(0.8, 0.9); // deep water, far right
  const s = eng.step(src, W, H, { params: DEFAULT_PARAMS, locked: none, dt: 0 });
  check('eyedropper sets the illuminant', !!eng.pick && s.stats.illum[2] > s.stats.illum[0],
    s.stats.illum.map((v) => v.toFixed(2)).join(','));
}
{
  // at the size the renderer actually analyses (ANALYSIS_EDGE on the long side)
  const aw = ANALYSIS_EDGE, ah = Math.round((ANALYSIS_EDGE * 9) / 16);
  const img = new Uint8ClampedArray(aw * ah * 4);
  const big = underwater('blue');
  for (let y = 0; y < ah; y++)
    for (let x = 0; x < aw; x++) {
      const s = (Math.floor((y * H) / ah) * W + Math.floor((x * W) / aw)) * 4, d = (y * aw + x) * 4;
      img[d] = big[s]; img[d + 1] = big[s + 1]; img[d + 2] = big[s + 2]; img[d + 3] = 255;
    }
  const eng = new AutoEngine();
  for (let i = 0; i < 15; i++) eng.step(img, aw, ah, { params: DEFAULT_PARAMS, locked: none, dt: 1 / 30 }); // JIT warm-up
  const t0 = performance.now();
  for (let i = 0; i < 30; i++) eng.step(img, aw, ah, { params: DEFAULT_PARAMS, locked: none, dt: 1 / 30 });
  const ms = (performance.now() - t0) / 30;
  check(`analysis fits a real-time budget (< 25 ms / frame at ${aw}×${ah})`, ms < 25, `${ms.toFixed(1)} ms`);
}

/* ------------------------------------------------------------ 豐富色彩 */

{
  const meanChroma = (o: Float32Array) => {
    let c = 0, l = 0;
    const n = o.length / 3;
    for (let q = 0; q < o.length; q += 3) {
      const lab = toOklab(srgbToLinear(o[q]), srgbToLinear(o[q + 1]), srgbToLinear(o[q + 2]));
      c += Math.hypot(lab[1], lab[2]);
      l += lab[0];
    }
    return { C: c / n, L: l / n };
  };
  const src = underwater('blue');
  const off = run(src);
  const on = run(src, { ...DEFAULT_PARAMS, vivid: 0.7 });
  const a = meanChroma(mirrorRender(src, W, H, off)), b = meanChroma(mirrorRender(src, W, H, on));
  check('default leaves 豐富色彩 off (gain exactly 1)', off.chromaGain === 1 && off.warmGain === 0);
  check('豐富色彩 enriches colour (chroma +30 %)', b.C > a.C * 1.3, `C ${a.C.toFixed(3)} → ${b.C.toFixed(3)}, gain ×${on.chromaGain.toFixed(2)}`);
  check('豐富色彩 does not darken the frame', b.L >= a.L - 0.005, `L ${a.L.toFixed(3)} → ${b.L.toFixed(3)}`);

  const g = grey();
  const go = statsF(mirrorRender(g, W, H, run(g, { ...DEFAULT_PARAMS, vivid: 1 })));
  check('豐富色彩 at full strength keeps greys grey', Math.abs(go.r - go.b) < 3 && Math.abs(go.g - go.b) < 3, fmt(go));

  let never = true, neutral = true;
  for (let C = 0; C <= 0.3; C += 0.005)
    for (let h = -3; h <= 3; h += 0.25) {
      if (boostChroma(C, h, 1.8, 0.4) < C - 1e-9) never = false;
      if (C <= 0.012 && Math.abs(boostChroma(C, h, 2.6, 0.45) - C) > 1e-9) neutral = false;
    }
  check('chroma boost never reduces chroma; near-neutrals untouched', never && neutral);

  let inGamut = true, hueKept = true;
  for (const [r, gg, bb] of [[0.98, 0.84, 0.18], [0.86, 0.18, 0.16], [0.2, 0.5, 0.9], [0.95, 0.95, 0.9]]) {
    const lab = toOklab(srgbToLinear(r), srgbToLinear(gg), srgbToLinear(bb));
    const out = gamutFit(lab, 2.5);
    if (Math.min(...out) < 0 || Math.max(...out) > 1) inGamut = false;
    const l2 = toOklab(out[0], out[1], out[2]);
    const dh = Math.atan2(Math.sin(Math.atan2(l2[2], l2[1]) - Math.atan2(lab[2], lab[1])), Math.cos(Math.atan2(l2[2], l2[1]) - Math.atan2(lab[2], lab[1])));
    if (Math.hypot(lab[1], lab[2]) > 0.02 && Math.abs(dh) > 0.05) hueKept = false;
  }
  check('gamut fit stays in sRGB and keeps hue', inGamut && hueKept);
}

function fmt(x: { r: number; g: number; b: number; contrast: number }) {
  return `r=${x.r.toFixed(1)} g=${x.g.toFixed(1)} b=${x.b.toFixed(1)} contrast=${x.contrast.toFixed(1)}`;
}

console.log(failures ? `\n${failures} FAILED` : '\nall engine checks passed');
process.exit(failures ? 1 : 0);
