/**
 * One-shot probe sheet: twelve probe tiles on ONE image, for apps with a
 * limited number of trial runs (e.g. an "AI enhance" mode).
 *
 *   node --experimental-strip-types scripts/probe-sheet.ts export <file.png>
 *   node --experimental-strip-types scripts/probe-sheet.ts compare <app-output>
 *   node --experimental-strip-types scripts/probe-sheet.ts modes <out1> <out2> …   (one per mode, as a table)
 *   node --experimental-strip-types scripts/probe-sheet.ts tiles <dir>            (the tiles one by one)
 *   node --experimental-strip-types scripts/probe-sheet.ts compare-tile <1–12> <app-output>
 *   node --experimental-strip-types scripts/probe-sheet.ts selftest
 *
 * What one image can and cannot tell
 * ----------------------------------
 * An app that decides ONE scene for the whole picture and applies one
 * transform (Diverout's photo enhancement measured that way) gives every tile
 * the same treatment, so per-scene behaviour cannot be read from a sheet —
 * but the sheet proves that it is global. An app that works locally / by
 * content treats each tile on its own, and then every tile is a separate
 * measurement. The report therefore starts with that test:
 *   - context dependence: the same input colour, does it come out the same in
 *     every tile? (leave-one-out: each tile's mean change per input-colour bin
 *     vs the other tiles' change for the same bins; ≈ 0 ⇒ one global
 *     pointwise transform)
 *   - the repeated tile ⑫ = ①, elsewhere on the sheet: equal ⇒ no position
 *     prior.
 * Then per tile: colour error vs the known truth, clipping, chart ΔE, depth
 * ladder, grey wedge / ramps, land photo, impulse spread.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { MACBETH, S, underwater, type Probe } from './probe-materials.ts';
import { chartMetrics, depthMetrics, oodMetrics, rampMetrics, runStill } from './probes.ts';
import { srgbToLinear, toOklab } from '../src/engine/color.ts';

type Img = { px: Uint8ClampedArray; w: number; h: number };
const TW = 720, TH = 600, GAP = 40, COLS = 4, ROWS = 3;
export const SHEET_W = COLS * TW + (COLS + 1) * GAP;
export const SHEET_H = ROWS * TH + (ROWS + 1) * GAP;
const GUTTER = 128;

interface Tile {
  id: number;
  key: string;
  label: string;
  x: number;
  y: number;
  img: Img;
  /** scene truth (for colour error) */
  truth?: unknown;
  probe?: Probe;
}

const solid = (w: number, h: number, rgb: number[]): Img => {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return { px, w, h };
};

/** The twelve tiles, generated at tile size (720 × 600). */
export function tiles(): Tile[] {
  const T: Omit<Tile, 'x' | 'y' | 'id'>[] = [];
  const scene = (key: string, label: string, water: string, depth: number, pan: number, seed: number, opts: object = {}) => {
    const t = S.truth(TW, TH, pan, seed);
    T.push({ key, label, img: { px: S.degrade(t, water, depth, 3, opts), w: TW, h: TH }, truth: t });
  };
  scene('blue8', '① 藍水 8 m', 'blue', 8, 0, 7);
  scene('green6', '② 綠水 6 m', 'green', 6, 0.35, 11);
  scene('murky5', '③ 混濁 5 m', 'murky', 5, 0.2, 13);
  scene('strobe10', '④ 閃燈近拍 10 m', 'blue', 10, 0.35, 11, { strobe: 3 });
  scene('sunny2.5', '⑤ 淺水陽光 2.5 m', 'blue', 2.5, 0, 7, { beams: true, surface: true });
  scene('deep15', '⑥ 深藍 15 m', 'blue', 15, 0.1, 17);
  // ⑦ colour chart, 2 m away at 6 m
  {
    const s = 92, gap = 18, x0 = (TW - (6 * s + 5 * gap)) / 2, y0 = (TH - (4 * s + 3 * gap)) / 2;
    const J = new Float32Array(TW * TH * 3).fill(0.45), d = new Float32Array(TW * TH).fill(2);
    const patches = MACBETH.map((c, k) => ({ x: Math.round(x0 + (k % 6) * (s + gap)), y: Math.round(y0 + Math.floor(k / 6) * (s + gap)), s, rgb: c.map((v) => v / 255), grey: k >= 18 }));
    for (const q of patches) for (let yy = q.y; yy < q.y + s; yy++) for (let xx = q.x; xx < q.x + s; xx++) J.set(q.rgb, (yy * TW + xx) * 3);
    const img = { px: underwater(J, d, TW, TH), w: TW, h: TH };
    T.push({ key: 'chart', label: '⑦ 水下色卡', img, probe: { name: 'chart', purpose: '', img, meta: { patches } } });
  }
  // ⑧ the same red object at 1 / 5 / 10 / 20 m in front of a far wall
  {
    const s = 120, rgb = [0.75, 0.15, 0.12];
    const J = new Float32Array(TW * TH * 3), d = new Float32Array(TW * TH).fill(30);
    let seed = 9;
    const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < TW * TH; i++) {
      const v = 0.5 + (r() - 0.5) * 0.12;
      J.set([v * 1.05, v, v * 0.85], i * 3);
    }
    const objects = [1, 5, 10, 20].map((dist, k) => ({ x: 36 + k * 172, y: 240, s, d: dist }));
    for (const o of objects) for (let y = o.y; y < o.y + s; y++) for (let x = o.x; x < o.x + s; x++) { J.set(rgb, (y * TW + x) * 3); d[y * TW + x] = o.d; }
    const img = { px: underwater(J, d, TW, TH, 'blue', 5), w: TW, h: TH };
    T.push({ key: 'depth', label: '⑧ 深度 1/5/10/20 m', img, probe: { name: 'depth', purpose: '', img, meta: { objects, rgb } } });
  }
  // ⑨ grey wedge (top) + R / G / B / C / grey ramps (bottom)
  {
    const img = solid(TW, TH, [0, 0, 0]);
    for (let y = 0; y < 240; y++) for (let x = 0; x < TW; x++) { const v = Math.round((x / (TW - 1)) * 255); img.px.set([v, v, v, 255], (y * TW + x) * 4); }
    const bands = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 1, 1], [1, 1, 1]], bh = 72;
    const ramps = bands.map((b, k) => {
      for (let y = 240 + k * bh; y < 240 + (k + 1) * bh; y++) for (let x = 0; x < TW; x++) { const v = (x / (TW - 1)) * 255; img.px.set([b[0] * v, b[1] * v, b[2] * v, 255], (y * TW + x) * 4); }
      return { y: 240 + k * bh, h: bh };
    });
    T.push({ key: 'wedge', label: '⑨ 灰階＋純色漸層', img, probe: { name: 'wedge', purpose: '', img, meta: { ramps, grey: true } } });
  }
  T.push({ key: 'land', label: '⑩ 陸地照片', img: { px: S.clean(S.truth(TW, TH, 0.2, 21)), w: TW, h: TH } });
  {
    const img = solid(TW, TH, [0, 128, 128]);
    for (let y = TH / 2 - 1; y <= TH / 2 + 1; y++) for (let x = TW / 2 - 1; x <= TW / 2 + 1; x++) img.px.set([255, 255, 255, 255], (y * TW + x) * 4);
    T.push({ key: 'impulse', label: '⑪ 脈衝白點', img });
  }
  T.push({ ...T[0], key: 'blue8-repeat', label: '⑫ 與 ① 相同（換位置）' });
  return T.map((t, i) => ({ ...t, id: i + 1, x: GAP + (i % COLS) * (TW + GAP), y: GAP + Math.floor(i / COLS) * (TH + GAP) }));
}

export function sheet(): { img: Img; tiles: Tile[] } {
  const T = tiles();
  const img = solid(SHEET_W, SHEET_H, [GUTTER, GUTTER, GUTTER]);
  for (const t of T) for (let y = 0; y < TH; y++) img.px.set(t.img.px.subarray(y * TW * 4, (y + 1) * TW * 4), ((t.y + y) * SHEET_W + t.x) * 4);
  // corner marks (black / white), to spot a crop
  for (const [cx, cy] of [[0, 0], [SHEET_W - 24, 0], [0, SHEET_H - 24], [SHEET_W - 24, SHEET_H - 24]])
    for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) { const v = (x < 12) !== (y < 12) ? 255 : 0; img.px.set([v, v, v, 255], ((cy + y) * SHEET_W + cx + x) * 4); }
  return { img, tiles: T };
}

/* ---------------------------------------------------------------- PNG */
function png(im: Img): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(im.w, 0);
  ihdr.writeUInt32BE(im.h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // RGB
  const raw = Buffer.alloc((im.w * 3 + 1) * im.h);
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) { const i = (y * im.w + x) * 4, o = y * (im.w * 3 + 1) + 1 + x * 3; raw[o] = im.px[i]; raw[o + 1] = im.px[i + 1]; raw[o + 2] = im.px[i + 2]; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------------------------------------------------- analysis */
/** Area-average (or nearest when enlarging) to w × h. */
function resize(im: Img, w: number, h: number): Img {
  if (im.w === w && im.h === h) return im;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * im.w) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * im.w) / w));
      const y0 = Math.floor((y * im.h) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * im.h) / h));
      const s = [0, 0, 0];
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) for (let c = 0; c < 3; c++) s[c] += im.px[(yy * im.w + xx) * 4 + c];
      const n = (x1 - x0) * (y1 - y0);
      px.set([s[0] / n, s[1] / n, s[2] / n, 255], (y * w + x) * 4);
    }
  return { px, w, h };
}
const crop = (im: Img, x: number, y: number, w: number, h: number): Img => {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let yy = 0; yy < h; yy++) px.set(im.px.subarray(((y + yy) * im.w + x) * 4, ((y + yy) * im.w + x + w) * 4), yy * w * 4);
  return { px, w, h };
};
const meanAbs = (a: Img, b: Img) => {
  let s = 0;
  for (let i = 0; i < a.px.length; i += 4) for (let c = 0; c < 3; c++) s += Math.abs(a.px[i + c] - b.px[i + c]);
  return s / ((a.px.length / 4) * 3);
};
const meanRGB = (a: Img) => {
  const s = [0, 0, 0];
  for (let i = 0; i < a.px.length; i += 4) for (let c = 0; c < 3; c++) s[c] += a.px[i + c];
  return s.map((v) => Math.round(v / (a.px.length / 4)));
};
const clipPct = (a: Img) => {
  let n = 0;
  for (let i = 0; i < a.px.length; i += 4) if (Math.max(a.px[i], a.px[i + 1], a.px[i + 2]) >= 250) n++;
  return (100 * n) / (a.px.length / 4);
};

/**
 * Context dependence: per input-colour bin (32³, 8 levels), this tile's mean
 * CHANGE (output − input) vs the mean change of the SAME bin in all OTHER
 * tiles (leave-one-out). One global pointwise transform changes the same input
 * the same way everywhere ⇒ ≈ 0 (no change gives exactly 0). Bins the other
 * tiles hold fewer than 20 pixels of are skipped.
 */
function contextDependence(ins: Img[], outs: Img[], tw: number, th: number) {
  const B = 32, NB = B * B * B;
  const bin = (px: Uint8ClampedArray, i: number) => ((px[i] >> 3) * B + (px[i + 1] >> 3)) * B + (px[i + 2] >> 3);
  const pooled = new Float64Array(NB * 4);
  const per = ins.map(() => new Float64Array(NB * 4));
  ins.forEach((a, t) => {
    for (let i = 0; i < a.px.length; i += 4) {
      const k = bin(a.px, i) * 4;
      for (let c = 0; c < 3; c++) { const ch = outs[t].px[i + c] - a.px[i + c]; pooled[k + c] += ch; per[t][k + c] += ch; }
      pooled[k + 3]++;
      per[t][k + 3]++;
    }
  });
  return ins.map((_, t) => {
    let d = 0, n = 0, px = 0;
    for (let b = 0; b < NB; b++) {
      const k = b * 4, own = per[t][k + 3], others = pooled[k + 3] - own;
      if (!own || others < 20) continue;
      for (let c = 0; c < 3; c++) d += own * Math.abs(per[t][k + c] / own - (pooled[k + c] - per[t][k + c]) / others);
      n += own * 3;
      px += own;
    }
    return { context: n ? d / n : NaN, shared: px / (tw * th) };
  });
}

/**
 * What a per-tile colour mapping cannot explain.
 *  - `pointwise`: how far the output is from the tile's own best pointwise
 *    mapping (16³ input-colour bins → mean output), in 8-bit levels, minus
 *    the same for no change (bin width). ≈ 0 for any per-tile LUT; > 0 for
 *    local contrast / dehaze / sharpening and for redrawn content.
 *  - `edges`: correlation of the input's and output's gradient maps.
 *  - `redrawn`: share of the tile's 24-px blocks with clear edges in the
 *    input or the output whose edges do not correlate (r < 0.35): things
 *    added, removed or moved. Local enhancement keeps edges where they were;
 *    a generative model does not. Gradients are taken on a 2×2-smoothed
 *    image so resampling and JPEG do not count.
 */
function structure(a: Img, b: Img) {
  const B = 16, NB = B * B * B;
  const lutResidual = (o: Img) => {
    const sum = new Float64Array(NB * 4);
    const bin = (i: number) => ((a.px[i] >> 4) * B + (a.px[i + 1] >> 4)) * B + (a.px[i + 2] >> 4);
    for (let i = 0; i < a.px.length; i += 4) { const k = bin(i) * 4; for (let c = 0; c < 3; c++) sum[k + c] += o.px[i + c]; sum[k + 3]++; }
    let res = 0;
    for (let i = 0; i < a.px.length; i += 4) { const k = bin(i) * 4; for (let c = 0; c < 3; c++) res += Math.abs(o.px[i + c] - sum[k + c] / sum[k + 3]); }
    return res / ((a.px.length / 4) * 3);
  };
  const grad = (im: Img) => {
    const { w, h } = im, g = new Float64Array(w * h);
    const v = (x: number, y: number, c: number) => im.px[(y * w + x) * 4 + c] + im.px[(y * w + x + 1) * 4 + c] + im.px[((y + 1) * w + x) * 4 + c] + im.px[((y + 1) * w + x + 1) * 4 + c];
    for (let y = 2; y < h - 3; y++)
      for (let x = 2; x < w - 3; x++) {
        let s = 0;
        for (let c = 0; c < 3; c++) s += Math.abs(v(x + 1, y, c) - v(x - 1, y, c)) + Math.abs(v(x, y + 1, c) - v(x, y - 1, c));
        g[y * w + x] = s / 4;
      }
    return g;
  };
  const corr = (ga: Float64Array, gb: Float64Array, idx: number[]) => {
    let ma = 0, mb = 0;
    for (const i of idx) { ma += ga[i]; mb += gb[i]; }
    ma /= idx.length; mb /= idx.length;
    let sab = 0, saa = 0, sbb = 0;
    for (const i of idx) { const da = ga[i] - ma, db = gb[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
    return { r: saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0, ea: ma, eb: mb };
  };
  const ga = grad(a), gb = grad(b), all = Array.from(ga.keys());
  const whole = corr(ga, gb, all);
  // the output's edges, brought to the input's overall edge strength (a gain is not a redraw)
  const k = whole.eb > 0 ? whole.ea / whole.eb : 1;
  const S0 = 24;
  let blocks = 0, bad = 0;
  for (let by = 0; by + S0 <= a.h; by += S0)
    for (let bx = 0; bx + S0 <= a.w; bx += S0) {
      const idx: number[] = [];
      for (let y = by; y < by + S0; y++) for (let x = bx; x < bx + S0; x++) idx.push(y * a.w + x);
      const c = corr(ga, gb, idx);
      if (Math.max(c.ea, c.eb * k) < 12) continue; // flat in both: nothing to keep or lose
      blocks++;
      if (c.r < 0.35) bad++;
    }
  return {
    pointwise: Math.max(0, lutResidual(b) - lutResidual(a)),
    edges: whole.ea > 1 ? whole.r : NaN,
    redrawn: blocks ? bad / blocks : NaN,
  };
}

/** The look in OKLab: lightness shift, chroma ratio, lightness contrast ratio, mean hue of the output. */
function look(a: Img, b: Img) {
  const st = (im: Img) => {
    let L = 0, L2 = 0, C = 0, A = 0, Bb = 0;
    const n = im.px.length / 4;
    for (let i = 0; i < im.px.length; i += 4) {
      const [l, aa, bb] = toOklab(srgbToLinear(im.px[i] / 255), srgbToLinear(im.px[i + 1] / 255), srgbToLinear(im.px[i + 2] / 255));
      L += l; L2 += l * l; C += Math.hypot(aa, bb); A += aa; Bb += bb;
    }
    L /= n;
    return { L, sd: Math.sqrt(Math.max(0, L2 / n - L * L)), C: C / n, hue: ((Math.atan2(Bb, A) * 180) / Math.PI + 360) % 360 };
  };
  const x = st(a), y = st(b);
  return { dL: y.L - x.L, chroma: y.C / Math.max(1e-4, x.C), contrast: y.sd / Math.max(1e-4, x.sd), hueIn: x.hue, hueOut: y.hue };
}

type ChromaError = (px: Uint8ClampedArray, pw: number, ph: number, t: unknown) => { err: number };

const chromaOf = (im: Img, t: Tile) => (S as unknown as { chromaError: ChromaError }).chromaError(im.px, TW, TH, t.truth).err;

/** Everything one tile tells (input / output at tile size 720 × 600). */
function tileRow(t: Tile, inT: Img, outT: Img, scale: number, context?: number) {
  const chroma = (S as unknown as { chromaError: ChromaError }).chromaError;
  const r: Record<string, unknown> = { tile: t.label, in: meanRGB(inT).join(','), out: meanRGB(outT).join(','), clip: +clipPct(outT).toFixed(1) };
  if (context !== undefined) r.context = +context.toFixed(1);
  if (t.truth) r.colourErr = `${chroma(inT.px, TW, TH, t.truth).err.toFixed(3)} → ${chroma(outT.px, TW, TH, t.truth).err.toFixed(3)}`;
  if (t.key === 'chart') { const c = chartMetrics(t.probe!, outT, inT); r.detail = `色卡 ΔE ${c.chartDeltaE.raw.toFixed(3)} → ${c.chartDeltaE.out.toFixed(3)}，灰塊彩度 ${c.greyChroma.toFixed(3)}`; }
  if (t.key === 'depth') r.detail = '深度 ΔE ' + depthMetrics(t.probe!, outT, inT).map((d) => `${d.d}m ${d.rawDeltaE.toFixed(2)}→${d.outDeltaE.toFixed(2)}`).join(' ');
  if (t.key === 'wedge') {
    const w = oodMetrics({ meta: { grey: true } } as Probe, crop(outT, 0, 0, TW, 240), crop(inT, 0, 0, TW, 240)), rp = rampMetrics(t.probe!, outT);
    r.detail = `灰階彩度 ${w.maxChroma.toFixed(3)}、改變 ${w.meanChangeDeltaE.toFixed(3)}；漸層列差 ${rp.rampRowSpreadLevels.toFixed(1)}、最大跳階 ${rp.rampMaxExtraJumpLevels.toFixed(1)}`;
  }
  if (t.key === 'land') r.detail = `陸地改變 ΔE ${oodMetrics({} as Probe, outT, inT).meanChangeDeltaE.toFixed(3)}`;
  if (t.key === 'impulse') {
    // spread: farthest pixel that differs from the tile's own background by > 8 levels (JPEG-safe)
    const bg = meanRGB(crop(outT, 0, 0, 120, 120));
    let rad = 0;
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) { const k = (y * TW + x) * 4; if (Math.max(...[0, 1, 2].map((c) => Math.abs(outT.px[k + c] - bg[c]))) > 8) rad = Math.max(rad, Math.hypot(x - TW / 2, y - TH / 2)); }
    r.detail = `白點影響半徑 ${(rad * scale).toFixed(1)} px（輸出解析度）`;
  }
  return r;
}

export function analyze(out: Img) {
  const { img: input, tiles: T } = sheet();
  if (Math.abs(out.w / out.h - SHEET_W / SHEET_H) > 0.01) console.warn(`warning: aspect ${(out.w / out.h).toFixed(3)} ≠ sheet ${(SHEET_W / SHEET_H).toFixed(3)} — cropped or padded? results are unreliable`);
  const o = resize(out, SHEET_W, SHEET_H);
  const ins = T.map((t) => crop(input, t.x, t.y, TW, TH));
  const outs = T.map((t) => crop(o, t.x, t.y, TW, TH));
  // the context test compares pixels, so it runs at the app's own size (the
  // input is reduced to it; enlarging the output would blur and add a bias)
  const k = Math.min(1, out.w / SHEET_W);
  const inK = k < 1 ? resize(input, out.w, out.h) : input, outK = k < 1 ? out : o;
  const tw = Math.floor(TW * k) - 2, th = Math.floor(TH * k) - 2;
  const at = (t: Tile) => [Math.ceil(t.x * k) + 1, Math.ceil(t.y * k) + 1] as const;
  const insK = T.map((t) => crop(inK, ...at(t), tw, th)), outsK = T.map((t) => crop(outK, ...at(t), tw, th));
  const ctx = contextDependence(insK, outsK, tw, th);
  const str = T.map((_, i) => structure(insK[i], outsK[i]));
  const rows: Record<string, unknown>[] = T.map((t, i) => ({ ...tileRow(t, ins[i], outs[i], out.w / SHEET_W, ctx[i].context), pointwise: +str[i].pointwise.toFixed(1), edges: +str[i].edges.toFixed(2), redrawn: Number.isNaN(str[i].redrawn) ? NaN : Math.round(100 * str[i].redrawn) }));
  // the water scenes ①–⑥ and ⑫: the mode's look and how much it redraws
  const scenes = T.map((_, i) => i).filter((i) => T[i].truth);
  const avg = (f: (i: number) => number) => scenes.reduce((a, i) => a + f(i), 0) / scenes.length;
  const looks = scenes.map((i) => look(insK[i], outsK[i]));
  const la = (f: (l: ReturnType<typeof look>) => number) => looks.reduce((a, l) => a + f(l), 0) / looks.length;
  const chart = chartMetrics(T[6].probe!, outs[6], ins[6]);
  const summary = {
    size: `${out.w}×${out.h}`, mp: (out.w * out.h) / 1e6,
    edges: avg((i) => str[i].edges), pointwise: avg((i) => str[i].pointwise), redrawn: avg((i) => str[i].redrawn),
    // the most redrawn tile of all (the land photo and chart included)
    redrawnMax: Math.max(...str.map((x) => x.redrawn).filter((v) => !Number.isNaN(v))),
    redrawnTile: T[str.reduce((bi, x, i) => (x.redrawn > (str[bi].redrawn || 0) ? i : bi), 0)].label,
    dL: la((l) => l.dL), chroma: la((l) => l.chroma), contrast: la((l) => l.contrast), hueOut: la((l) => l.hueOut),
    red: avg((i) => meanRGB(outs[i])[0]), redIn: avg((i) => meanRGB(ins[i])[0]),
    errIn: avg((i) => chromaOf(ins[i], T[i])), errOut: avg((i) => chromaOf(outs[i], T[i])),
    chartIn: chart.chartDeltaE.raw, chartOut: chart.chartDeltaE.out, greyChroma: chart.greyChroma,
    land: oodMetrics({} as Probe, outs[9], ins[9]).meanChangeDeltaE,
  };
  const rep = meanAbs(outs[0], outs[11]);
  const ctxVals = ctx.filter((c) => c.shared > 0.05).map((c) => c.context);
  const ctxMean = ctxVals.reduce((a, b) => a + b, 0) / Math.max(1, ctxVals.length);
  const verdict =
    ctxMean < 1.5 ? '全域：同一輸入色在每一格輸出相同 → 整張圖套一套轉換（各場景的分別處理無法從這張圖得知，見下方建議）'
    : ctxMean < 4 ? '部分依內容：大致同一套轉換，加上局部或依區塊的調整'
    : '依內容／局部處理：每一格的處理不同 → 各格就是各場景的獨立量測';
  return { rows, repeatDiff: rep, contextMean: ctxMean, verdict, summary };
}

const redrawVerdict = (m: { redrawn: number; redrawnMax: number; redrawnTile: string; pointwise: number }) =>
  (m.redrawn > 0.08 || m.redrawnMax > 0.2 ? '內容被重繪（生成式：物件增減、移位）— 不是可逆的調色，只能仿風格'
  : m.redrawnMax > 0.025 ? `結構大致保留，局部有物件被抹除或補畫（最多：${m.redrawnTile.trim()}）`
  : '結構保留') +
  (m.pointwise > 3 ? '；加上局部增強（局部對比／去霧／銳化）' : '；以調色為主（逐點，可用曲線／LUT 重現）');

function print(R: ReturnType<typeof analyze>) {
  console.log(`判定：${R.verdict}`);
  console.log(`  情境相依度（同色在不同格的輸出差，平均）${R.contextMean.toFixed(1)} 階；① 與 ⑫（同圖換位置）差 ${R.repeatDiff.toFixed(1)} 階${R.repeatDiff < 2 ? '（無位置先驗）' : '（位置會影響結果）'}`);
  const m = R.summary;
  console.log(`  輸出 ${m.size}（${m.mp.toFixed(1)} MP；輸入 ${SHEET_W}×${SHEET_H}）${m.mp < 0.6 * (SHEET_W * SHEET_H) / 1e6 ? ' — 解析度被降低' : ''}`);
  console.log(`  結構（水下 7 格）：重繪區塊 ${(100 * m.redrawn).toFixed(0)}%（最多一格 ${(100 * m.redrawnMax).toFixed(0)}%）、邊緣相關 ${m.edges.toFixed(2)}、非逐點變化 ${m.pointwise.toFixed(1)} 階 → ${redrawVerdict(m)}`);
  console.log(`  風格：亮度 ${m.dL >= 0 ? '+' : ''}${m.dL.toFixed(3)}、彩度 ×${m.chroma.toFixed(2)}、反差 ×${m.contrast.toFixed(2)}、色相 ${m.hueOut.toFixed(0)}°、紅 ${m.redIn.toFixed(0)}→${m.red.toFixed(0)}；色差 ${m.errIn.toFixed(3)}→${m.errOut.toFixed(3)}`);
  for (const r of R.rows) console.log(`  ${String(r.tile).padEnd(18)} 平均 ${r.in} → ${r.out} · 裁切 ${r.clip}% · 情境 ${r.context} · 非逐點 ${r.pointwise}${Number.isNaN(r.redrawn) ? '' : ` · 重繪 ${r.redrawn}%`}${r.colourErr ? ` · 色差 ${r.colourErr}` : ''}${r.detail ? ` · ${r.detail}` : ''}`);
  if (R.contextMean < 1.5)
    console.log('  建議：要分別知道各場景的處理，請把場景分開各拍一張；優先順序 ②綠水 → ④閃燈 → ⑤淺水陽光 → ⑥深藍 → ③混濁（①已在整張的判斷中）。');
}

async function decode(file: string): Promise<Img> {
  const { chromium } = await import('playwright');
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const p = await b.newPage();
  const r = await p.evaluate(async (b64: string) => {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u]), { colorSpaceConversion: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, px: Array.from(g.getImageData(0, 0, bmp.width, bmp.height).data) };
  }, readFileSync(file).toString('base64'));
  await b.close();
  return { px: Uint8ClampedArray.from(r.px), w: r.w, h: r.h };
}

/** Selftest: known "apps" built from this engine, at a quarter of the size. */
function selftest() {
  const { img } = sheet();
  const small = resize(img, SHEET_W / 4, SHEET_H / 4);
  const apps: [string, (im: Img) => Img][] = [
    ['no change', (im) => im],
    ['global pointwise (全自動-Diverout)', (im) => runStill(im, { diverout: 1, redComp: 0, blueComp: 0, dehaze: 0, depthColor: 0, wbStrength: 0, deCast: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, blacks: 0, whites: 1, clahe: 0, clarity: 0, vibrance: 0, vivid: 0, waterTint: 1 } as never)],
    ['this engine, 全自動 (global + local contrast)', (im) => runStill(im)],
    ['per-tile gains (a content-aware app)', (im) => {
      const o = { px: im.px.slice(), w: im.w, h: im.h };
      // each tile gets its own colour balance, as a per-scene AI would
      for (let y = 0; y < im.h; y++)
        for (let x = 0; x < im.w; x++) {
          const t = Math.floor((x * COLS) / im.w) + Math.floor((y * ROWS) / im.h) * COLS, i = (y * im.w + x) * 4;
          const g = [1 + 0.06 * t, 1 - 0.03 * t, 0.9 + 0.02 * t];
          for (let c = 0; c < 3; c++) o.px[i + c] = Math.min(255, im.px[i + c] * g[c]);
        }
      return o;
    }],
    ['objects erased (a generative app)', (im) => {
      const o = { px: im.px.slice(), w: im.w, h: im.h };
      // the lower-left quarter of every tile painted over with the water colour
      for (let y = 0; y < im.h; y++)
        for (let x = 0; x < im.w; x++) {
          const tx = (x * COLS) / im.w, ty = (y * ROWS) / im.h, fx = tx % 1, fy = ty % 1;
          if (fx < 0.08 || fx > 0.5 || fy < 0.5 || fy > 0.94) continue;
          const src = ((Math.floor((Math.floor(ty) + 0.15) * (im.h / ROWS))) * im.w + x) * 4, i = (y * im.w + x) * 4;
          for (let c = 0; c < 3; c++) o.px[i + c] = im.px[src + c];
        }
      return o;
    }],
  ];
  for (const [name, f] of apps) {
    const R = analyze(f(small));
    console.log(`\n=== selftest: ${name}`);
    console.log(`  ${R.verdict.split('：')[0]} · context ${R.contextMean.toFixed(1)} · repeat ${R.repeatDiff.toFixed(1)} · redrawn ${(100 * R.summary.redrawn).toFixed(0)}% · pointwise ${R.summary.pointwise.toFixed(1)}`);
  }
}

const [cmd, arg, arg2] = process.argv.slice(2);
const fileOf = (t: Tile) => `${String(t.id).padStart(2, '0')}-${t.key}.png`;
if (cmd === 'export' && arg) {
  writeFileSync(arg, png(sheet().img));
  console.log(`${arg}: ${SHEET_W}×${SHEET_H}, 12 tiles`);
} else if (cmd === 'compare' && arg) print(analyze(await decode(arg)));
else if (cmd === 'tiles' && arg) {
  // the tiles one by one (for an app that turns out to treat the sheet as one scene)
  const { mkdirSync } = await import('node:fs');
  mkdirSync(arg, { recursive: true });
  for (const t of tiles()) writeFileSync(`${arg}/${fileOf(t)}`, png(t.img));
  console.log(`${arg}: ${tiles().map(fileOf).join(', ')}`);
} else if (cmd === 'compare-tile' && arg && arg2) {
  const t = tiles().find((x) => String(x.id) === arg || x.key === arg);
  if (!t) throw new Error(`no tile ${arg} (1–12 or ${tiles().map((x) => x.key).join(' / ')})`);
  const out = await decode(arg2);
  const r = tileRow(t, t.img, resize(out, TW, TH), out.w / TW);
  console.log(`${r.tile} 平均 ${r.in} → ${r.out} · 裁切 ${r.clip}%${r.colourErr ? ` · 色差 ${r.colourErr}` : ''}${r.detail ? ` · ${r.detail}` : ''}`);
} else if (cmd === 'modes' && arg) {
  // several outputs of the same sheet (one per mode of an app) side by side
  const files = process.argv.slice(3);
  const rows: string[][] = [['模式', '判定', '情境', '重繪', '亮度', '彩度', '反差', '色相', '紅', '色差', '色卡ΔE', '灰塊', '陸地']];
  for (const f of files) {
    const R = analyze(await decode(f)), m = R.summary;
    rows.push([f.replace(/^.*\//, '').replace(/\.[^.]+$/, ''), R.verdict.split('：')[0], R.contextMean.toFixed(1), `${(100 * m.redrawn).toFixed(0)}%`,
      (m.dL >= 0 ? '+' : '') + m.dL.toFixed(3), '×' + m.chroma.toFixed(2), '×' + m.contrast.toFixed(2), m.hueOut.toFixed(0) + '°',
      `${m.redIn.toFixed(0)}→${m.red.toFixed(0)}`, `${m.errIn.toFixed(2)}→${m.errOut.toFixed(2)}`, `${m.chartIn.toFixed(3)}→${m.chartOut.toFixed(3)}`, m.greyChroma.toFixed(3), m.land.toFixed(3)]);
  }
  for (const r of rows) console.log('| ' + r.join(' | ') + ' |');
} else if (cmd === 'selftest') selftest();
else console.log('usage: probe-sheet.ts export <file.png> | compare <app-output> | modes <out1> <out2> … | tiles <dir> | compare-tile <1-12|key> <app-output> | selftest');
