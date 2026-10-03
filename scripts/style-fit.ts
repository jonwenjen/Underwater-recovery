/**
 * Fit the 全自動-Diverout+ style presets to an AI mode's measured look.
 *
 *   node --experimental-strip-types scripts/style-fit.ts target <mode-output.jpg>   the mode's look vs the input sheet
 *   node --experimental-strip-types scripts/style-fit.ts preset <name>              a preset's look vs the input and vs 全自動-Diverout+
 *   node --experimental-strip-types scripts/style-fit.ts fit <水色重生|晶瑩極致>       coordinate search from 全自動-Diverout+
 *
 * The look is measured on the water scenes of the probe sheet (①–⑥) in
 * OKLab, at the AI outputs' scale: lightness shift, chroma ratio, global
 * contrast ratio (lightness σ), detail ratio (mean |L − 9-px box blur|), hue,
 * and the open water's chroma (top 18 % of a tile). A generative mode's content
 * is not reproducible; this look is. The fit keeps the chart's colour error
 * within 0.01 of Diverout+'s and clipping under 0.5 %.
 */
import { execFileSync } from 'node:child_process';
import { srgbToLinear, toOklab } from '../src/engine/color.ts';
import { DEFAULT_PARAMS, PRESETS, type Params } from '../src/engine/params.ts';
import { S } from './probe-materials.ts';
import { chartMetrics, oodMetrics, runStill } from './probes.ts';
import type { Probe } from './probe-materials.ts';
import { tiles } from './probe-sheet.ts';

type Img = { px: Uint8ClampedArray; w: number; h: number };
const TW = 720, TH = 600, GAP = 40, COLS = 4;
const LK = 1282 / (COLS * TW + (COLS + 1) * GAP), LW = Math.floor(TW * LK) - 2, LH = Math.floor(TH * LK) - 2;

export function lookOf(im: Img) {
  const n = im.w * im.h, L = new Float64Array(n);
  let sL = 0, sL2 = 0, sC = 0, sA = 0, sB = 0;
  for (let i = 0; i < n; i++) {
    const [l, a, b] = toOklab(srgbToLinear(im.px[i * 4] / 255), srgbToLinear(im.px[i * 4 + 1] / 255), srgbToLinear(im.px[i * 4 + 2] / 255));
    L[i] = l; sL += l; sL2 += l * l; sC += Math.hypot(a, b); sA += a; sB += b;
  }
  // detail: |L − box blur| with a 9-px box (separable)
  const R = 4, tmp = new Float64Array(n), bl = new Float64Array(n);
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) { let s = 0, c = 0; for (let d = -R; d <= R; d++) { const xx = x + d; if (xx >= 0 && xx < im.w) { s += L[y * im.w + xx]; c++; } } tmp[y * im.w + x] = s / c; }
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) { let s = 0, c = 0; for (let d = -R; d <= R; d++) { const yy = y + d; if (yy >= 0 && yy < im.h) { s += tmp[yy * im.w + x]; c++; } } bl[y * im.w + x] = s / c; }
  let det = 0;
  for (let i = 0; i < n; i++) det += Math.abs(L[i] - bl[i]);
  // open water: the top 18 % of a scene tile
  let wA = 0, wB = 0, wN = 0;
  for (let i = 0; i < Math.floor(im.h * 0.18) * im.w; i++) {
    const [, a, b] = toOklab(srgbToLinear(im.px[i * 4] / 255), srgbToLinear(im.px[i * 4 + 1] / 255), srgbToLinear(im.px[i * 4 + 2] / 255));
    wA += a; wB += b; wN++;
  }
  const mL = sL / n;
  return {
    L: mL, sd: Math.sqrt(Math.max(0, sL2 / n - mL * mL)), C: sC / n, det: det / n, hue: ((Math.atan2(sB, sA) * 180) / Math.PI + 360) % 360,
    waterC: Math.hypot(wA, wB) / wN, waterHue: ((Math.atan2(wB, wA) * 180) / Math.PI + 360) % 360,
  };
}
export const ratio = (a: ReturnType<typeof lookOf>, b: ReturnType<typeof lookOf>) =>
  ({ dL: b.L - a.L, chroma: b.C / a.C, contrast: b.sd / a.sd, detail: b.det / a.det, hue: b.hue, water: b.waterC / a.waterC, waterHue: b.waterHue });
const mean = (xs: ReturnType<typeof ratio>[]) => {
  const o = { dL: 0, chroma: 0, contrast: 0, detail: 0, hue: 0, water: 0, waterHue: 0 };
  for (const x of xs) for (const k of Object.keys(o) as (keyof typeof o)[]) o[k] += x[k] / xs.length;
  return o;
};
const fmt = (m: ReturnType<typeof mean>) => `亮度 ${m.dL >= 0 ? '+' : ''}${m.dL.toFixed(3)}  彩度 ×${m.chroma.toFixed(2)}  反差 ×${m.contrast.toFixed(2)}  細節 ×${m.detail.toFixed(2)}  色相 ${m.hue.toFixed(0)}°  水色彩度 ×${m.water.toFixed(2)} ${m.waterHue.toFixed(0)}°`;

// the water scenes (⑫ repeats ①: left out)
const WATER = tiles().filter((t) => t.truth && t.id !== 12);
const small = (im: Img, w: number, h: number): Img => {
  // area resize (integer-free, box)
  const o = new Uint8ClampedArray(w * h * 4), sx = im.w / w, sy = im.h / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const acc = [0, 0, 0]; let c = 0;
    for (let yy = Math.floor(y * sy); yy < Math.floor((y + 1) * sy); yy++) for (let xx = Math.floor(x * sx); xx < Math.floor((x + 1) * sx); xx++) { const i = (yy * im.w + xx) * 4; acc[0] += im.px[i]; acc[1] += im.px[i + 1]; acc[2] += im.px[i + 2]; c++; }
    const j = (y * w + x) * 4; o[j] = acc[0] / c; o[j + 1] = acc[1] / c; o[j + 2] = acc[2] / c; o[j + 3] = 255;
  }
  return { px: o, w, h };
};
const crop = (im: Img, x: number, y: number, w: number, h: number): Img => {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let yy = 0; yy < h; yy++) px.set(im.px.subarray(((y + yy) * im.w + x) * 4, ((y + yy) * im.w + x + w) * 4), yy * w * 4);
  return { px, w, h };
};

export const RAW_IN = {} as Partial<Params>;
export function presetLook(set: Partial<Params>, base: Partial<Params>) {
  const w = TW, h = TH;
  const rs: ReturnType<typeof ratio>[] = [], err: number[] = [], clip: number[] = [];
  const chroma = (S as unknown as { chromaError: (px: Uint8ClampedArray, w: number, h: number, t: unknown) => { err: number } }).chromaError;
  for (const t of WATER) {
    const im = t.img;
    const a = base === RAW_IN ? im : runStill(im, base), b = runStill(im, set);
    // looks at the scale the AI modes were measured at (a 1282-px-wide sheet)
    rs.push(ratio(lookOf(small(a, LW, LH)), lookOf(small(b, LW, LH))));
    err.push(chroma(b.px, TW, TH, t.truth).err);
    let c = 0; for (let i = 0; i < b.px.length; i += 4) if (Math.max(b.px[i], b.px[i + 1], b.px[i + 2]) >= 250) c++;
    clip.push((100 * c) / (w * h));
  }
  // subjects: the chart's patches (open water is SUPPOSED to stay coloured in these looks,
  // so the scenes' error vs a neutral truth is reported, not constrained); land: change
  const chartT = tiles().find((t) => t.key === 'chart')!, landT = tiles().find((t) => t.key === 'land')!;
  const chart = chartMetrics(chartT.probe!, runStill(chartT.img, set), chartT.img).chartDeltaE.out;
  const land = oodMetrics({} as Probe, runStill(landT.img, set), landT.img).meanChangeDeltaE;
  return { look: mean(rs), err: err.reduce((x, y) => x + y) / err.length, clip: clip.reduce((x, y) => x + y) / clip.length, chart, land };
}

type Knob = [keyof Params, number, number, number];
/**
 * The looks measured by `target` on Diverout's outputs of the sheet
 * (docs/diverout-review.md), and what each fit may turn. 晶瑩極致's detail is
 * measured on 1 MP regenerated texture: only a floor (no less than Diverout+).
 */
const TARGETS: Record<string, { dL: number; chroma: number; contrast: number; detail: number; detailMin?: number; water: number; waterHue: number; start: Partial<Params>; knobs: Knob[] }> = {
  水色重生: {
    dL: 0.042, chroma: 1.31, contrast: 1.69, detail: 1.71, water: 1.39, waterHue: 203,
    start: { diveroutWater: 0.7, vivid: 0.3 },
    knobs: [['diveroutWater', 0, 1, 0.15], ['vivid', 0, 1, 0.15], ['vibrance', -0.3, 0.8, 0.15], ['saturation', 0.8, 1.6, 0.1], ['contrast', -0.2, 0.6, 0.1], ['exposure', -0.3, 0.5, 0.1], ['dehaze', 0, 1, 0.2], ['clarity', 0, 0.6, 0.1]],
  },
  晶瑩極致: {
    dL: -0.003, chroma: 0.9, contrast: 2.17, detail: 1.52, detailMin: 1.7, water: 1.01, waterHue: 222,
    start: { diveroutWater: 0.7, contrast: 0.2, clarity: 0.3 },
    knobs: [['diveroutWater', 0, 1, 0.15], ['contrast', -0.2, 0.8, 0.1], ['clarity', 0, 0.8, 0.1], ['clahe', 0, 0.6, 0.1], ['dehaze', 0, 1, 0.2], ['vibrance', -0.4, 0.4, 0.1], ['exposure', -0.3, 0.3, 0.1], ['shadows', -0.4, 0.4, 0.1]],
  },
};

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'target' && arg) {
  const ff = execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())']).toString().trim();
  const info = execFileSync(ff, ['-v', 'error', '-i', arg, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 });
  // size from the byte count and the sheet's aspect
  const SW = COLS * TW + (COLS + 1) * GAP, SH = 3 * TH + 4 * GAP;
  const pxN = info.length / 4, ow = Math.round(Math.sqrt((pxN * SW) / SH)), oh = pxN / ow;
  const out: Img = { px: new Uint8ClampedArray(info.buffer, info.byteOffset, info.length), w: ow, h: oh };
  const k = ow / SW, w = Math.floor(TW * k) - 2, h = Math.floor(TH * k) - 2;
  const rs = WATER.map((t) => {
    const inT = small(t.img, w, h);
    const outT = crop(out, Math.ceil(t.x * k) + 1, Math.ceil(t.y * k) + 1, w, h);
    return ratio(lookOf(inT), lookOf(outT));
  });
  console.log(`${arg.replace(/^.*\//, '')} (${ow}×${oh}) vs input: ${fmt(mean(rs))}`);
} else if (cmd === 'preset' && arg) {
  // vs the untouched input (原始) and vs 全自動-Diverout+
  const raw = RAW_IN, plus = { ...DEFAULT_PARAMS, ...PRESETS['全自動-Diverout+'].set };
  for (const name of [...new Set(['全自動-Diverout+', arg])]) {
    const set = { ...DEFAULT_PARAMS, ...PRESETS[name].set };
    const a = presetLook(set, raw);
    console.log(`${name} vs 原始: ${fmt(a.look)} · 色差 ${a.err.toFixed(3)} · 色卡 ${a.chart.toFixed(3)} · 陸地改變 ${a.land.toFixed(3)} · 裁切 ${a.clip.toFixed(2)}%`);
    if (name !== '全自動-Diverout+') console.log(`${name} vs 全自動-Diverout+: ${fmt(presetLook(set, plus).look)}`);
  }
} else if (cmd === 'fit' && arg) {
  // coordinate search from 全自動-Diverout+ toward a mode's look; the colour
  // chart (subjects) may not get worse than Diverout+'s by more than 0.01 and nothing may clip
  const T = TARGETS[arg];
  if (!T) throw new Error(`no target ${arg} (${Object.keys(TARGETS).join(' / ')})`);
  const base = { ...DEFAULT_PARAMS, ...PRESETS['全自動-Diverout+'].set } as Params;
  const plusR = presetLook(base, RAW_IN), errPlus = plusR.err, chartPlus = plusR.chart;
  const loss = (r: ReturnType<typeof presetLook>) => {
    const m = r.look, l = (a: number, b: number) => Math.log(a / b) ** 2;
    return l(m.chroma, T.chroma) + l(m.contrast, T.contrast) + (T.detailMin ? Math.max(0, Math.log(T.detailMin / m.detail)) ** 2 : l(m.detail, T.detail))
      + l(m.water, T.water) + ((m.dL - T.dL) / 0.05) ** 2 + ((m.waterHue - T.waterHue) / 60) ** 2
      + Math.max(0, (r.chart - chartPlus - 0.01) / 0.01) ** 2 + Math.max(0, (r.err - errPlus - 0.1) / 0.03) ** 2 + Math.max(0, (r.clip - 0.5) / 0.5) ** 2;
  };
  let cur = { ...base, ...T.start } as Params;
  let curR = presetLook(cur, RAW_IN), curL = loss(curR);
  console.log(`start ${curL.toFixed(3)} · ${fmt(curR.look)} · 色差 ${curR.err.toFixed(3)} 色卡 ${curR.chart.toFixed(3)} (Diverout+ ${errPlus.toFixed(3)} / ${chartPlus.toFixed(3)})`);
  for (let round = 0; round < 3; round++) {
    let moved = false;
    for (const [k, lo, hi, step0] of T.knobs) {
      const step = step0 / (round + 1);
      for (const dir of [1, -1]) {
        for (;;) {
          const v = Math.min(hi, Math.max(lo, +((cur[k] as number) + dir * step).toFixed(3)));
          if (v === cur[k]) break;
          const cand = { ...cur, [k]: v }, r = presetLook(cand, RAW_IN), L = loss(r);
          if (L >= curL - 1e-4) break;
          cur = cand; curR = r; curL = L; moved = true;
          console.log(`  ${k}=${v} → ${L.toFixed(3)} · ${fmt(r.look)} · 色差 ${r.err.toFixed(3)} 色卡 ${r.chart.toFixed(3)} · 裁切 ${r.clip.toFixed(2)}%`);
        }
      }
    }
    if (!moved) break;
  }
  const out: Record<string, number> = {};
  for (const [k] of T.knobs) out[k] = cur[k] as number;
  console.log(`target: ${JSON.stringify(T)}\nfit: ${JSON.stringify(out)}\nlook: ${fmt(curR.look)} · 色差 ${curR.err.toFixed(3)} · 色卡 ${curR.chart.toFixed(3)} · 陸地改變 ${curR.land.toFixed(3)} · 裁切 ${curR.clip.toFixed(2)}%`);
} else console.log('usage: style-fit.ts target <mode-output> | preset <name> | fit <水色重生|晶瑩極致>');

