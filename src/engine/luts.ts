/**
 * Lookup tables built on the CPU and uploaded as textures: CLAHE tile maps and
 * the master tone curve. Both have `sample*` twins so the analysis mirror and
 * the tests evaluate exactly what the shader will.
 */
import { clamp } from './color.ts';

export const CLAHE_BINS = 256;

/**
 * Contrast-limited adaptive histogram equalisation (Zuiderveld), one 256-entry
 * map per tile, laid out row after row: `lut[(ty*T + tx)*256 + bin]`.
 * Maps use the mid-bin CDF so a flat histogram is (almost) the identity.
 */
export function buildClahe(L: Float32Array, w: number, h: number, tiles: number, clip: number): Float32Array {
  const T = tiles;
  const lut = new Float32Array(T * T * CLAHE_BINS);
  const hist = new Float32Array(CLAHE_BINS);
  for (let ty = 0; ty < T; ty++) {
    const y0 = Math.floor((ty * h) / T),
      y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / T));
    for (let tx = 0; tx < T; tx++) {
      const x0 = Math.floor((tx * w) / T),
        x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / T));
      hist.fill(0);
      let count = 0;
      for (let y = y0; y < Math.min(h, y1); y++)
        for (let x = x0; x < Math.min(w, x1); x++) {
          hist[clamp(Math.round(L[y * w + x] * 255), 0, 255)]++;
          count++;
        }
      const base = (ty * T + tx) * CLAHE_BINS;
      if (count === 0) {
        for (let i = 0; i < CLAHE_BINS; i++) lut[base + i] = i / 255;
        continue;
      }
      const limit = Math.max(1, (clip * count) / CLAHE_BINS);
      let excess = 0;
      for (let i = 0; i < CLAHE_BINS; i++)
        if (hist[i] > limit) {
          excess += hist[i] - limit;
          hist[i] = limit;
        }
      const inc = excess / CLAHE_BINS;
      let cum = 0;
      for (let i = 0; i < CLAHE_BINS; i++) {
        const hi = hist[i] + inc;
        lut[base + i] = (cum + 0.5 * hi) / count;
        cum += hi;
      }
    }
  }
  return lut;
}

/** Bilinear-in-space, linear-in-value CLAHE lookup — mirrors `claheMap` in GLSL. */
export function sampleClahe(lut: Float32Array, T: number, L: number, u: number, v: number): number {
  const fx = clamp(u * T - 0.5, 0, T - 1),
    fy = clamp(v * T - 0.5, 0, T - 1);
  const x0 = Math.floor(fx),
    y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, T - 1),
    y1 = Math.min(y0 + 1, T - 1);
  const wx = fx - x0,
    wy = fy - y0;
  const b = clamp(L, 0, 1) * 255;
  const i0 = Math.min(254, Math.floor(b));
  const wb = b - i0;
  const a00 = (y0 * T + x0) * CLAHE_BINS + i0,
    a01 = (y0 * T + x1) * CLAHE_BINS + i0,
    a10 = (y1 * T + x0) * CLAHE_BINS + i0,
    a11 = (y1 * T + x1) * CLAHE_BINS + i0;
  const v00 = lut[a00] + (lut[a00 + 1] - lut[a00]) * wb;
  const v01 = lut[a01] + (lut[a01 + 1] - lut[a01]) * wb;
  const v10 = lut[a10] + (lut[a10 + 1] - lut[a10]) * wb;
  const v11 = lut[a11] + (lut[a11 + 1] - lut[a11]) * wb;
  const top = v00 + (v01 - v00) * wx;
  const bot = v10 + (v11 - v10) * wx;
  return top + (bot - top) * wy;
}

export const CURVE_N = 1024;

export interface CurveParams {
  blacks: number; // input black point 0..0.25
  whites: number; // input white point 0.7..1
  contrast: number; // -1..1
  highlights: number; // -1..1
  shadows: number; // -1..1
}

/**
 * Master tone curve on luminance: levels → shadows/highlights bumps →
 * endpoint-preserving contrast, then forced monotonic so no slider
 * combination can invert tones.
 */
export function buildCurve(p: CurveParams): Float32Array {
  const lut = new Float32Array(CURVE_N);
  const span = Math.max(0.05, p.whites - p.blacks);
  const c = clamp(p.contrast, -1, 1) * 0.45;
  for (let i = 0; i < CURVE_N; i++) {
    let v = clamp((i / (CURVE_N - 1) - p.blacks) / span, 0, 1);
    // bumps peak at 1/3 (shadows) and 2/3 (highlights), normalised to 1
    v += 0.28 * p.shadows * 6.75 * v * (1 - v) * (1 - v);
    v += 0.28 * p.highlights * 6.75 * v * v * (1 - v);
    v = clamp(v, 0, 1);
    v += c * (v - 0.5) * 4 * v * (1 - v);
    lut[i] = clamp(v, 0, 1);
  }
  for (let i = 1; i < CURVE_N; i++) if (lut[i] < lut[i - 1]) lut[i] = lut[i - 1];
  return lut;
}

export function sampleCurve(lut: Float32Array, x: number): number {
  const f = clamp(x, 0, 1) * (CURVE_N - 1);
  const i = Math.min(CURVE_N - 2, Math.floor(f));
  return lut[i] + (lut[i + 1] - lut[i]) * (f - i);
}
