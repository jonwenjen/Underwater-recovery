/**
 * Behaviour probes for an underwater enhancer — the six black-box tests of
 * docs/diverout-review.md (after the "Diverout reverse-engineering plan"),
 * run on OUR engine (CPU mirror of the GPU passes):
 *
 *   node --experimental-strip-types scripts/probes.ts            # report
 *   node --experimental-strip-types scripts/probes.ts --json out.json
 *
 *   1 colour chart + ramps   banding, point-wise vs spatial, chart ΔE under water
 *   2 depth ramp             same red object at 1/5/10/20 m: is compensation depth-aware?
 *   3 out-of-distribution    grey wedge stays grey, a land photo is left alone
 *   4 impulse                3×3 white dot on cyan: how far does it spread?
 *   5 temporal disruption    one black / land frame mid-clip: how fast does it recover?
 *   6 flip                   out(flip(x)) vs flip(out(x)): spatial priors
 *   + strength linearity     豐富色彩 at 0 / 0.5 / 1
 *
 * The same materials can be exported for running another app on them
 * (scripts/probe-kit.ts), so the numbers are directly comparable.
 */
import { writeFileSync } from 'node:fs';
import { AutoEngine, mirrorRender } from '../src/engine/auto.ts';
import { srgbToLinear, toOklab } from '../src/engine/color.ts';
import { DEFAULT_PARAMS, isAutoKey, type AutoKey, type Params } from '../src/engine/params.ts';
import { PROBES, type Probe } from './probe-materials.ts';

type Img = { px: Uint8ClampedArray; w: number; h: number };
const lab = (r: number, g: number, b: number) => toOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
const dE = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const f = (x: number, d = 3) => x.toFixed(d);

/** Our app on one still: auto analysis + the CPU twin of the GPU render, as 8-bit RGBA. */
export function runStill(img: Img, p: Partial<Params> = {}): Img {
  const locked = new Set(Object.keys(p).filter(isAutoKey)) as Set<AutoKey>;
  const st = new AutoEngine().step(img.px, img.w, img.h, { params: { ...DEFAULT_PARAMS, ...p }, locked, dt: 0 });
  return { px: to8(mirrorRender(img.px, img.w, img.h, st)), w: img.w, h: img.h };
}
/** A clip, frame by frame through one tracker (as live playback and export do). */
export function runClip(frames: Img[], fps = 30): Img[] {
  const e = new AutoEngine();
  return frames.map((fr, i) => {
    const st = e.step(fr.px, fr.w, fr.h, { params: DEFAULT_PARAMS, locked: new Set(), dt: i ? 1 / fps : 0 });
    return { px: to8(mirrorRender(fr.px, fr.w, fr.h, st)), w: fr.w, h: fr.h };
  });
}
function to8(rgb: Float32Array): Uint8ClampedArray {
  const n = rgb.length / 3;
  const o = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    o[i * 4] = Math.round(rgb[i * 3] * 255);
    o[i * 4 + 1] = Math.round(rgb[i * 3 + 1] * 255);
    o[i * 4 + 2] = Math.round(rgb[i * 3 + 2] * 255);
    o[i * 4 + 3] = 255;
  }
  return o;
}
const at = (im: Img, x: number, y: number) => {
  const i = (y * im.w + x) * 4;
  return [im.px[i] / 255, im.px[i + 1] / 255, im.px[i + 2] / 255];
};
/** Mean colour (sRGB 0..1) of a rectangle. */
const meanRect = (im: Img, x0: number, y0: number, w: number, h: number) => {
  const s = [0, 0, 0];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) at(im, x, y).forEach((v, c) => (s[c] += v));
  return s.map((v) => v / (w * h));
};

/* ------------------------------------------------------------- metrics */

/** 1a — chart under water: ΔE to the true chart, neutrality of the grey patches. */
export function chartMetrics(p: Probe, out: Img, raw: Img) {
  const m = p.meta as { patches: { x: number; y: number; s: number; rgb: number[]; grey: boolean }[] };
  let eOut = 0, eRaw = 0, greyC = 0, ng = 0;
  for (const q of m.patches) {
    const inset = Math.floor(q.s * 0.25);
    const o = meanRect(out, q.x + inset, q.y + inset, q.s - 2 * inset, q.s - 2 * inset);
    const r = meanRect(raw, q.x + inset, q.y + inset, q.s - 2 * inset, q.s - 2 * inset);
    const t = lab(q.rgb[0], q.rgb[1], q.rgb[2]);
    eOut += dE(lab(o[0], o[1], o[2]), t);
    eRaw += dE(lab(r[0], r[1], r[2]), t);
    if (q.grey) {
      const L = lab(o[0], o[1], o[2]);
      greyC += Math.hypot(L[1], L[2]);
      ng++;
    }
  }
  return { chartDeltaE: { raw: eRaw / m.patches.length, out: eOut / m.patches.length }, greyChroma: greyC / Math.max(1, ng) };
}

/**
 * 1b — ramps: identical rows, so any row-to-row difference is spatial
 * processing; along a row, a reversal or a jump far above the slope is banding.
 */
export function rampMetrics(p: Probe, out: Img) {
  const m = p.meta as { ramps: { y: number; h: number }[] };
  let reversals = 0, maxJump = 0;
  // per column; the 90th percentile, so an app's logo in a corner does not count
  const spreads: number[] = [];
  for (const r of m.ramps) {
    for (let x = 0; x < out.w; x++) {
      let lo = 1, hi = 0;
      for (let y = r.y + 2; y < r.y + r.h - 2; y++) {
        const v = at(out, x, y);
        const L = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
        lo = Math.min(lo, L);
        hi = Math.max(hi, L);
      }
      spreads.push((hi - lo) * 255);
    }
    const y = r.y + (r.h >> 1);
    let prev = -1, steps = 0, total = 0;
    for (let x = 0; x < out.w; x++) {
      const v = at(out, x, y);
      const L = (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) * 255;
      if (prev >= 0) {
        const d = L - prev;
        if (d < -1.5) reversals++;
        maxJump = Math.max(maxJump, d);
        total += Math.max(0, d);
        steps++;
      }
      prev = L;
    }
    maxJump = Math.max(0, maxJump - total / Math.max(1, steps)); // above the ramp's own slope
  }
  spreads.sort((a, b) => a - b);
  return {
    rampRowSpreadLevels: spreads[Math.floor(spreads.length * 0.9)] ?? 0,
    rampReversals: reversals,
    rampMaxExtraJumpLevels: maxJump,
  };
}

/** 2 — the same red object at increasing distance. */
export function depthMetrics(p: Probe, out: Img, raw: Img) {
  const m = p.meta as { objects: { x: number; y: number; s: number; d: number }[]; rgb: number[] };
  const t = lab(m.rgb[0], m.rgb[1], m.rgb[2]);
  return m.objects.map((o) => {
    const inset = Math.floor(o.s * 0.2);
    const a = meanRect(out, o.x + inset, o.y + inset, o.s - 2 * inset, o.s - 2 * inset);
    const r = meanRect(raw, o.x + inset, o.y + inset, o.s - 2 * inset, o.s - 2 * inset);
    return { d: o.d, rawDeltaE: dE(lab(r[0], r[1], r[2]), t), outDeltaE: dE(lab(a[0], a[1], a[2]), t), outRG: a[0] / Math.max(1e-3, a[1]) };
  });
}

/** 3 — no-harm: grey wedge and a land photo. */
export function oodMetrics(p: Probe, out: Img, raw: Img) {
  let maxC = 0, change = 0;
  const n = out.w * out.h;
  for (let i = 0; i < n; i++) {
    const o = [out.px[i * 4] / 255, out.px[i * 4 + 1] / 255, out.px[i * 4 + 2] / 255];
    const r = [raw.px[i * 4] / 255, raw.px[i * 4 + 1] / 255, raw.px[i * 4 + 2] / 255];
    const L = lab(o[0], o[1], o[2]);
    if (p.meta && (p.meta as { grey?: boolean }).grey) maxC = Math.max(maxC, Math.hypot(L[1], L[2]));
    change += dE(L, lab(r[0], r[1], r[2]));
  }
  return { maxChroma: maxC, meanChangeDeltaE: change / n };
}

/** 4 — impulse: spread radius beyond the global shift. */
export function impulseMetrics(p: Probe, out: Img, bgOut: Img) {
  const { cx, cy } = p.meta as { cx: number; cy: number };
  const d = new Float32Array(out.w * out.h);
  const far: number[] = [];
  for (let y = 0; y < out.h; y++)
    for (let x = 0; x < out.w; x++) {
      const i = y * out.w + x;
      let m = 0;
      for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(out.px[i * 4 + c] - bgOut.px[i * 4 + c]));
      d[i] = m;
      if (Math.hypot(x - cx, y - cy) > out.w * 0.4) far.push(m);
    }
  far.sort((a, b) => a - b);
  const shift = far[far.length >> 1] ?? 0;
  let radius = 0;
  for (let y = 0; y < out.h; y++)
    for (let x = 0; x < out.w; x++) if (d[y * out.w + x] - shift > 2) radius = Math.max(radius, Math.hypot(x - cx, y - cy));
  return { globalShiftLevels: shift, spreadRadiusPx: radius - 1.5, imageWidth: out.w };
}

/** 6 — flip equivariance (levels). */
function flipDiff(a: Img, b: Img, axis: 'v' | 'h') {
  let s = 0;
  for (let y = 0; y < a.h; y++)
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * 4;
      const j = axis === 'v' ? ((a.h - 1 - y) * a.w + x) * 4 : (y * a.w + (a.w - 1 - x)) * 4;
      for (let c = 0; c < 3; c++) s += Math.abs(a.px[i + c] - b.px[j + c]);
    }
  return s / (a.w * a.h * 3);
}
const flip = (im: Img, axis: 'v' | 'h'): Img => {
  const o = new Uint8ClampedArray(im.px.length);
  for (let y = 0; y < im.h; y++)
    for (let x = 0; x < im.w; x++) {
      const i = (y * im.w + x) * 4;
      const j = axis === 'v' ? ((im.h - 1 - y) * im.w + x) * 4 : (y * im.w + (im.w - 1 - x)) * 4;
      o.set(im.px.subarray(i, i + 4), j);
    }
  return { px: o, w: im.w, h: im.h };
};
const meanAbs = (a: Img, b: Img) => {
  let s = 0;
  for (let i = 0; i < a.px.length; i += 4) for (let c = 0; c < 3; c++) s += Math.abs(a.px[i + c] - b.px[i + c]);
  return s / ((a.px.length / 4) * 3);
};

/* ---------------------------------------------------------------- run */

export function runAll() {
  const R: Record<string, unknown> = {};
  const P = Object.fromEntries(PROBES().map((p) => [p.name, p]));

  const chart = P['1-chart'];
  R.chart = { ...chartMetrics(chart, runStill(chart.img), chart.img), ...rampMetrics(P['1-ramps'], runStill(P['1-ramps'].img)) };

  const depth = P['2-depth-ramp'];
  R.depth = depthMetrics(depth, runStill(depth.img), depth.img);

  const wedge = P['3-grey-wedge'], land = P['3-land'];
  R.greyWedge = oodMetrics(wedge, runStill(wedge.img), wedge.img);
  R.land = oodMetrics(land, runStill(land.img), land.img);

  const imp = P['4-impulse'];
  const bg = { ...imp.img, px: imp.img.px.slice() };
  const { cx, cy } = imp.meta as { cx: number; cy: number };
  for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) bg.px.set([0, 128, 128, 255], (y * bg.w + x) * 4);
  R.impulse = impulseMetrics(imp, runStill(imp.img), runStill(bg));

  // 5 — temporal: reference clip vs the same clip with frame 15 replaced
  const clip = P['5-clip'].frames!;
  const ref = runClip(clip);
  for (const kind of ['black', 'land'] as const) {
    const broken = clip.map((fr, i) => (i === 15 ? (kind === 'black' ? { ...fr, px: blackLike(fr) } : P['5-land-frame'].img) : fr));
    const out = runClip(broken);
    // contamination: frame 16 after the odd frame vs frame 16 graded on its own
    // (a tracker that snaps on cuts gives 0); the uninterrupted clip differs
    // from both by the tracker's normal smoothing lag
    const fresh = runStill(clip[16]);
    const diffs = out.map((o, i) => meanAbs(o, ref[i])).slice(16, 31);
    R[`temporal_${kind}`] = {
      frame16VsFreshLevels: meanAbs(out[16], fresh),
      frame16VsUninterruptedLevels: diffs[0],
      uninterruptedVsFreshLevels: meanAbs(ref[16], fresh),
      diffs: diffs.map((d) => +d.toFixed(2)),
    };
  }
  // flicker on a smooth pan: frame-to-frame change of the output's mean colour
  // beyond the change of the input's mean colour
  const mean = (im: Img) => meanRect(im, 0, 0, im.w, im.h).map((v) => v * 255);
  let jitter = 0;
  for (let i = 1; i < ref.length; i++) {
    const dOut = mean(ref[i]).map((v, c) => v - mean(ref[i - 1])[c]);
    const dIn = mean(clip[i]).map((v, c) => v - mean(clip[i - 1])[c]);
    jitter += Math.max(...dOut.map((v, c) => Math.abs(v - dIn[c])));
  }
  R.temporalFlicker = { meanColourJitterLevels: jitter / (ref.length - 1) };

  // 6 — flips, on a plain scene and on one with a sunlit surface band
  for (const name of ['6-scene', '6-scene-surface']) {
    const s = P[name].img;
    const o = runStill(s);
    R[`flip_${name}`] = { vertical: flipDiff(o, runStill(flip(s, 'v')), 'v'), horizontal: flipDiff(o, runStill(flip(s, 'h')), 'h') };
  }

  // strength linearity of 豐富色彩 (the closest thing we have to one strength slider)
  const sc = P['6-scene'].img;
  const v0 = runStill(sc, { vivid: 0 }), v5 = runStill(sc, { vivid: 0.5 }), v1 = runStill(sc, { vivid: 1 });
  let res = 0, mx = 0;
  for (let i = 0; i < v0.px.length; i += 4)
    for (let c = 0; c < 3; c++) {
      const r = Math.abs(v5.px[i + c] - (v0.px[i + c] + v1.px[i + c]) / 2);
      res += r;
      mx = Math.max(mx, r);
    }
  R.vividLinearity = { meanResidualLevels: res / ((v0.px.length / 4) * 3), maxResidualLevels: mx };
  return R;
}
const blackLike = (fr: Img) => {
  const o = new Uint8ClampedArray(fr.px.length);
  for (let i = 3; i < o.length; i += 4) o[i] = 255;
  return o;
};

if (import.meta.main) {
  const R = runAll() as any;
  const c = R.chart;
  console.log('1 chart under 6 m blue water   ΔE raw', f(c.chartDeltaE.raw), '→ out', f(c.chartDeltaE.out), '· grey patches chroma', f(c.greyChroma, 4));
  console.log('  ramps (identical rows)        row spread', f(c.rampRowSpreadLevels, 1), 'levels · reversals', c.rampReversals, '· extra jump', f(c.rampMaxExtraJumpLevels, 1));
  console.log('2 depth ramp (same red object)');
  for (const o of R.depth) console.log(`   ${String(o.d).padStart(2)} m   ΔE raw ${f(o.rawDeltaE)} → out ${f(o.outDeltaE)}   R/G ${f(o.outRG, 2)}`);
  console.log('3 grey wedge                    max chroma', f(R.greyWedge.maxChroma, 4), '· mean change ΔE', f(R.greyWedge.meanChangeDeltaE));
  console.log('  land photo                    mean change ΔE', f(R.land.meanChangeDeltaE));
  console.log('4 impulse (3×3 white on cyan)   spread radius', f(R.impulse.spreadRadiusPx, 1), 'px of', R.impulse.imageWidth, '· global shift', f(R.impulse.globalShiftLevels, 1), 'levels');
  for (const k of ['black', 'land']) {
    const t = R[`temporal_${k}`];
    console.log(`5 ${k} frame at 15`.padEnd(32), `frame 16 vs graded alone ${f(t.frame16VsFreshLevels, 2)} levels · vs uninterrupted clip ${f(t.frame16VsUninterruptedLevels, 2)} (uninterrupted vs alone ${f(t.uninterruptedVsFreshLevels, 2)})`);
  }
  console.log('  smooth pan: mean-colour jitter', f(R.temporalFlicker.meanColourJitterLevels, 2), 'levels / frame beyond the input\'s own change');
  for (const n of ['6-scene', '6-scene-surface']) console.log(`6 flip ${n.padEnd(16)}       vertical ${f(R[`flip_${n}`].vertical, 2)} · horizontal ${f(R[`flip_${n}`].horizontal, 2)} levels`);
  console.log('+ 豐富色彩 0/0.5/1 linearity     mean residual', f(R.vividLinearity.meanResidualLevels, 2), '· max', R.vividLinearity.maxResidualLevels, 'levels');
  const j = process.argv.indexOf('--json');
  if (j > 0) writeFileSync(process.argv[j + 1], JSON.stringify(R, null, 1));
}
