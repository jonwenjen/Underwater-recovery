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
import { applyHsl, buildCurveLut, curveFn, hslWeights, identityCurves, identityHsl, sampleCurveLut, type Pt } from '../src/engine/look.ts';
import { applySurface, detectBeams, detectSurface, estimateNoise, neutralLight, surfaceMask } from '../src/engine/light.ts';
import { applyLabShift, fitSeaThru, fuseL, fusionWeights, localWhiteBalance, LWB_GRID, quality, seaThruChannel } from '../src/engine/pipeline.ts';
import { AI_STYLE, DEFAULT_PARAMS, isAutoKey, PRESETS, type AutoKey, type Params } from '../src/engine/params.ts';
import { applyGuide, blendGuide, fitGuide, gridFor, identityGuide, netSize } from '../src/engine/ai.ts';

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
  // on the subject (left 40 %) ≥ 75 %; the whole frame ≥ 60 % — open water
  // intentionally keeps some blue (水色保留)
  const region = (px: ArrayLike<number>, stride: number, scale: number) => {
    let r = 0, g = 0, b = 0, c = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W * 0.4; x++) {
        const i = (y * W + x) * stride;
        r += px[i] * scale; g += px[i + 1] * scale; b += px[i + 2] * scale; c++;
      }
    return { r: r / c, g: g / c, b: b / c };
  };
  const subj0 = cast(region(src, 4, 1)), subj1 = cast(region(mirrorRender(src, W, H, s), 3, 255));
  check('blue cast removed (subject ≥ 75 %, frame ≥ 60 %)',
    Math.abs(subj1) < 0.25 * subj0 && Math.abs(cast(after)) < 0.4 * cast(before) && cast(before) > 40,
    `subject ${subj0.toFixed(1)} → ${subj1.toFixed(1)}, frame ${cast(before).toFixed(1)} → ${cast(after).toFixed(1)}`);
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
  // median, not mean: steady-state cost, robust to a stall on a shared CI machine
  const times: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    eng.step(img, aw, ah, { params: DEFAULT_PARAMS, locked: none, dt: 1 / 30 });
    times.push(performance.now() - t0);
  }
  const ms = times.sort((a, b) => a - b)[15];
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
  const auto = run(src);
  const off = new AutoEngine().step(src, W, H, { params: { ...DEFAULT_PARAMS, vivid: 0 }, locked: new Set<AutoKey>(['vivid']), dt: 0 });
  const on = new AutoEngine().step(src, W, H, { params: { ...DEFAULT_PARAMS, vivid: 0.7 }, locked: new Set<AutoKey>(['vivid']), dt: 0 });
  const a = meanChroma(mirrorRender(src, W, H, off)), b = meanChroma(mirrorRender(src, W, H, on));
  // full auto applies a milder dose than the button's 0.7 (TUNING.vividAuto, from scripts/optimize.ts)
  check('full auto applies mild 豐富色彩; locked at 0 it is off',
    auto.effective.vivid > 0.1 && auto.effective.vivid < 0.6 && off.chromaGain === 1 && off.warmGain === 0,
    `auto vivid ${auto.effective.vivid.toFixed(2)}`);
  check('豐富色彩 enriches colour (chroma +30 %)', b.C > a.C * 1.3, `C ${a.C.toFixed(3)} → ${b.C.toFixed(3)}, gain ×${on.chromaGain.toFixed(2)}`);
  check('豐富色彩 does not darken the frame', b.L >= a.L - 0.005, `L ${a.L.toFixed(3)} → ${b.L.toFixed(3)}`);

  const g = grey();
  const go = statsF(mirrorRender(g, W, H, new AutoEngine().step(g, W, H, { params: { ...DEFAULT_PARAMS, vivid: 1 }, locked: new Set<AutoKey>(['vivid']), dt: 0 })));
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

/* ------------------------------------------------ presets, curves, HSL */

{
  // 「原始」: every stage neutral → the pipeline is an identity
  const src = underwater('blue');
  const params = { ...DEFAULT_PARAMS, ...PRESETS.raw.set } as Params;
  const locked = new Set<AutoKey>(Object.keys(PRESETS.raw.set).filter(isAutoKey));
  const st = new AutoEngine().step(src, W, H, { params, locked, dt: 0 });
  const o = mirrorRender(src, W, H, st);
  let maxd = 0;
  for (let i = 0; i < W * H; i++)
    for (let c = 0; c < 3; c++) maxd = Math.max(maxd, Math.abs(o[i * 3 + c] * 255 - src[i * 4 + c]));
  check('「原始」 preset is an identity (≤ 1 level)', maxd <= 1.01, `max diff ${maxd.toFixed(2)} / 255`);
  const sun = PRESETS.sunny.set;
  // (highlight protection is measured on the GPU: no more clipping than auto)
  check('「淺水／陽光」 keeps the white point, sharpens caustics, leaves red & dehaze to auto',
    sun.whites === 1 && (sun.highlights ?? 0) <= 0 && (sun.clarity ?? 0) > DEFAULT_PARAMS.clarity && sun.redComp === undefined && sun.dehaze === undefined);
}
{
  const id = buildCurveLut(identityCurves());
  let err = 0;
  for (let i = 0; i < 256; i++) for (let c = 0; c < 3; c++) err = Math.max(err, Math.abs(id[i * 4 + c] - i / 255));
  check('identity curves are an identity LUT', err < 1e-6);
  let mono = true;
  for (const pts of [[[0, 0], [0.3, 0.6], [0.35, 0.2], [1, 1]], [[0.1, 0.9], [0.5, 0.1], [0.9, 0.95]], [[0, 0], [0.2, 0.8], [0.8, 0.2], [1, 1]]] as Pt[][]) {
    const f = curveFn(pts);
    const ys = Array.from({ length: 101 }, (_, i) => f(i / 100));
    // monotone between points: no value outside the neighbouring points' range
    for (let i = 0; i < 101; i++) if (ys[i] < -1e-9 || ys[i] > 1 + 1e-9) mono = false;
  }
  const f = curveFn([[0, 0], [0.5, 0.7], [1, 1]]);
  let inc = true;
  for (let i = 1; i <= 100; i++) if (f(i / 100) < f((i - 1) / 100) - 1e-9) inc = false;
  check('curves stay in range; rising points give a rising curve (no overshoot)', mono && inc && Math.abs(f(0.5) - 0.7) < 1e-9);
  const lut = buildCurveLut({ ...identityCurves(), r: [[0, 0], [0.5, 0.8], [1, 1]] });
  check('R curve moves red only', sampleCurveLut(lut, 0, 0.5) > 0.75 && Math.abs(sampleCurveLut(lut, 1, 0.5) - 0.5) < 1e-3 && Math.abs(sampleCurveLut(lut, 2, 0.5) - 0.5) < 1e-3);
  const both = buildCurveLut({ ...identityCurves(), rgb: [[0, 0], [0.5, 0.25], [1, 1]], r: [[0, 0], [0.5, 0.8], [1, 1]] });
  check('channel curve applies before the RGB master', Math.abs(sampleCurveLut(both, 0, 0.5) - curveFn([[0, 0], [0.5, 0.25], [1, 1]])(0.8)) < 2e-3);
}
{
  const coral: Vec3 = [0.85, 0.2, 0.18], water: Vec3 = [0.1, 0.35, 0.75], grey: Vec3 = [0.5, 0.5, 0.5];
  const same = (a: Vec3, b: Vec3, tol: number) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  check('identity HSL leaves colours unchanged', same(applyHsl(coral, identityHsl()), coral, 1e-4) && same(applyHsl(water, identityHsl()), water, 1e-4));
  const blueOff = { ...identityHsl(), s: [0, 0, 0, 0, 0, -100, 0, 0] };
  const chroma = (c: Vec3) => { const l = toOklab(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])); return Math.hypot(l[1], l[2]); };
  const w2 = applyHsl(water, blueOff), c2 = applyHsl(coral, blueOff);
  check('HSL 藍 −100 desaturates blue, leaves red alone', chroma(w2) < 0.3 * chroma(water) && same(c2, coral, 2e-3), `blue C ${chroma(water).toFixed(3)} → ${chroma(w2).toFixed(3)}`);
  // recovered water is typically a *pale* blue (OKLab C ≈ 0.025): it must still respond fully
  const paleWater: Vec3 = [0.36, 0.40, 0.47];
  const pw2 = applyHsl(paleWater, blueOff);
  check('HSL works on pale water blue, not only on saturated colour', chroma(pw2) < 0.3 * chroma(paleWater), `C ${chroma(paleWater).toFixed(3)} → ${chroma(pw2).toFixed(3)}`);
  const redHue = { ...identityHsl(), h: [100, 0, 0, 0, 0, 0, 0, 0] };
  const hue = (c: Vec3) => { const l = toOklab(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])); return Math.atan2(l[2], l[1]); };
  const c3 = applyHsl(coral, redHue);
  check('HSL 紅 hue +100 turns red toward orange (+~30°)', (hue(c3) - hue(coral)) * 57.3 > 20, `${((hue(c3) - hue(coral)) * 57.3).toFixed(1)}°`);
  const all = { h: new Array(8).fill(100), s: new Array(8).fill(100), l: new Array(8).fill(100) };
  check('HSL never tints greys', same(applyHsl(grey, all), grey, 1e-4));
  let inG = true;
  for (const c of [coral, water, [0.98, 0.84, 0.18] as Vec3, [0.2, 0.9, 0.3] as Vec3]) {
    const o = applyHsl(c, all);
    if (Math.min(...o) < 0 || Math.max(...o) > 1) inG = false;
  }
  check('HSL extremes stay inside sRGB', inG);
  let pou = true;
  for (let h = -3.2; h < 3.3; h += 0.05) if (Math.abs(hslWeights(h).reduce((a, b) => a + b, 0) - 1) > 1e-9) pou = false;
  check('HSL band weights always sum to 1 (no seams)', pou);
}

/* ------------------------------------------------ light: beams, surface, grain */

{
  // the ground-truth reef of scripts/verify-scene.js, sunlit: beams from (0.7, −0.4)
  (globalThis as unknown as { window: unknown }).window ??= globalThis;
  await import('../scripts/verify-scene.js');
  type Scene = {
    truth(w: number, h: number): { object: Uint8Array };
    degrade(t: unknown, water: string, depth: number, seed?: number, opts?: Record<string, number | boolean>): Uint8ClampedArray;
  };
  const SC = (globalThis as unknown as { __scene: Scene }).__scene;
  const w = 192, h = 120;
  const T = SC.truth(w, h);
  const lumOf = (px: Uint8ClampedArray) => {
    const L = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) L[i] = luma(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) / 255;
    return L;
  };
  const sun = SC.degrade(T, 'blue', 2.5, 3, { beams: true });
  const plain = SC.degrade(T, 'blue', 8);
  const b1 = detectBeams(lumOf(sun), w, h), b0 = detectBeams(lumOf(plain), w, h);
  check('beams detected on a sunlit frame, not on a plain reef', b1.presence > 0.5 && b0.presence < 0.2,
    `presence ${b1.presence.toFixed(2)} vs ${b0.presence.toFixed(2)}`);
  check('beam source found above the frame near the true one (0.70, −0.40)', Math.abs(b1.x - 0.7) < 0.3 && b1.y < 0 && b1.y > -1.2,
    `(${b1.x.toFixed(2)}, ${b1.y.toFixed(2)})`);

  const surf = SC.degrade(T, 'blue', 2.5, 3, { surface: true });
  const e = (px: Uint8ClampedArray) => Float32Array.from({ length: w * h * 3 }, (_, k) => px[Math.floor(k / 3) * 4 + (k % 3)] / 255);
  const s1 = detectSurface(lumOf(surf), e(surf), w, h), s0 = detectSurface(lumOf(plain), e(plain), w, h);
  check('bright surface band detected, B placed just below it', s1.presence > 0.5 && s0.presence < 0.2 && s1.by > 0.1 && s1.by < 0.35,
    `presence ${s1.presence.toFixed(2)} vs ${s0.presence.toFixed(2)}, B y ${s1.by.toFixed(2)}, clipped ${(s1.clip * 100).toFixed(0)} %`);

  let seed = 5;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  let noiseOk = true;
  const est: string[] = [];
  for (const sigma of [2, 5, 10]) {
    const px = new Uint8ClampedArray(256 * 256 * 4);
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4, base = 120 + 50 * Math.sin(x / 30) * Math.cos(y / 40) + (x > 128 ? 40 : 0);
        for (let c = 0; c < 3; c++) px[i + c] = base + (rnd() + rnd() + rnd() + rnd() - 2) * 1.732 * sigma;
        px[i + 3] = 255;
      }
    // independent grain per channel: luminance σ = σ·‖(0.2126, 0.7152, 0.0722)‖
    const want = sigma * 0.748, g = estimateNoise(px, 256, 256);
    est.push(`${want.toFixed(1)}→${g.toFixed(1)}`);
    if (Math.abs(g - want) > 0.15 * want + 0.3) noiseOk = false;
  }
  check('luminance grain σ estimated within 15 % on a textured frame', noiseOk, est.join(', '));

  check('surface mask: full at A, none past B, smooth between',
    surfaceMask(0.5, 0, 0.5, 0, 0.5, 0.3) === 1 && surfaceMask(0.5, 0.4, 0.5, 0, 0.5, 0.3) === 0 && Math.abs(surfaceMask(0.2, 0.15, 0.5, 0, 0.5, 0.3) - 0.5) < 1e-6);
  const same = (a: Vec3, b: Vec3, tol: number) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const hi = applySurface([1, 1, 0.98], 1, 1, 0, 0), mid = applySurface([0.4, 0.45, 0.5], 1, 1, 0, 0);
  check('surface recovery compresses highlights only', hi[1] < 0.8 && same(mid, [0.4, 0.45, 0.5], 2e-3), `white → ${hi.map((v) => v.toFixed(2)).join(',')}`);

  const labC = (c: Vec3) => { const l = toOklab(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])); return Math.hypot(l[1], l[2]); };
  const pinkLight: Vec3 = [0.93, 0.84, 0.92], coralPink: Vec3 = [0.95, 0.45, 0.62], paleBlue: Vec3 = [0.7, 0.85, 0.95];
  const nl = neutralLight(pinkLight, 0.8, 0.85);
  check('光線去洋紅: pale pink light turns white; pink coral and blue water untouched',
    labC(nl) < 0.4 * labC(pinkLight) && same(neutralLight(coralPink, 0.5, 0.85), coralPink, 1e-6) && same(neutralLight(paleBlue, 0.5, 0.85), paleBlue, 1e-6),
    `light C ${labC(pinkLight).toFixed(3)} → ${labC(nl).toFixed(3)}`);

  // de-cast guard: sunlit sandy frame — open water must not turn violet
  const sandy = SC.degrade(T, 'blue', 2.5, 3, { beams: true, surface: true });
  const st = new AutoEngine().step(sandy, w, h, { params: DEFAULT_PARAMS, locked: none, dt: 0 });
  const out = mirrorRender(sandy, w, h, st);
  let wa = 0, wb = 0, wn = 0;
  for (let i = 0; i < w * h; i++) {
    if (T.object[i] || i < w * h * 0.15) continue;
    const lab = toOklab(srgbToLinear(out[i * 3]), srgbToLinear(out[i * 3 + 1]), srgbToLinear(out[i * 3 + 2]));
    wa += lab[1]; wb += lab[2]; wn++;
  }
  const hueDeg = ((Math.atan2(wb / wn, wa / wn) * 180) / Math.PI + 360) % 360;
  let ba = 0, bb = 0, bn = 0;
  for (let y = Math.floor(0.16 * h); y < 0.45 * h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, u = x / w, v = y / h;
      if (T.object[i] || Math.max(0, Math.sin(Math.atan2((u - 0.7) * (w / h), v + 0.4) * 26 + 1.3)) ** 6 * (1 - v / 0.75) < 0.5) continue;
      const lab = toOklab(srgbToLinear(out[i * 3]), srgbToLinear(out[i * 3 + 1]), srgbToLinear(out[i * 3 + 2]));
      ba += lab[1]; bb += lab[2]; bn++;
    }
  check('sun beams render near-white, not pink', Math.hypot(ba / bn, bb / bn) < 0.025, `beam chroma ${Math.hypot(ba / bn, bb / bn).toFixed(3)}`);
  check('sunlit sandy frame: open water stays blue–cyan (de-cast guard)', hueDeg > 150 && hueDeg < 275, `water hue ${hueDeg.toFixed(0)}°, de-cast ${st.effective.deCast.toFixed(2)}`);
}

/* ------------------------------------------------ 自動化流程 modules */

{
  // 多分支融合: weights are a partition of unity; amount 0 is an identity
  const w = 64, h = 48, n = w * h;
  const L = new Float32Array(n).map((_, i) => 0.1 + 0.8 * (((i % w) / w) * 0.5 + 0.5 * Math.sin(i / 97) ** 2));
  const he = L.map((v) => Math.min(1, v * 1.2));
  const w2 = new Float32Array(n), w3 = new Float32Array(n);
  fusionWeights(L, he, w, h, w2, w3);
  let ok = true;
  for (let i = 0; i < n; i++) if (w2[i] < 0 || w3[i] < 0 || w2[i] + w3[i] > 1 + 1e-6) ok = false;
  check('融合: branch weights are non-negative and sum to at most 1', ok);
  check('融合: amount 0 leaves the luminance alone', fuseL(0.37, 0.8, 0.3, 0.3, 0) === 0.37);

  // Lab: only toward red / yellow; saturated colours and open water spared
  const pale = [0.55, 0.62, 0.64], sat = [0.9, 0.2, 0.25];
  const p1 = pale.slice(), s1 = sat.slice(), pw = pale.slice();
  applyLabShift(p1, 0, [0.02, 0.03], 1, 1);
  applyLabShift(s1, 0, [0.02, 0.03], 1, 1);
  applyLabShift(pw, 0, [0.02, 0.03], 1, 0.05);
  const lab = (c: number[]) => toOklab(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]));
  const d = (a: number[], b: number[]) => [lab(a)[1] - lab(b)[1], lab(a)[2] - lab(b)[2]];
  check('Lab: a pale bluish surface moves toward red / yellow',
    d(p1, pale)[0] > 0.01 && d(p1, pale)[1] > 0.015, `Δa ${d(p1, pale)[0].toFixed(3)} Δb ${d(p1, pale)[1].toFixed(3)}`);
  check('Lab: saturated coral untouched; open water shifted less than a surface',
    Math.abs(d(s1, sat)[0]) < 1e-4 && Math.hypot(...d(pw, pale)) < 0.5 * Math.hypot(...d(p1, pale)));

  // Sea-thru: fitted on data made with the model, the parameters come back
  const N = 6000, lin = new Float32Array(N * 3), tt = new Float32Array(N);
  const B = [0.02, 0.15, 0.3], bb = [1.2, 0.9, 0.8], beta = [0.9, 0.3, 0.2];
  let sd = 3;
  const rnd = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < N; i++) {
    const z = 0.1 + 2.4 * rnd();
    tt[i] = Math.exp(-z);
    const J = rnd() < 0.05 ? 0 : 0.2 + 0.6 * rnd(); // some black pixels, as real scenes have
    for (let c = 0; c < 3; c++) lin[i * 3 + c] = J * Math.exp(-beta[c] * z) + B[c] * (1 - Math.exp(-bb[c] * z));
  }
  const fit = fitSeaThru(lin, tt, N);
  check('Sea-thru: backscatter fitted from the darkest pixels (within 25 %)',
    fit.B.every((v, c) => Math.abs(v - B[c]) <= 0.25 * B[c] + 0.01), `B ${fit.B.map((v) => v.toFixed(3)).join(',')}`);
  check('Sea-thru: attenuation differences recovered (red most, blue least)',
    fit.beta[0] > fit.beta[1] && fit.beta[1] >= fit.beta[2] && Math.abs(fit.beta[0] - (beta[0] - beta[2])) < 0.25, `β ${fit.beta.map((v) => v.toFixed(2)).join(',')}`);
  check('Sea-thru: restoration of a model pixel returns its radiance (relative to blue)',
    Math.abs(seaThruChannel(0.4 * Math.exp(-0.9) + 0.02 * (1 - Math.exp(-1.2)), Math.exp(-1), 0.02, 1.2, 0.7) / (0.4 * Math.exp(-0.2)) - 1) < 0.05);

  // local white balance: one light → no correction; a warm-lit half → cooled
  const lw = 64, lh = 64, bal = new Float32Array(lw * lh * 3);
  const fill = (warm: boolean) => {
    for (let y = 0; y < lh; y++)
      for (let x = 0; x < lw; x++) {
        const q = (y * lw + x) * 3, v = 0.3 + 0.2 * Math.sin(x / 5) * Math.cos(y / 7);
        const k = warm && y >= lh / 2 ? [1.25, 1, 0.8] : [1, 1, 1];
        bal[q] = v * k[0]; bal[q + 1] = v * k[1]; bal[q + 2] = v * k[2];
      }
  };
  fill(false);
  const one = localWhiteBalance(bal, lw, lh);
  fill(true);
  const two = localWhiteBalance(bal, lw, lh);
  const G = LWB_GRID, bottom = (G - 1) * G * 3;
  check('區域白平衡: one light → gains ≈ 1, no spread', one.spread < 0.002 && one.gains.every((v) => Math.abs(v - 1) < 0.02), `spread ${one.spread.toFixed(4)}`);
  check('區域白平衡: a warm-lit half is cooled, the spread is detected',
    two.spread > 0.02 && two.gains[bottom] < 0.97 && two.gains[bottom + 2] > 1.03, `spread ${two.spread.toFixed(3)}, bottom gain ${Array.from(two.gains.slice(bottom, bottom + 3)).map((v) => v.toFixed(2))}`);

  // quality: an untouched output is not over-processed; a crunchy one is
  const qw = 96, qh = 64, qsrc = new Uint8ClampedArray(qw * qh * 4), same = new Float32Array(qw * qh * 3), crunchy = new Float32Array(qw * qh * 3);
  let sq = 5;
  const rq = () => ((sq = (sq * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < qw * qh; i++) {
    const v = 90 + 40 * Math.sin(i / 300) + (rq() - 0.5) * 6;
    qsrc[i * 4] = v * 0.6; qsrc[i * 4 + 1] = v; qsrc[i * 4 + 2] = v * 1.1; qsrc[i * 4 + 3] = 255;
    for (let c = 0; c < 3; c++) same[i * 3 + c] = qsrc[i * 4 + c] / 255;
  }
  for (let i = 0; i < qw * qh; i++) for (let c = 0; c < 3; c++) {
    const x = i % qw, y = (i / qw) | 0, j = (Math.min(qh - 1, y + 1) * qw + x) * 3 + c;
    crunchy[i * 3 + c] = Math.min(1, Math.max(0, same[i * 3 + c] + 4 * (same[i * 3 + c] - same[j])));
  }
  const q0 = quality(same, qsrc, qw, qh), q1 = quality(crunchy, qsrc, qw, qh);
  check('品質: the source itself is not over-processed', Math.abs(q0.noiseAmp - 1) < 0.05 && Math.abs(q0.lcRatio - 1) < 0.05 && q0.clip === 0,
    `noise ×${q0.noiseAmp.toFixed(2)}, LC ×${q0.lcRatio.toFixed(2)}`);
  check('品質: over-sharpening is measured as noise amplification', q1.noiseAmp > 2, `noise ×${q1.noiseAmp.toFixed(2)}, UIQM ${q1.uiqm.toFixed(2)} vs ${q0.uiqm.toFixed(2)}`);
}
{
  // engine: 品質把關 keeps a still within its limits (or at its floor), and
  // 自動判斷流程 turns on Sea-thru + 品質把關 but leaves a land photo alone
  (globalThis as unknown as { window: unknown }).window ??= globalThis;
  await import('../scripts/verify-scene.js');
  type Scene = { truth(w: number, h: number): unknown; degrade(t: unknown, water: string, depth: number, seed?: number, opts?: Record<string, number | boolean>): Uint8ClampedArray };
  const SC = (globalThis as unknown as { __scene: Scene }).__scene;
  const w = 192, h = 108;
  const sunny = SC.degrade(SC.truth(w, h), 'blue', 2.5, 3, { beams: true, surface: true });
  const qa = new AutoEngine().step(sunny, w, h, { params: { ...DEFAULT_PARAMS, qaGuard: 1 }, locked: none, dt: 0 });
  const q = qa.stats.quality!;
  check('品質把關: a still ends within every limit, or at the strongest back-off',
    (q.clip <= 0.002 && q.noiseAmp <= 2.5 && q.lcRatio <= 3) || qa.stats.qaScale <= 0.41,
    `scale ×${qa.stats.qaScale.toFixed(2)}, clip ${(q.clip * 100).toFixed(2)} %, noise ×${q.noiseAmp.toFixed(2)}, LC ×${q.lcRatio.toFixed(2)}`);
  const ap = new AutoEngine().step(SC.degrade(SC.truth(w, h), 'blue', 8), w, h, { params: { ...DEFAULT_PARAMS, autoPipeline: 1 }, locked: none, dt: 0 });
  check('自動判斷流程: Sea-thru on (in place of part of dehaze) and quality measured',
    ap.seathru.amount > 0.05 && ap.stats.quality !== null, `Sea-thru ${ap.seathru.amount.toFixed(2)}, scale ×${ap.stats.qaScale.toFixed(2)}`);
  const g = grey();
  const g0 = mirrorRender(g, W, H, new AutoEngine().step(g, W, H, { params: DEFAULT_PARAMS, locked: none, dt: 0 }));
  const g1 = mirrorRender(g, W, H, new AutoEngine().step(g, W, H, { params: { ...DEFAULT_PARAMS, autoPipeline: 1 }, locked: none, dt: 0 }));
  // natural mode on a land frame: at most as much change as full auto makes
  let c0 = 0, c1 = 0;
  for (let i = 0; i < W * H; i++)
    for (let c = 0; c < 3; c++) {
      c0 += Math.abs(g0[i * 3 + c] * 255 - g[i * 4 + c]);
      c1 += Math.abs(g1[i * 3 + c] * 255 - g[i * 4 + c]);
    }
  check('自動判斷流程 changes a non-underwater frame no more than full auto does', c1 <= c0 + 1e-6,
    `mean change ${(c0 / (W * H * 3)).toFixed(2)} → ${(c1 / (W * H * 3)).toFixed(2)} levels`);
}

/* ---------------------------------------------------- 🤖 AI 風格 guide */

{
  console.log('\n— 🤖 AI 風格: transform grid (ai.ts)');
  const src = underwater('blue');
  // a spatially varying colour transform standing in for the network: red
  // gain rising left → right, blue cut rising top → bottom, a cross term
  const net = (r: number, g: number, b: number, u: number, v: number): Vec3 => [
    Math.min(1, r * (1.1 + 0.4 * u) + 0.04),
    Math.min(1, 0.9 * g + 0.1 * r),
    Math.min(1, b * (1 - 0.35 * v)),
  ];
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const o = net(src[i] / 255, src[i + 1] / 255, src[i + 2] / 255, (x + 0.5) / W, (y + 0.5) / H);
      out[i] = Math.round(o[0] * 255);
      out[i + 1] = Math.round(o[1] * 255);
      out[i + 2] = Math.round(o[2] * 255);
      out[i + 3] = 255;
    }
  const [gx, gy] = gridFor(W, H);
  const g = fitGuide(src, out, W, H, gx, gy);
  const t = new Float32Array(12), px = new Float32Array(3);
  let err = 0, idErr = 0;
  const id = identityGuide(gx, gy);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) px[c] = src[i + c] / 255;
      applyGuide(px, g, (x + 0.5) / W, (y + 0.5) / H, 1, t);
      for (let c = 0; c < 3; c++) err += Math.abs(px[c] * 255 - out[i + c]);
      for (let c = 0; c < 3; c++) px[c] = src[i + c] / 255;
      applyGuide(px, id, (x + 0.5) / W, (y + 0.5) / H, 1, t);
      for (let c = 0; c < 3; c++) idErr += Math.abs(px[c] * 255 - src[i + c]);
    }
  err /= W * H * 3;
  check('grid reproduces a smoothly varying colour transform', err < 2, `grid ${gx}×${gy}, mean error ${err.toFixed(2)} levels`);
  check('identity grid leaves the picture alone', idErr / (W * H * 3) < 1e-3);
  const b = blendGuide(id, g, 0.5);
  check('video blend moves the grid halfway', near(b.m[0], (id.m[0] + g.m[0]) / 2, 1e-6) && blendGuide(identityGuide(2, 2), g, 0.5) === g);
  const [nw, nh] = netSize(1920, 1080, 512);
  check('network input: multiples of 32, long edge ≈ 512', nw % 32 === 0 && nh % 32 === 0 && nw === 512 && Math.abs(nh - 288) <= 16, `${nw}×${nh}`);

  // the engine: AI 風格 applies the grid before everything else; with the
  // button's settings the result follows the network, not the engine
  const run = (p: Partial<Params>, ai = g) => {
    const locked = new Set(Object.keys(p).filter(isAutoKey)) as Set<AutoKey>;
    const st = new AutoEngine().step(src, W, H, { params: { ...DEFAULT_PARAMS, ...p }, locked, dt: 0, ai });
    return mirrorRender(src, W, H, st);
  };
  const plain = run({}, null as never), off = run({ aiStyle: 0 });
  let d0 = 0;
  for (let i = 0; i < plain.length; i++) d0 = Math.max(d0, Math.abs(plain[i] - off[i]));
  check('aiStyle 0: a loaded guide changes nothing', d0 < 1e-6);
  const style = run(AI_STYLE);
  const mean = (f: (i: number, c: number) => number) => [0, 1, 2].map((c) => { let s2 = 0; for (let i = 0; i < W * H; i++) s2 += f(i, c); return s2 / (W * H); });
  const mS = mean((i, c) => style[i * 3 + c] * 255), mN = mean((i, c) => out[i * 4 + c]);
  const dm = Math.max(...mS.map((v, c) => Math.abs(v - mN[c])));
  check('AI 風格 button: output follows the network (engine colour/tone off)', dm < 3,
    `mean ${mS.map((v) => v.toFixed(1)).join('/')} vs network ${mN.map((v) => v.toFixed(1)).join('/')}`);
  const half = run({ ...AI_STYLE, aiStyle: 0.5 }), none = run({ ...AI_STYLE, aiStyle: 0 });
  const mH = mean((i, c) => half[i * 3 + c] * 255), m0 = mean((i, c) => none[i * 3 + c] * 255);
  check('AI 風格強度 0.5 lands halfway', mH.every((v, c) => Math.abs(v - (mS[c] + m0[c]) / 2) < 2),
    `${mH.map((v) => v.toFixed(1)).join('/')}`);
}

function fmt(x: { r: number; g: number; b: number; contrast: number }) {
  return `r=${x.r.toFixed(1)} g=${x.g.toFixed(1)} b=${x.b.toFixed(1)} contrast=${x.contrast.toFixed(1)}`;
}

console.log(failures ? `\n${failures} FAILED` : '\nall engine checks passed');
process.exit(failures ? 1 : 0);
