/**
 * Light controls: sun beams (光束) and surface highlights (水面高光).
 *
 * Both are local adjustments steered by on-image control points:
 *  - 光束: one point, the light source the beams converge on (it may sit
 *    outside the frame, e.g. the sun above the surface). The GPU radially
 *    blurs the bright part of the frame toward it; the result is added
 *    (enhance) or taken away (suppress).
 *  - 水面高光: two points, A (surface, full effect) → B (effect ends), a
 *    graduated filter that recovers blown highlights and sets tone/warmth.
 *
 * This module holds the auto-detection (run on the analysis frame) and the
 * JS twins of the shader maths used by the tests.
 */
import { clamp, fromOklab, linearToSrgb, luma, smoothstep, srgbToLinear, toOklab, type Vec3 } from './color.ts';
import { boxMean, quantiles } from './filters.ts';

export interface BeamDetect {
  /** Estimated source, in output uv (may be outside 0..1). */
  x: number;
  y: number;
  /** 0..1: how clearly the frame contains converging/parallel bright streaks. */
  presence: number;
  /** Luminance above which the radial blur collects light. */
  thr: number;
}

export interface SurfaceDetect {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** 0..1: how much brighter the top band is than the scene. */
  presence: number;
  /** Fraction of the band that is (near) clipped. */
  clip: number;
  /** Mean luminance of the top rows. */
  top: number;
}

/**
 * Beam source from streak geometry, measured on the source luminance (the
 * correction amplifies grain in open water far more than the beams).
 *
 * What sets beams apart from reef and sand texture is that they are long and
 * locally aligned. A *local* structure tensor (9×9 windows) gives each pixel
 * an orientation and a coherence; isotropic textures score low, a lone edge
 * (the horizon, a fish) is a tiny fraction of pixels, a field of beams is many
 * coherent pixels. Those pixels' normals n then vote for the point where the
 * streak lines meet: argmin Σ w (n·(S − p))². Parallel streaks (a distant
 * sun) make that singular, so the source goes far along their direction,
 * toward the surface.
 */
export function detectBeams(L: Float32Array, w: number, h: number): BeamDetect {
  const yMax = Math.max(3, Math.floor(h * 0.7));
  const n = w * yMax;
  const Ls = boxMean(L.subarray(0, n), w, yMax, 1);
  const jxx = new Float32Array(n), jxy = new Float32Array(n), jyy = new Float32Array(n);
  for (let y = 1; y < yMax - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (Ls[i + 1] - Ls[i - 1]) * 0.5,
        gy = (Ls[i + w] - Ls[i - w]) * 0.5;
      jxx[i] = gx * gx;
      jxy[i] = gx * gy;
      jyy[i] = gy * gy;
    }
  const Jxx = boxMean(jxx, w, yMax, 4), Jxy = boxMean(jxy, w, yMax, 4), Jyy = boxMean(jyy, w, yMax, 4);
  const Lm = boxMean(Ls, w, yMax, 4); // local mean: beams are *bright* ridges
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) energy[i] = Jxx[i] + Jyy[i];
  let eTop = 1e-9;
  for (let i = 0; i < n; i++) if (energy[i] > eTop) eTop = energy[i];
  const [e90] = quantiles(energy.map((v) => v / eTop), [0.9], 1024); // O(n) histogram quantile
  const eMin = Math.max(1e-6, 0.25 * e90 * eTop);
  const [thr] = quantiles(L.subarray(0, n), [0.8], 512);
  let m00 = 0, m01 = 0, m11 = 0, b0 = 0, b1 = 0, cx = 0, cy = 0, ws = 0, cand = 0;
  for (let y = 4; y < yMax - 4; y++)
    for (let x = 4; x < w - 4; x++) {
      const i = y * w + x;
      const tr = energy[i];
      if (tr < eMin) continue;
      const d = Math.sqrt((Jxx[i] - Jyy[i]) ** 2 + 4 * Jxy[i] * Jxy[i]);
      const coh = d / (tr + 1e-12);
      if (coh < 0.75) continue;
      // dominant eigenvector of the local tensor = the streak's normal
      const l1 = 0.5 * (tr + d);
      let nx = Jxy[i],
        ny = l1 - Jxx[i];
      if (Math.abs(nx) + Math.abs(ny) < 1e-12) {
        nx = l1 - Jyy[i];
        ny = Jxy[i];
      }
      const nn = Math.hypot(nx, ny) || 1;
      nx /= nn;
      ny /= nn;
      // sunlight comes down from the surface: streaks within ±50° of vertical
      // (normal mostly horizontal), and brighter than their surroundings
      if (Math.abs(ny) > 0.77 || Ls[i] < Lm[i] + 0.004) continue;
      const u = (x + 0.5) / w,
        v = (y + 0.5) / h;
      const wt = coh * coh;
      m00 += wt * nx * nx;
      m01 += wt * nx * ny;
      m11 += wt * ny * ny;
      const dd = nx * u + ny * v;
      b0 += wt * nx * dd;
      b1 += wt * ny * dd;
      cx += wt * u;
      cy += wt * v;
      ws += wt;
      cand++;
    }
  const frac = cand / Math.max(1, (yMax - 8) * (w - 8));
  if (ws <= 0) return { x: 0.5, y: -0.6, presence: 0, thr };
  cx /= ws;
  cy /= ws;
  const tr = m00 + m11,
    det = m00 * m11 - m01 * m01;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc,
    l2 = tr / 2 - disc;
  // many coherent pixels, and their orientations agree (parallel or a fan)
  const agree = l1 > 0 ? (l1 - l2) / (l1 + l2) : 0;
  const presence = smoothstep(0.02, 0.07, frac) * smoothstep(0.2, 0.5, agree);
  let sx = 0,
    sy = 0,
    fromLines = false;
  if (l2 / Math.max(l1, 1e-12) >= 0.06) {
    const inv = 1 / det;
    sx = (m11 * b0 - m01 * b1) * inv;
    sy = (m00 * b1 - m01 * b0) * inv;
    // a real convergence point is above the beams; otherwise treat as parallel
    fromLines = Number.isFinite(sx) && Number.isFinite(sy) && sy < cy - 0.15;
  }
  if (!fromLines) {
    let dx = m01,
      dy = l2 - m00;
    if (Math.abs(dx) + Math.abs(dy) < 1e-12) {
      dx = l2 - m11;
      dy = m01;
    }
    const nn = Math.hypot(dx, dy) || 1;
    dx /= nn;
    dy /= nn;
    if (dy > 0) {
      dx = -dx;
      dy = -dy;
    }
    sx = cx + dx * 1.6;
    sy = cy + dy * 1.6;
  }
  return { x: clamp(sx, -1.5, 2.5), y: clamp(sy, -2, 0.5), presence, thr };
}

/**
 * Surface band from the vertical brightness profile: the surface reads as a
 * bright top band fading downward. B is where the profile falls most of the
 * way back to the scene's median.
 */
export function detectSurface(L: Float32Array, e: Float32Array, w: number, h: number): SurfaceDetect {
  const P = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) s += L[y * w + x];
    P[y] = s / w;
  }
  const topRows = Math.max(1, Math.round(h * 0.08));
  let top = 0;
  for (let y = 0; y < topRows; y++) top += P[y];
  top /= topRows;
  const sorted = Array.from(P).sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const presence = smoothstep(0.04, 0.18, top - med);
  const cut = med + 0.35 * (top - med);
  let yEnd = h;
  for (let y = topRows; y < h; y++)
    if (P[y] < cut) {
      yEnd = y;
      break;
    }
  const by = clamp(yEnd / h + 0.05, 0.12, 0.6);
  let clipN = 0,
    n = 0;
  const yb = Math.round(by * h);
  for (let y = 0; y < yb; y++)
    for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 3;
      if (Math.max(e[q], e[q + 1], e[q + 2]) > 0.97) clipN++;
      n++;
    }
  return { ax: 0.5, ay: 0, bx: 0.5, by, presence, clip: n ? clipN / n : 0, top };
}

/**
 * Luminance grain σ in 8-bit steps (Immerkær 1996: σ = √(π/2)/6 · mean|I ∗ N|,
 * N the 3×3 Laplacian difference kernel), averaged over the flattest 60 % of
 * 8×8 blocks so edges and texture do not read as noise. Blocks, not pixels:
 * ranking single pixels by gradient would pick the ones whose grain happens
 * to be small and under-read σ.
 */
export function estimateNoise(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): number {
  if (w < 16 || h < 16) return 0;
  const Y = new Float32Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) Y[i] = luma(rgba[j], rgba[j + 1], rgba[j + 2]);
  const B = 8,
    bw = Math.floor((w - 2) / B),
    bh = Math.floor((h - 2) / B);
  const resp = new Float32Array(bw * bh),
    grad = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      let r = 0,
        gx = 0,
        gy = 0;
      for (let y = 1 + by * B; y < 1 + (by + 1) * B; y++)
        for (let x = 1 + bx * B; x < 1 + (bx + 1) * B; x++) {
          const i = y * w + x;
          r += Math.abs(
            Y[i - w - 1] - 2 * Y[i - w] + Y[i - w + 1] - 2 * Y[i - 1] + 4 * Y[i] - 2 * Y[i + 1] + Y[i + w - 1] - 2 * Y[i + w] + Y[i + w + 1],
          );
          gx += Y[i + 1] - Y[i - 1];
          gy += Y[i + w] - Y[i - w];
        }
      const k = by * bw + bx;
      resp[k] = r / (B * B);
      // mean gradient over the block: structure survives, grain averages out
      grad[k] = Math.min(1, Math.hypot(gx, gy) / (B * B * 255));
    }
  // blocks with little structure; resp itself also separates texture from grain
  const [gMax] = quantiles(grad, [0.6], 1024);
  const sel: number[] = [];
  for (let k = 0; k < resp.length; k++) if (grad[k] <= gMax) sel.push(resp[k]);
  if (!sel.length) return 0;
  // of those, the quieter 70 %: texture that is flat on average (sand) is loud
  sel.sort((a, b) => a - b);
  const m = Math.max(1, Math.floor(sel.length * 0.7));
  let s = 0;
  for (let k = 0; k < m; k++) s += sel[k];
  // the quieter-70 % selection reads low on pure grain by a fixed factor
  return (Math.sqrt(Math.PI / 2) / 6) * (s / m) * NOISE_CAL;
}
/** Pure Gaussian grain: the quieter 70 % of blocks read 0.913 of the full mean. */
const NOISE_CAL = 1 / 0.913;

/** Graduated mask of the surface filter: 1 at A, easing to 0 at B. Mirrors GLSL. */
export function surfaceMask(u: number, v: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax,
    dy = by - ay;
  const m = clamp(((u - ax) * dx + (v - ay) * dy) / Math.max(dx * dx + dy * dy, 1e-6), 0, 1);
  return 1 - smoothstep(0, 1, m);
}

/**
 * Surface adjustment on one sRGB-encoded colour, weight `wgt` from the mask.
 * Highlights above a knee are compressed (recovery), then tone and warmth.
 * Mirrors the shader.
 */
export function applySurface(rgb: Vec3, wgt: number, hl: number, tone: number, warm: number): Vec3 {
  if (wgt <= 0) return rgb;
  const L = luma(rgb[0], rgb[1], rgb[2]);
  const k = 0.55,
    a = hl * wgt;
  let Lh = L > k ? k + (L - k) * (1 - 0.75 * a) : L;
  Lh *= Math.pow(2, tone * 0.8 * wgt);
  const s = (Lh + 1e-3) / (L + 1e-3);
  const wr = 1 + 0.12 * warm * wgt,
    wb = 1 - 0.12 * warm * wgt;
  return [clamp(rgb[0] * s * wr, 0, 1), clamp(rgb[1] * s, 0, 1), clamp(rgb[2] * s * wb, 0, 1)];
}

/** Weight of the magenta–pink hues (OKLCh ≈ 290°–350°) that sunlight must not take. */
export function magentaWeight(hueDeg: number): number {
  const dh = Math.abs((((hueDeg - 320) % 360) + 540) % 360 - 180);
  return 1 - smoothstep(30, 55, dh);
}

/**
 * 光線去洋紅: sunlight in the frame (beams, the surface) is the illuminant
 * itself and should render white to warm. Red compensation adds red where
 * green is bright, so after white balance the light can lean pink; this
 * takes the magenta out of bright, pale pixels only (above `thr`, output
 * luma; OKLab chroma below ~0.07). Mirrors the shader; `rgb` is sRGB-encoded.
 */
export function neutralLight(rgb: Vec3, thr: number, amount: number): Vec3 {
  if (amount <= 0) return rgb;
  const L = luma(rgb[0], rgb[1], rgb[2]);
  const wL = smoothstep(thr - 0.12, thr, L);
  if (wL <= 0) return rgb;
  const lab = toOklab(srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2]));
  const h = ((Math.atan2(lab[2], lab[1]) * 180) / Math.PI + 360) % 360;
  // pale light only: saturated pink subjects (coral, fish) are left alone
  const k = 1 - amount * wL * magentaWeight(h) * (1 - smoothstep(0.05, 0.09, Math.hypot(lab[1], lab[2])));
  if (k >= 1) return rgb;
  const c = fromOklab(lab[0], lab[1] * k, lab[2] * k);
  return [clamp(linearToSrgb(c[0]), 0, 1), clamp(linearToSrgb(c[1]), 0, 1), clamp(linearToSrgb(c[2]), 0, 1)];
}
