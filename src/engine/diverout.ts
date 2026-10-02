/**
 * 全自動-Diverout / Diverout+ — a per-frame colour transform after the
 * Diverout app's measured behaviour (docs/diverout-review.md). Nothing of the
 * app's code or models is used: the transform is a classical one whose form
 * and constants were fitted to Diverout's OUTPUTS on the probe kit.
 *
 * Measured: one pointwise transform per image (no local or depth processing),
 * red compensated from green, then every channel stretched on its own between
 * a low and a high percentile — hard-clipped. Fitted on the realistic probes
 * (6-scene, 6-scene-surface, land, chart, depth, grey wedge): red from green
 * α 0.2, black point at the 1.2 % percentile, white point at 96 %. It
 * reproduces the realistic underwater scene to 34 levels mean error (vs 81
 * for no change) and the sunlit scene to 10 (vs 14); flat synthetic frames
 * are not matched, so this is an approximation of the look, not a copy.
 *
 * Diverout+ keeps the idea and adds what Diverout lacks: percentiles that
 * leave the highlights alone (0.5 / 99.5 %), a per-channel gain cap that
 * tightens with sensor noise, a soft toe and shoulder instead of clipping,
 * an amount gated by how much red the water took (a land photo is left
 * alone), and open water kept near its own colour instead of stretched to
 * grey. The preset also turns on 品質把關.
 *
 *   per pixel, sRGB 0..1:
 *     R ← R + k·(1 − R)·G                      (k = α·max(0, mean G − mean R))
 *     c ← (c − lo_c) / (hi_c − lo_c)            per channel
 *     Diverout: clamp · Diverout+: soft toe / shoulder
 *     out = in + amount·(that − in)             amount 0..2 (色彩校正強度 0–200 %)
 */
import type { Vec3 } from './color.ts';

export const DIVEROUT = { alpha: 0.2, pLo: 0.0117, pHi: 0.96 };
export const DIVEROUT_PLUS = { alpha: 0.5, pLo: 0.005, pHi: 0.995, maxGain: 2.5, noiseGain: 1.2, keep: 0.4, keepWidth: 0.07 };

export interface DiveroutState {
  k: number;
  lo: Vec3;
  hi: Vec3;
  /** 1 = Diverout+ (soft toe / shoulder), 0 = Diverout (hard clip). */
  soft: number;
  /** 0..2 (gated in Diverout+). */
  amount: number;
  /** Diverout+: the open water's colour (sRGB) and how much of it to keep. */
  water: Vec3;
  keep: number;
}
export const DIVEROUT_OFF: DiveroutState = { k: 0, lo: [0, 0, 0], hi: [1, 1, 1], soft: 0, amount: 0, water: [0, 0, 0], keep: 0 };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/**
 * Measure one frame (8-bit RGBA). `plus` selects Diverout+; `noise` is the
 * grain σ in 8-bit steps (Diverout+ caps the stretch harder on noisy frames).
 */
export function analyzeDiverout(src: Uint8Array | Uint8ClampedArray, w: number, h: number, plus: boolean, noise = 1) {
  const P = plus ? DIVEROUT_PLUS : DIVEROUT;
  const n = w * h;
  let mr = 0, mg = 0, lr = 0, lg = 0;
  for (let i = 0; i < n; i++) {
    mr += src[i * 4];
    mg += src[i * 4 + 1];
    lr += toLin(src[i * 4] / 255);
    lg += toLin(src[i * 4 + 1] / 255);
  }
  mr /= 255 * n;
  mg /= 255 * n;
  const k = P.alpha * Math.max(0, mg - mr);
  // percentiles of the compensated channels (1024-bin histograms)
  const B = 1024;
  const hist = [new Uint32Array(B), new Uint32Array(B), new Uint32Array(B)];
  for (let i = 0; i < n; i++) {
    const r = src[i * 4] / 255, g = src[i * 4 + 1] / 255, b = src[i * 4 + 2] / 255;
    const rc = clamp(r + k * (1 - r) * g, 0, 1);
    hist[0][Math.min(B - 1, (rc * B) | 0)]++;
    hist[1][Math.min(B - 1, (g * B) | 0)]++;
    hist[2][Math.min(B - 1, (b * B) | 0)]++;
  }
  const pct = (hh: Uint32Array, q: number) => {
    const target = q * n;
    let acc = 0;
    for (let i = 0; i < B; i++) {
      acc += hh[i];
      if (acc >= target) return (i + 0.5) / B;
    }
    return 1;
  };
  const lo = [0, 1, 2].map((c) => pct(hist[c], P.pLo)) as Vec3;
  const hi = [0, 1, 2].map((c) => pct(hist[c], P.pHi)) as Vec3;
  let gate = 1;
  if (plus) {
    // the stretch may multiply a channel by at most this much (less when grainy)
    const cap = DIVEROUT_PLUS.maxGain - DIVEROUT_PLUS.noiseGain * smoothstep(2, 8, noise);
    for (let c = 0; c < 3; c++) {
      if (hi[c] - lo[c] < 1 / cap) {
        const mid = (hi[c] + lo[c]) / 2;
        lo[c] = mid - 0.5 / cap;
        hi[c] = mid + 0.5 / cap;
      }
    }
    // underwater gate: how much red the water took (linear light)
    const starvation = clamp(1 - lr / Math.max(1e-4, lg), 0, 1);
    gate = smoothstep(0.08, 0.35, starvation);
  }
  for (let c = 0; c < 3; c++) if (hi[c] - lo[c] < 1e-3) hi[c] = lo[c] + 1e-3;
  return { k: plus ? k * gate : k, lo, hi, gate };
}

/** Soft toe / shoulder for Diverout+: identity in 0.06..0.82, smooth to 0 and 1. */
export function softRange(y: number): number {
  const T = 0.06, K = 0.82;
  if (y > K) return K + (1 - K) * Math.tanh((y - K) / (1 - K));
  if (y < T) return T * Math.exp((y - T) / T);
  return y;
}

/**
 * Diverout+ water keep: open water has the water's own chromaticity; a
 * per-channel stretch would neutralise it to grey. Pixels that close to it get
 * that much less of the transform, so the water stays blue / green.
 */
export function waterKeep(r: number, g: number, b: number, s: DiveroutState): number {
  if (s.keep <= 0) return 0;
  const sp = r + g + b + 1e-4, sw = s.water[0] + s.water[1] + s.water[2] + 1e-4;
  const d = Math.hypot(r / sp - s.water[0] / sw, g / sp - s.water[1] / sw, b / sp - s.water[2] / sw);
  return s.keep * Math.exp(-((d / DIVEROUT_PLUS.keepWidth) ** 2));
}

/** One sRGB 0..1 colour, in place. Mirrors diverout() in GRADE_FS. */
export function applyDiverout(px: Float32Array, s: DiveroutState): void {
  if (s.amount <= 0.0001) return;
  const r = px[0], g = px[1], b = px[2];
  const amount = s.amount * (1 - waterKeep(r, g, b, s));
  const t = [clamp(r + s.k * (1 - r) * g, 0, 1), g, b];
  for (let c = 0; c < 3; c++) {
    let y = (t[c] - s.lo[c]) / (s.hi[c] - s.lo[c]);
    y = s.soft > 0.5 ? softRange(y) : clamp(y, 0, 1);
    px[c] = clamp(px[c] + (y - px[c]) * amount, 0, 1);
  }
}
