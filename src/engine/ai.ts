/**
 * 🤖 AI 風格 (FUnIE-GAN) — how a network run at low resolution drives the
 * full-resolution picture.
 *
 * FUnIE-GAN (Islam, Xia & Sattar, RA-L 2020; MIT licence, weights from
 * github.com/xahidbuffon/FUnIE-GAN, see public/models/FUnIE-GAN-LICENSE) is a
 * 7 M-parameter U-Net: in a browser without a fast GPU it takes ~0.4 s at
 * 256 px and seconds at HD. So it runs on a small copy of the frame (long edge
 * ≤ 512), and what it did is captured as a smooth grid of 3×4 colour
 * transforms — each tile's least-squares fit of output ← [r, g, b, 1] of the
 * input, Gaussian-weighted around the tile centre and pulled toward the
 * whole-frame fit so sparse tiles stay sane. The GRADE pass interpolates the
 * grid and applies it to the full-resolution source (sRGB, like the network):
 * full detail, the network's colour and tone, and a video can refresh the grid
 * every few frames. The CPU mirror applies the same grid (applyGuide).
 */
import { clamp } from './color.ts';

/** Seconds of video between network re-runs (and on every cut); the grid is blended in. */
export const AI_REFRESH_S = 0.5;

export interface AiGuide {
  gx: number;
  gy: number;
  /** gx·gy tiles × 12 coefficients: rows R, G, B of [r, g, b, 1] (sRGB 0..1). */
  m: Float32Array;
}

/** Identity transform grid. */
export function identityGuide(gx = 1, gy = 1): AiGuide {
  const m = new Float32Array(gx * gy * 12);
  for (let t = 0; t < gx * gy; t++) {
    m[t * 12] = 1;
    m[t * 12 + 5] = 1;
    m[t * 12 + 10] = 1;
  }
  return { gx, gy, m };
}

/** Solve a 4×4 system in place (Gaussian elimination, partial pivoting). */
function solve4(A: Float64Array, b: Float64Array, out: Float64Array, o: number): void {
  const M = Float64Array.from(A), y = Float64Array.from(b);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(M[r * 4 + c]) > Math.abs(M[p * 4 + c])) p = r;
    if (p !== c) {
      for (let k = 0; k < 4; k++) [M[c * 4 + k], M[p * 4 + k]] = [M[p * 4 + k], M[c * 4 + k]];
      [y[c], y[p]] = [y[p], y[c]];
    }
    const d = M[c * 4 + c] || 1e-12;
    for (let r = c + 1; r < 4; r++) {
      const f = M[r * 4 + c] / d;
      for (let k = c; k < 4; k++) M[r * 4 + k] -= f * M[c * 4 + k];
      y[r] -= f * y[c];
    }
  }
  for (let r = 3; r >= 0; r--) {
    let s = y[r];
    for (let k = r + 1; k < 4; k++) s -= M[r * 4 + k] * out[o + k];
    out[o + r] = s / (M[r * 4 + r] || 1e-12);
  }
}

/**
 * Fit the grid: `src` and `out` are RGBA 8-bit (input to and output of the
 * network) at w × h. `lambda` pulls each tile toward the whole-frame fit.
 */
export function fitGuide(src: Uint8Array | Uint8ClampedArray, out: Uint8Array | Uint8ClampedArray, w: number, h: number, gx: number, gy: number, lambda = 0.02): AiGuide {
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 40000))); // ≤ ~40 k samples
  const xs: number[] = [], ys: number[] = [];
  const X: number[] = [], Y: number[] = [];
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      xs.push((x + 0.5) / w);
      ys.push((y + 0.5) / h);
      X.push(src[i] / 255, src[i + 1] / 255, src[i + 2] / 255);
      Y.push(out[i] / 255, out[i + 1] / 255, out[i + 2] / 255);
    }
  const n = xs.length;
  const fit = (wt: (k: number) => number, prior: Float64Array | null, lam: number, dst: Float64Array) => {
    const A = new Float64Array(16), B = [new Float64Array(4), new Float64Array(4), new Float64Array(4)];
    let sw = 0;
    for (let k = 0; k < n; k++) {
      const wk = wt(k);
      if (wk < 1e-4) continue;
      sw += wk;
      const v = [X[k * 3], X[k * 3 + 1], X[k * 3 + 2], 1];
      for (let a = 0; a < 4; a++) {
        for (let b = 0; b < 4; b++) A[a * 4 + b] += wk * v[a] * v[b];
        for (let c = 0; c < 3; c++) B[c][a] += wk * v[a] * Y[k * 3 + c];
      }
    }
    const reg = lam * Math.max(sw, 1);
    for (let a = 0; a < 4; a++) A[a * 4 + a] += reg;
    for (let c = 0; c < 3; c++) {
      if (prior) for (let a = 0; a < 4; a++) B[c][a] += reg * prior[c * 4 + a];
      else B[c][c] += reg; // toward identity
      solve4(A, B[c], dst, c * 4);
    }
  };
  const glob = new Float64Array(12);
  fit(() => 1, null, 1e-3, glob);
  const m = new Float32Array(gx * gy * 12);
  const sx = 0.75 / gx, sy = 0.75 / gy;
  const t = new Float64Array(12);
  for (let ty = 0; ty < gy; ty++)
    for (let tx = 0; tx < gx; tx++) {
      const cx = (tx + 0.5) / gx, cy = (ty + 0.5) / gy;
      fit((k) => Math.exp(-(((xs[k] - cx) / sx) ** 2 + ((ys[k] - cy) / sy) ** 2) / 2), glob, lambda, t);
      m.set(t, (ty * gx + tx) * 12);
    }
  return { gx, gy, m };
}

/** Bilinear interpolation of the tile transforms at (u, v) into `t` (12). Mirrors GRADE_FS. */
export function guideAt(g: AiGuide, u: number, v: number, t: Float32Array): Float32Array {
  const fx = clamp(u * g.gx - 0.5, 0, g.gx - 1), fy = clamp(v * g.gy - 0.5, 0, g.gy - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(g.gx - 1, x0 + 1), y1 = Math.min(g.gy - 1, y0 + 1);
  const ax = fx - x0, ay = fy - y0;
  const a = (y0 * g.gx + x0) * 12, b = (y0 * g.gx + x1) * 12, c = (y1 * g.gx + x0) * 12, d = (y1 * g.gx + x1) * 12;
  for (let k = 0; k < 12; k++)
    t[k] = (g.m[a + k] * (1 - ax) + g.m[b + k] * ax) * (1 - ay) + (g.m[c + k] * (1 - ax) + g.m[d + k] * ax) * ay;
  return t;
}

/** Apply the grid to one sRGB colour in place, blended by `amount`. Mirrors GRADE_FS. */
export function applyGuide(px: Float32Array, g: AiGuide, u: number, v: number, amount: number, t: Float32Array): void {
  guideAt(g, u, v, t);
  const r = px[0], gg = px[1], b = px[2];
  for (let c = 0; c < 3; c++) {
    const y = t[c * 4] * r + t[c * 4 + 1] * gg + t[c * 4 + 2] * b + t[c * 4 + 3];
    px[c] = clamp(px[c] + (clamp(y, 0, 1) - px[c]) * amount, 0, 1);
  }
}

/** Blend a new grid into the current one (video): `k` of the new. */
export function blendGuide(cur: AiGuide | null, next: AiGuide, k: number): AiGuide {
  if (!cur || cur.gx !== next.gx || cur.gy !== next.gy || k >= 1) return next;
  const m = new Float32Array(cur.m.length);
  for (let i = 0; i < m.length; i++) m[i] = cur.m[i] + (next.m[i] - cur.m[i]) * k;
  return { gx: cur.gx, gy: cur.gy, m };
}

/** Grid size for a frame: ~8 tiles on the long edge. */
export function gridFor(w: number, h: number): [number, number] {
  return w >= h ? [8, Math.max(2, Math.round((8 * h) / w))] : [Math.max(2, Math.round((8 * w) / h)), 8];
}

/** Network input size: long edge `edge`, both sides multiples of 32 (5 stride-2 stages). */
export function netSize(w: number, h: number, edge: number): [number, number] {
  const s = edge / Math.max(w, h);
  return [Math.max(32, Math.round((w * s) / 32) * 32), Math.max(32, Math.round((h * s) / 32) * 32)];
}
