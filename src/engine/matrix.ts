/**
 * Histogram-gap colour correction — the algorithm behind the
 * `nikolajbech/underwater-image-color-correction` and
 * `bornfree/dive-color-corrector` projects.
 *
 * IMPORTANT — provenance and licence
 * ----------------------------------
 * Both upstream projects are copyleft (nikolajbech ships no licence at all;
 * bornfree is GPL-3.0) and this repository is MIT. No code from either has
 * been copied. This is an independent implementation written from the
 * published algorithm description, and the constants below are the ones the
 * method is defined by. See docs/sources.md for the full provenance record.
 *
 * The method, in one paragraph: find the colour-matrix-free "hue shift" that
 * lifts the image's mean red to a floor value, use that to build a red
 * histogram, treat near-empty histogram bins as candidates, take the WIDEST GAP
 * in that candidate list as the useful tonal range, and rescale each channel
 * so that range fills 0..1. It is a pure per-pixel affine map: no spatial
 * filter, no Lab, no gamma, no iteration over pixels. That makes it
 * effectively free on a GPU and perfectly usable for real-time video.
 *
 * Faithfulness notes (deliberate reproductions of upstream behaviour, not
 * oversights — each is flagged in the tests):
 *  - gains use 256, not 255, and the offset is scaled by 255 at apply time,
 *    so the mapped low/high land at 0/255.06 rather than exactly 0/255;
 *  - the hue-shift loop increments AFTER evaluating, so the returned angle is
 *    one degree past the last one that satisfied the condition, and a fully
 *    starved image saturates at 121, not 120;
 *  - the "1.2" blue factor is applied when building the matrix but NOT when
 *    building the histogram, so the blue term actually subtracted is 20%
 *    larger than the one that was analysed.
 */

import type { Mat3, Vec3 } from './color.ts';

/** Mean red, on the 0..255 scale, that the hue-shift search drives towards. */
export const MIN_AVG_RED = 60;
/** The search stops once the angle exceeds this. */
export const MAX_HUE_SHIFT = 120;
/** Only multiplies the blue term of the red row of the matrix. */
export const BLUE_MAGIC = 1.2;
/** Bin count is a fixed 256, so a sparse bin is `count < numPixels / this`. */
export const THRESHOLD_RATIO = 2000;
/** bornfree analyses a 256x256 downscale, which pins the threshold. */
export const FIXED_ANALYSIS_EDGE = 256;

export interface ColorMatrix {
  /** Row-major 3x3, applied to sRGB-encoded RGB (not linear light). */
  m: Mat3;
  /** Per-channel additive term, already in 0..1 units. */
  off: Vec3;
  /** The hue-shift angle the search settled on, degrees. */
  hueShift: number;
  /** Per-channel [low, high] the gap search chose. */
  range: { low: number; high: number }[];
  /** The threshold actually used, for diagnostics. */
  threshold: number;
}

/**
 * The diagonal hue-shift. Despite the name in both upstream projects this is
 * NOT an HSV rotation and NOT a full 3x3 rotation: each output is scaled only
 * by its own channel, and the caller SUMS the three. The 0.299/0.587/0.114
 * weights are the NTSC luma coefficients; the three coefficients sum to 1, so
 * this redistributes luma into the red term without inventing energy.
 */
export function hueShiftRed(r: number, g: number, b: number, h: number): Vec3 {
  const rad = (h * Math.PI) / 180;
  const U = Math.cos(rad);
  const W = Math.sin(rad);
  return [
    (0.299 + 0.701 * U + 0.168 * W) * r,
    (0.587 - 0.587 * U + 0.330 * W) * g,
    (0.114 - 0.114 * U - 0.497 * W) * b,
  ];
}

/**
 * Search the angle whose shifted-and-summed mean red reaches MIN_AVG_RED.
 *
 * Reproduces the upstream loop exactly, including its off-by-one: the counter
 * is bumped after the value is computed and only then compared, so the angle
 * handed back is one past the last working one and a hopeless image clamps at
 * MAX_HUE_SHIFT + 1.
 */
export function searchHueShift(avg: Vec3, limit = MAX_HUE_SHIFT): number {
  let newAvgRed = avg[0];
  let h = 0;
  while (newAvgRed < MIN_AVG_RED) {
    const s = hueShiftRed(avg[0], avg[1], avg[2], h);
    newAvgRed = s[0] + s[1] + s[2];
    h++;
    if (h > limit) {
      newAvgRed = MIN_AVG_RED;
      break;
    }
  }
  return h;
}

/**
 * Widest gap in a list of ascending values, returned as the pair that brackets
 * it. Ties keep the leftmost gap (`>` not `>=`), which is upstream's choice and
 * does change the result on flat histograms.
 */
export function widestGap(sorted: number[]): { low: number; high: number } {
  let high = 255;
  let low = 0;
  let maxDist = 0;
  for (let i = 1; i < sorted.length; i++) {
    const dist = sorted[i] - sorted[i - 1];
    if (dist > maxDist) {
      maxDist = dist;
      high = sorted[i];
      low = sorted[i - 1];
    }
  }
  return { low, high };
}

/** Bins holding fewer than `threshold` pixels are "sparse" candidates. */
export function sparseBins(hist: Uint32Array, threshold: number): number[] {
  const out: number[] = [0];
  for (let i = 0; i < 256; i++) {
    // The +2 slack is upstream's `hist[i] - threshold < 2`; integer counts
    // make this `count <= floor(threshold + 1)`.
    if (hist[i] - threshold < 2) out.push(i);
  }
  out.push(255);
  return out;
}

/**
 * Below this span, the gap the search found is a hairline between two
 * adjacent empty bins rather than a real tonal range.
 *
 * This is a genuine landmine in the method as published: on a flat or very
 * small image almost every bin is "sparse", the list degenerates to
 * 0,1,2,...,255, every gap is exactly 1, and the leftmost wins — giving
 * high-low = 1 and a red gain of 256. A 2x1 crop really does produce a red
 * gain of 256 in the reference implementation. Clamping the span keeps the
 * method usable on the small crops a user drags out of a video scrubber.
 */
export const MIN_TONAL_SPAN = 24;

/**
 * Ceiling on the blue term of the red row — the coefficient that decides how
 * much blue is subtracted and therefore how magenta the result gets.
 *
 * The published 1.2 "blue magic" factor doubles the blue subtraction that the
 * histogram was actually analysed with, and on a heavily degraded frame the
 * R-row coefficient reaches -1.4, which pulls every blue pixel far below red
 * and turns the image magenta. This is the same over-correction the upstream
 * issue tracker complains about. Capping the magnitude keeps the method's
 * behaviour but bounds the one term that runs away.
 */
export const MAX_BLUE_TERM = 0.85;

/** Build the correction matrix from three histograms and a hue-shift angle. */
export function matrixFromHistograms(
  hr: Uint32Array,
  hg: Uint32Array,
  hb: Uint32Array,
  threshold: number,
  hueShift: number,
): ColorMatrix {
  const range = [hr, hg, hb].map((h) => {
    const g = widestGap(sparseBins(h, threshold));
    return g.high - g.low < MIN_TONAL_SPAN ? { low: 0, high: 255 } : g;
  });
  const gain = range.map((r) => 256 / Math.max(1e-6, r.high - r.low));
  const off = range.map((r, i) => (-r.low / 256) * gain[i]);

  const s = hueShiftRed(1, 1, 1, hueShift);
  const blueTerm = Math.max(-MAX_BLUE_TERM, s[2] * gain[0] * BLUE_MAGIC);
  // Upstream stores a 4×5 colour matrix (row stride 5: R G B A offset); its
  // 3×3 part is diagonal apart from the red row. Row 3 is blue × blue gain —
  // read with a stride of 3 it would come out as green × blue gain.
  const m: Mat3 = [
    s[0] * gain[0],
    s[1] * gain[0],
    blueTerm,
    0,
    gain[1],
    0,
    0,
    0,
    gain[2],
  ];
  return { m, off: off as Vec3, hueShift, range, threshold };
}

export interface MatrixOptions {
  /**
   * Upper bound on the hue-shift search, in degrees.
   *
   * The published search runs to 121°. That is fine on a mildly degraded
   * frame, but on a heavily red-starved one the resulting R row is
   * `s0·gain·R + s1·gain·G − 0.85·B` with s1 near 1.17 — a large amount of
   * green is folded into red while blue passes through untouched, and red +
   * blue is magenta. Lowering the bound keeps the method but keeps it in a
   * range that still looks like a photograph. Default = the published 121°.
   */
  hueLimit?: number;
  /**
   * 'fixed256' reproduces bornfree: analyse a 256x256 box downscale, which
   * pins the sparse threshold at 65536/2000 and makes the result independent
   * of the input resolution (desirable for video, where a per-frame
   * resolution-dependent threshold makes the correction breathe).
   * 'full' reproduces nikolajbech, whose threshold scales with the pixel
   * count, so it must analyse the frame it will correct.
   */
  analysis: 'fixed256' | 'full';
}

/**
 * Compute the colour matrix for an RGBA image.
 *
 * The histogram is always built on an explicit analysis grid — either the
 * whole frame or exactly 256x256 — rather than a stride, because the sparse
 * threshold is derived from the sample count and a stride would silently
 * change it.
 */
export function analyzeColorMatrix(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  opts: MatrixOptions,
): ColorMatrix {
  // 'fixed256' must be EXACTLY 256x256 samples (65536, threshold 32.768) to
  // match the reference. Sampling with a floor-divided stride instead gives
  // 256x288 for a 1024x576 input, which silently changes the threshold to
  // 73.7 and the result with it.
  // bornfree always resizes to exactly 256x256 — including UP, since the
  // clamp has to be 65536 samples for the threshold to stay 32.768 whatever
  // the input was. Clamping to the source size instead (min(w, 256)) makes
  // this identical to 'full' for any image under 256 px, which quietly
  // collapses the two profiles into one.
  const gw = opts.analysis === 'fixed256' ? FIXED_ANALYSIS_EDGE : w;
  const gh = opts.analysis === 'fixed256' ? FIXED_ANALYSIS_EDGE : h;
  const xs = new Int32Array(gw);
  const ys = new Int32Array(gh);
  for (let i = 0; i < gw; i++) xs[i] = Math.min(w - 1, Math.floor((i * w) / gw));
  for (let i = 0; i < gh; i++) ys[i] = Math.min(h - 1, Math.floor((i * h) / gh));

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let n = 0;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = (ys[gy] * w + xs[gx]) * 4;
      if (rgba[i + 3] === 0) continue;
      sumR += rgba[i];
      sumG += rgba[i + 1];
      sumB += rgba[i + 2];
      n++;
    }
  }
  if (!n) {
    return { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], off: [0, 0, 0], hueShift: 0, range: [{ low: 0, high: 255 }, { low: 0, high: 255 }, { low: 0, high: 255 }], threshold: 0 };
  }
  const avg: Vec3 = [sumR / n, sumG / n, sumB / n];
  const hueShift = searchHueShift(avg, opts.hueLimit ?? MAX_HUE_SHIFT);

  const hr = new Uint32Array(256);
  const hg = new Uint32Array(256);
  const hb = new Uint32Array(256);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = (ys[gy] * w + xs[gx]) * 4;
      if (rgba[i + 3] === 0) continue;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      // Asymmetric on purpose: the red histogram is built from the shifted
      // and SUMMED value, green and blue from the untouched channels.
      const s = hueShiftRed(r, g, b, hueShift);
      const nr = Math.max(0, Math.min(255, Math.round(s[0] + s[1] + s[2])));
      hr[nr]++;
      hg[g]++;
      hb[b]++;
    }
  }
  return matrixFromHistograms(hr, hg, hb, n / THRESHOLD_RATIO, hueShift);
}

/** Apply a matrix to one sRGB triplet, clamping like upstream's uint8 store. */
export function applyColorMatrix(m: ColorMatrix, r: number, g: number, b: number): Vec3 {
  const out: Vec3 = [
    m.m[0] * r + m.m[1] * g + m.m[2] * b + m.off[0] * 255,
    m.m[3] * r + m.m[4] * g + m.m[5] * b + m.off[1] * 255,
    m.m[6] * r + m.m[7] * g + m.m[8] * b + m.off[2] * 255,
  ];
  return [Math.min(255, Math.max(0, out[0])), Math.min(255, Math.max(0, out[1])), Math.min(255, Math.max(0, out[2]))];
}

/**
 * The matrix as the FINAL shader applies it (`mixMatrix` in shaders.ts): on
 * sRGB-encoded 0..1 colour, blended by `amount`, clamped. `e` is changed in
 * place at index `q`.
 */
export function applyMixGL(e: Float32Array, q: number, m: Mat3, off: Vec3, amount: number): void {
  const r = e[q], g = e[q + 1], b = e[q + 2];
  const cr = m[0] * r + m[1] * g + m[2] * b + off[0];
  const cg = m[3] * r + m[4] * g + m[5] * b + off[1];
  const cb = m[6] * r + m[7] * g + m[8] * b + off[2];
  e[q] = Math.min(1, Math.max(0, r + (cr - r) * amount));
  e[q + 1] = Math.min(1, Math.max(0, g + (cg - g) * amount));
  e[q + 2] = Math.min(1, Math.max(0, b + (cb - b) * amount));
}
