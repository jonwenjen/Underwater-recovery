/**
 * The probe materials of scripts/probes.ts, generated deterministically so
 * our engine and any other app see exactly the same pixels. Water is the
 * Jaffe–McGlamery model of scripts/verify-scene.js:
 *   I = J·E·t + B·(1 − t),  t = exp(−β·d),  E = exp(−K·depth)
 */
import './verify-scene.js';

export interface Probe {
  name: string;
  /** What the probe tells apart (shown in the kit README). */
  purpose: string;
  img: { px: Uint8ClampedArray; w: number; h: number };
  /** Clips (probe 5): the frames, 30 fps. */
  frames?: { px: Uint8ClampedArray; w: number; h: number }[];
  meta?: unknown;
}

type Scene = {
  truth(w: number, h: number, pan?: number, seed?: number): { w: number; h: number; J: Float32Array; d: Float32Array };
  degrade(t: unknown, water?: string, depth?: number, seed?: number, opts?: object): Uint8ClampedArray;
  clean(t: unknown): Uint8ClampedArray;
  WATER: Record<string, { beta: number[]; K: number[]; B: number[] }>;
};
export const S = (globalThis as unknown as { __scene: Scene }).__scene;

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (l: number) => {
  const v = Math.min(1, Math.max(0, l));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
};
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

let lastGain = 1;

/**
 * The physics limit: invert the formation model with the true water, depth,
 * distance and exposure gain — what a method with perfect knowledge would
 * get from these 8-bit pixels. Anything an app shows beyond this is invented.
 */
export function oracle(px: Uint8ClampedArray, d: number, water: string, depth: number, gain: number, i: number): number[] {
  const W = S.WATER[water];
  return [0, 1, 2].map((c) => {
    const t = Math.exp(-W.beta[c] * d), E = Math.exp(-W.K[c] * depth);
    const I = toLin(px[i * 4 + c] / 255) / gain;
    return toSrgb((I - W.B[c] * (1 - t)) / (E * t));
  });
}

/**
 * Put a scene (sRGB J and distance d per pixel) under water at `depth`, with
 * the camera's auto-exposure to a mid-grey mean, 8-bit with ±1.5 dither.
 */
export function underwater(J: Float32Array, d: Float32Array, w: number, h: number, water = 'blue', depth = 6, seed = 5) {
  const W = S.WATER[water];
  const E = W.K.map((k) => Math.exp(-k * depth));
  const n = w * h;
  const lin = new Float32Array(n * 3);
  let lsum = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const t = Math.exp(-W.beta[c] * d[i]);
      lin[i * 3 + c] = toLin(J[i * 3 + c]) * E[c] * t + W.B[c] * (1 - t);
    }
    lsum += 0.2126 * lin[i * 3] + 0.7152 * lin[i * 3 + 1] + 0.0722 * lin[i * 3 + 2];
  }
  const gain = 0.16 / (lsum / n);
  lastGain = gain;
  const r = rng(seed);
  const px = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) px[i * 4 + c] = Math.round(toSrgb(lin[i * 3 + c] * gain) * 255 + (r() - 0.5) * 3);
    px[i * 4 + 3] = 255;
  }
  return px;
}

/** X-Rite ColorChecker (2005, sRGB D65), row by row; the last row is the neutral scale. */
export const MACBETH = [
  [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170],
  [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
  [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161],
  [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52],
];

export function PROBES(): Probe[] {
  const out: Probe[] = [];
  const solid = (w: number, h: number, rgb: number[]) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) px.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
    return px;
  };

  /* 1a — colour chart 2 m away at 6 m depth, on a grey board */
  {
    const w = 312, h = 216, s = 40, gap = 10, x0 = 11, y0 = 13;
    const J = new Float32Array(w * h * 3).fill(0.45), d = new Float32Array(w * h).fill(2);
    const patches: { x: number; y: number; s: number; rgb: number[]; grey: boolean }[] = [];
    MACBETH.forEach((c, k) => {
      const x = x0 + (k % 6) * (s + gap), y = y0 + Math.floor(k / 6) * (s + gap);
      patches.push({ x, y, s, rgb: c.map((v) => v / 255), grey: k >= 18 });
      for (let yy = y; yy < y + s; yy++) for (let xx = x; xx < x + s; xx++) J.set(c.map((v) => v / 255), (yy * w + xx) * 3);
    });
    const px = underwater(J, d, w, h);
    out.push({ name: '1-chart', purpose: '色卡在 6 m 深、2 m 距離的藍水中：色彩還原 ΔE、灰階是否中性', img: { px, w, h }, meta: { patches, water: 'blue', depth: 6, dist: 2, gain: lastGain } });
  }
  /* 1b — ramps: R, G, B, cyan, grey, 0→255, identical rows */
  {
    const w = 256, bands = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 1, 1], [1, 1, 1]], bh = 24, h = bands.length * bh;
    const px = new Uint8ClampedArray(w * h * 4);
    const ramps: { y: number; h: number }[] = [];
    bands.forEach((b, k) => {
      ramps.push({ y: k * bh, h: bh });
      for (let y = k * bh; y < (k + 1) * bh; y++) for (let x = 0; x < w; x++) px.set([b[0] * x, b[1] * x, b[2] * x, 255], (y * w + x) * 4);
    });
    out.push({ name: '1-ramps', purpose: '純色漸層（每列相同）：斷階、同色不同位置是否輸出相同（點運算 vs 空間運算）', img: { px, w, h }, meta: { ramps } });
  }
  /* 2 — the same red object at 1, 5, 10, 20 m in front of a far wall */
  {
    const w = 320, h = 200, s = 52, rgb = [0.75, 0.15, 0.12];
    const J = new Float32Array(w * h * 3), d = new Float32Array(w * h).fill(30);
    const r = rng(9);
    for (let i = 0; i < w * h; i++) {
      const v = 0.5 + (r() - 0.5) * 0.12;
      J.set([v * 1.05, v, v * 0.85], i * 3);
    }
    const objects = [1, 5, 10, 20].map((dist, k) => ({ x: 16 + k * 76, y: 74, s, d: dist }));
    for (const o of objects)
      for (let y = o.y; y < o.y + s; y++)
        for (let x = o.x; x < o.x + s; x++) {
          J.set(rgb, (y * w + x) * 3);
          d[y * w + x] = o.d;
        }
    const px = underwater(J, d, w, h, 'blue', 5);
    out.push({ name: '2-depth-ramp', purpose: '同一紅色物體在 1/5/10/20 m：遠處紅色補償是否隨距離增加（深度感知）', img: { px, w, h }, meta: { objects, rgb, water: 'blue', depth: 5, gain: lastGain } });
  }
  /* 3 — out of distribution: neutral wedge, and a land picture */
  {
    const w = 256, h = 64, px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([x, x, x, 255], (y * w + x) * 4);
    out.push({ name: '3-grey-wedge', purpose: '無色灰階：輸出是否仍中性（不該被當成水下而染紅）', img: { px, w, h }, meta: { grey: true } });
    const t = S.truth(256, 160, 0.2, 21);
    out.push({ name: '3-land', purpose: '非水下（陸地光線）畫面：應幾乎不改變', img: { px: S.clean(t), w: 256, h: 160 } });
  }
  /* 4 — impulse: 3×3 white on cyan (0, 128, 128) */
  {
    const w = 192, h = 192, cx = 96, cy = 96, px = solid(w, h, [0, 128, 128]);
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) px.set([255, 255, 255, 255], (y * w + x) * 4);
    out.push({ name: '4-impulse', purpose: '青色背景中央 3×3 白點：影響範圍＝有效感受野（0 ＝逐像素 LUT）', img: { px, w, h }, meta: { cx, cy } });
  }
  /* 5 — a 1 s clip, panning while descending 8 → 9.5 m; frame 15 is replaced in the test */
  {
    const w = 256, h = 144;
    const frames = Array.from({ length: 31 }, (_, i) => ({ px: S.degrade(S.truth(w, h, i * 0.004, 7), 'blue', 8 + i * 0.05, i), w, h }));
    out.push({ name: '5-clip', purpose: '1 秒水下影片；第 15 幀換成全黑或陸地畫面：第 16 幀起多快恢復（跨幀記憶）', img: frames[0], frames });
    out.push({ name: '5-land-frame', purpose: '插入用的陸地畫面', img: { px: S.clean(S.truth(w, h, 0.3, 11)), w, h } });
  }
  /* 6 — flips: a plain scene, and one with a sunlit surface band and beams at the top */
  {
    const t = S.truth(256, 160, 0, 7);
    out.push({ name: '6-scene', purpose: '水下畫面（翻轉測試用）：上下顛倒後效果是否跟著翻轉', img: { px: S.degrade(t, 'blue', 8, 3), w: 256, h: 160 } });
    out.push({ name: '6-scene-surface', purpose: '有水面高光與光束的水下畫面（翻轉測試用）', img: { px: S.degrade(t, 'blue', 4, 3, { beams: true, surface: true }), w: 256, h: 160 } });
  }
  return out;
}
