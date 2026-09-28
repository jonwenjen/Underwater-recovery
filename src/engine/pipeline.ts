/**
 * 自動化流程 — the adaptive "underwater master pipeline" modules:
 *
 *  - 多分支融合 (WaterNet / Ancuti idea): white-balanced, gamma and
 *    histogram-equalised branches of the luminance, blended per pixel by
 *    confidence maps (local contrast × well-exposedness, smoothed so the
 *    blend never makes halos).
 *  - Lab 分軸校正 (UIEC²-Net idea): the residual water cast is removed along
 *    the a (green↔red) and b (blue↔yellow) axes of OKLab, only toward red /
 *    yellow (water adds green and blue, never takes them away), on pale
 *    surfaces; saturated colours (coral, fish) and the water are protected.
 *  - Sea-thru 深度感知 (Akkaynak & Treibitz, CVPR 2019): backscatter fitted
 *    from the darkest pixels at each pseudo-depth, attenuation from how the
 *    remaining signal falls with depth, per channel; depth from the dehaze
 *    transmission map (the browser has no depth camera).
 *  - 補光區域白平衡: a strobe / torch lights near subjects with white light
 *    while the background stays in water light, so one global white balance
 *    is wrong for both; a coarse grid of local gains fixes the difference.
 *  - 品質把關: no-reference quality (UIQM, UCIQE) and over-processing checks
 *    (clipping, noise amplification, local-contrast overshoot) that back the
 *    enhancement strength off until the result is within bounds.
 *
 * Everything here runs on the analysis frame; the GPU applies the same
 * formulas at full resolution (GRADE_FS) and the CPU mirror at analysis
 * resolution, so tests and scripts/optimize.ts see exactly what the user sees.
 */
import { clamp, fromOklab, linearToSrgb, luma, smoothstep, srgbToLinear, toOklab, type Vec3 } from './color.ts';
import { boxMean, quantiles } from './filters.ts';

/* ------------------------------------------------------------ fusion */

/** Gamma of the brightening branch (WaterNet's gamma-corrected input). */
export const FUSE_GAMMA = 0.7;

/**
 * Per-pixel weights of the three branches — v1 = L (white-balanced), v2 =
 * L^γ (gamma), v3 = the CLAHE-mapped L (histogram equalisation) — as in
 * exposure fusion: local contrast × well-exposedness, then smoothed (the
 * coarse levels of a fusion pyramid) and normalised. Writes w2, w3 into
 * `out` (w1 = 1 − w2 − w3).
 */
export function fusionWeights(L: Float32Array, he: Float32Array, w: number, h: number, out2: Float32Array, out3: Float32Array): void {
  const n = w * h;
  const v2 = new Float32Array(n);
  for (let i = 0; i < n; i++) v2[i] = Math.pow(Math.max(0, L[i]), FUSE_GAMMA);
  const m1 = boxMean(L, w, h, 2), m2 = boxMean(v2, w, h, 2), m3 = boxMean(he, w, h, 2);
  const W1 = new Float32Array(n), W2 = new Float32Array(n), W3 = new Float32Array(n);
  const ex = (v: number) => Math.exp(-((v - 0.5) ** 2) / (2 * 0.2 * 0.2));
  for (let i = 0; i < n; i++) {
    W1[i] = (Math.abs(L[i] - m1[i]) + 0.004) * ex(L[i]);
    W2[i] = (Math.abs(v2[i] - m2[i]) + 0.004) * ex(v2[i]);
    W3[i] = (Math.abs(he[i] - m3[i]) + 0.004) * ex(he[i]);
  }
  const r = Math.max(2, Math.round(Math.max(w, h) / 48));
  const s1 = boxMean(W1, w, h, r), s2 = boxMean(W2, w, h, r), s3 = boxMean(W3, w, h, r);
  for (let i = 0; i < n; i++) {
    const t = s1[i] + s2[i] + s3[i] + 1e-9;
    out2[i] = s2[i] / t;
    out3[i] = s3[i] / t;
  }
}

/** The fused luminance — mirrors the GRADE pass. */
export function fuseL(L: number, he: number, w2: number, w3: number, amount: number): number {
  const f = (1 - w2 - w3) * L + w2 * Math.pow(Math.max(0, L), FUSE_GAMMA) + w3 * he;
  return L + (f - L) * amount;
}

/* ------------------------------------------------------- Lab cast */

/** Weight of a pixel for the Lab shift: pale, mid-tone, not open water. */
export function labWeight(L: number, C: number, t: number): number {
  const pale = 1 - smoothstep(0.06, 0.14, C);
  const mid = smoothstep(0.03, 0.15, L) * (1 - smoothstep(0.85, 1, L));
  const surface = 0.3 + 0.7 * smoothstep(0.3, 0.75, t);
  return pale * mid * surface;
}

/**
 * The residual water cast of the surfaces, as the OKLab (a, b) shift that
 * removes it — toward red / yellow only. `e` is sRGB-encoded, `t` the
 * transmission map.
 */
export function measureLabCast(e: Float32Array, t: Float32Array, n: number): [number, number] {
  let sa = 0, sb = 0, sw = 0;
  for (let i = 0, q = 0; i < n; i += 2, q += 6) {
    const lab = toOklab(srgbToLinear(clamp(e[q], 0, 1)), srgbToLinear(clamp(e[q + 1], 0, 1)), srgbToLinear(clamp(e[q + 2], 0, 1)));
    const C = Math.hypot(lab[1], lab[2]);
    const wt = labWeight(lab[0], C, t[i]) * smoothstep(0.3, 0.75, t[i]);
    sa += lab[1] * wt;
    sb += lab[2] * wt;
    sw += wt;
  }
  if (sw < 1e-6) return [0, 0];
  return [Math.max(0, -sa / sw), Math.max(0, -sb / sw)];
}

/** Apply the shift to one sRGB-encoded colour in place. Mirrors GRADE_FS. */
export function applyLabShift(px: Float32Array | number[], q: number, shift: [number, number], amount: number, t: number): void {
  const r = clamp(px[q], 0, 1), g = clamp(px[q + 1], 0, 1), b = clamp(px[q + 2], 0, 1);
  const lab = toOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
  const C = Math.hypot(lab[1], lab[2]);
  const k = amount * labWeight(lab[0], C, t);
  if (k <= 0) return;
  const c = fromOklab(lab[0], lab[1] + shift[0] * k, lab[2] + shift[1] * k);
  px[q] = clamp(linearToSrgb(clamp(c[0], 0, 1)), 0, 1);
  px[q + 1] = clamp(linearToSrgb(clamp(c[1], 0, 1)), 0, 1);
  px[q + 2] = clamp(linearToSrgb(clamp(c[2], 0, 1)), 0, 1);
}

/* --------------------------------------------------------- Sea-thru */

export interface SeaThru {
  /** Backscatter at infinity, per channel (linear). */
  B: Vec3;
  /** Backscatter coefficient, per unit pseudo-depth. */
  b: Vec3;
  /** Attenuation coefficient of the direct signal, per unit pseudo-depth. */
  beta: Vec3;
}

/** Pseudo-depth from transmission: the optical depth of the veil. */
export const depthOf = (t: number) => -Math.log(clamp(t, 0.02, 1));
/** Largest attenuation compensation; beyond it red is noise, not signal. */
export const SEATHRU_MAX_GAIN = 4;

/**
 * Fit the Sea-thru model I = J·e^(−β z) + B·(1 − e^(−b z)) per channel.
 * Backscatter: in each of 10 depth bins the darkest 1 % of pixels hold (almost)
 * only backscatter; B and b are fitted to them (grid over b, closed-form B).
 * Attenuation: after removing backscatter, the log of the mean signal falls
 * linearly with depth (scene reflectance does not depend on distance on
 * average); its slope is β. `lin` is linear RGB, `t` the transmission.
 */
export function fitSeaThru(lin: Float32Array, t: Float32Array, n: number): SeaThru {
  const z = new Float32Array(n);
  let zMax = 1e-3;
  for (let i = 0; i < n; i++) {
    z[i] = depthOf(t[i]);
    if (z[i] > zMax) zMax = z[i];
  }
  const NB = 10;
  const bins: number[][] = Array.from({ length: NB }, () => []);
  for (let i = 0; i < n; i++) bins[Math.min(NB - 1, Math.floor((z[i] / zMax) * NB))].push(i);
  // darkest 1 % (at least 3 pixels) per bin
  const pts: { z: number; c: Vec3 }[] = [];
  const binMean: { z: number; c: Vec3; n: number }[] = [];
  for (const b of bins) {
    if (b.length < 20) continue;
    b.sort((i, j) => luma(lin[i * 3], lin[i * 3 + 1], lin[i * 3 + 2]) - luma(lin[j * 3], lin[j * 3 + 1], lin[j * 3 + 2]));
    const k = Math.max(3, Math.floor(b.length * 0.01));
    for (let m = 0; m < k; m++) {
      const i = b[m];
      pts.push({ z: z[i], c: [lin[i * 3], lin[i * 3 + 1], lin[i * 3 + 2]] });
    }
    let zs = 0;
    const c: Vec3 = [0, 0, 0];
    for (const i of b) {
      zs += z[i];
      c[0] += lin[i * 3]; c[1] += lin[i * 3 + 1]; c[2] += lin[i * 3 + 2];
    }
    binMean.push({ z: zs / b.length, c: [c[0] / b.length, c[1] / b.length, c[2] / b.length], n: b.length });
  }
  const B: Vec3 = [0, 0, 0], bb: Vec3 = [1, 1, 1], beta: Vec3 = [0, 0, 0];
  if (pts.length < 6 || binMean.length < 3) return { B, b: bb, beta };
  for (let c = 0; c < 3; c++) {
    let best = Infinity;
    for (let g = 0; g < 28; g++) {
      const bk = 0.05 * Math.pow(1.25, g); // 0.05 … ~20
      let num = 0, den = 0;
      for (const p of pts) {
        const f = 1 - Math.exp(-bk * p.z);
        num += p.c[c] * f;
        den += f * f;
      }
      const Bk = den > 1e-12 ? clamp(num / den, 0, 1) : 0;
      let sse = 0;
      for (const p of pts) sse += (p.c[c] - Bk * (1 - Math.exp(-bk * p.z))) ** 2;
      if (sse < best) {
        best = sse;
        B[c] = Bk;
        bb[c] = bk;
      }
    }
    // attenuation: weighted regression of ln(mean direct signal) on depth
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const m of binMean) {
      const d = m.c[c] - B[c] * (1 - Math.exp(-bb[c] * m.z));
      if (d <= 1e-4) continue;
      const y = Math.log(d);
      sw += m.n; sx += m.n * m.z; sy += m.n * y; sxx += m.n * m.z * m.z; sxy += m.n * m.z * y;
    }
    const den = sw * sxx - sx * sx;
    beta[c] = den > 1e-9 ? clamp(-(sw * sxy - sx * sy) / den, 0, 3) : 0;
  }
  // only the attenuation DIFFERENCE between channels is colour: anchor on the
  // least-attenuated one (overall brightness belongs to exposure)
  const bMin = Math.min(beta[0], beta[1], beta[2]);
  return { B, b: bb, beta: [beta[0] - bMin, beta[1] - bMin, beta[2] - bMin] };
}

/** Sea-thru restoration of one linear channel value at transmission t. Mirrors GRADE_FS. */
export function seaThruChannel(I: number, t: number, B: number, b: number, beta: number): number {
  const z = depthOf(t);
  const D = Math.max(0, I - B * (1 - Math.exp(-b * z)));
  return D * Math.min(SEATHRU_MAX_GAIN, Math.exp(beta * z));
}

/* ------------------------------------------------ local white balance */

/** Grid of the local white balance (G × G tiles). */
export const LWB_GRID = 4;

/**
 * Artificial light: a strobe or torch lights near subjects white while the
 * background stays in water light, so the frame's illuminant varies across
 * it. Returns per-tile gains (relative to the frame, luminance-preserving,
 * bounded) and how strongly the illuminant varies (0..1).
 */
export function localWhiteBalance(bal: Float32Array, w: number, h: number): { gains: Float32Array; spread: number } {
  const G = LWB_GRID;
  const acc = new Float64Array(G * G * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 3;
      const r = bal[q], g = bal[q + 1], b = bal[q + 2];
      const Y = luma(r, g, b);
      const mx = Math.max(r, g, b);
      // the light is read from near-neutral surfaces (sand, rock, a slate):
      // a coloured subject says nothing about the light falling on it
      if (Y < 0.004 || mx > 0.97 || (mx - Math.min(r, g, b)) / mx > 0.5) continue;
      const k = (Math.min(G - 1, Math.floor((y / h) * G)) * G + Math.min(G - 1, Math.floor((x / w) * G))) * 4;
      acc[k] += r; acc[k + 1] += g; acc[k + 2] += b; acc[k + 3]++;
    }
  let tr = 0, tg = 0, tb = 0, tc = 0;
  for (let k = 0; k < G * G; k++) {
    tr += acc[k * 4]; tg += acc[k * 4 + 1]; tb += acc[k * 4 + 2]; tc += acc[k * 4 + 3];
  }
  const gy = luma(tr, tg, tb) || 1;
  const glob: Vec3 = [tr / gy, tg / gy, tb / gy];
  const gains = new Float32Array(G * G * 3).fill(1);
  const reds: number[] = [];
  for (let k = 0; k < G * G; k++) {
    if (acc[k * 4 + 3] < 8) continue;
    const r = acc[k * 4], g = acc[k * 4 + 1], b = acc[k * 4 + 2];
    const y = luma(r, g, b) || 1;
    const il: Vec3 = [r / y, g / y, b / y];
    reds.push(r / (r + g + b + 1e-9));
    // move this tile's illuminant to the frame's
    const raw: Vec3 = [glob[0] / Math.max(1e-4, il[0]), glob[1] / Math.max(1e-4, il[1]), glob[2] / Math.max(1e-4, il[2])];
    const ry = luma(raw[0], raw[1], raw[2]) || 1;
    for (let c = 0; c < 3; c++) gains[k * 3 + c] = clamp(raw[c] / ry, 0.8, 1.25);
  }
  let spread = 0;
  if (reds.length > 2) {
    const m = reds.reduce((a, v) => a + v, 0) / reds.length;
    spread = Math.sqrt(reds.reduce((a, v) => a + (v - m) ** 2, 0) / reds.length);
  }
  return { gains, spread };
}

/** Bilinear sample of the tile gains at (u, v) — as the GPU samples the aux map. */
export function sampleGrid(gains: Float32Array, u: number, v: number, out: Vec3): Vec3 {
  const G = LWB_GRID;
  const fx = clamp(u * G - 0.5, 0, G - 1), fy = clamp(v * G - 0.5, 0, G - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(G - 1, x0 + 1), y1 = Math.min(G - 1, y0 + 1);
  const ax = fx - x0, ay = fy - y0;
  for (let c = 0; c < 3; c++) {
    const a = gains[(y0 * G + x0) * 3 + c] * (1 - ax) + gains[(y0 * G + x1) * 3 + c] * ax;
    const b = gains[(y1 * G + x0) * 3 + c] * (1 - ax) + gains[(y1 * G + x1) * 3 + c] * ax;
    out[c] = a * (1 - ay) + b * ay;
  }
  return out;
}

/* --------------------------------------------------------- quality */

export interface Quality {
  /** Underwater Colour Image Quality Evaluation (Yang & Sowmya 2015). */
  uciqe: number;
  /** Underwater Image Quality Measure (Panetta et al. 2016). */
  uiqm: number;
  /** Fraction of pixels newly clipped in the highlights (any channel at 1). */
  clip: number;
  /** Grain in flat areas, output / source (brightness-normalised). */
  noiseAmp: number;
  /** Local contrast, output / source. */
  lcRatio: number;
}

const alphaTrimmed = (v: number[], a = 0.1) => {
  const s = v.slice().sort((x, y) => x - y);
  const lo = Math.floor(s.length * a), hi = Math.ceil(s.length * (1 - a));
  let m = 0;
  for (let i = lo; i < hi; i++) m += s[i];
  const mu = m / Math.max(1, hi - lo);
  let va = 0;
  for (let i = lo; i < hi; i++) va += (s[i] - mu) ** 2;
  return { mu, s2: va / Math.max(1, hi - lo) };
};

/**
 * UCIQE and UIQM of an output (linear-free sRGB 0..1, `out` stride 3) plus
 * the over-processing measures against its source (`src` RGBA 8-bit).
 */
export function quality(out: Float32Array, src: Uint8Array | Uint8ClampedArray, w: number, h: number): Quality {
  const n = w * h;
  // --- UCIQE: 0.4680·σ_chroma + 0.2745·con_L + 0.2576·μ_saturation (CIELab-like, here OKLab)
  const Ls = new Float32Array(n);
  let sc = 0, sc2 = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    const lab = toOklab(srgbToLinear(out[i * 3]), srgbToLinear(out[i * 3 + 1]), srgbToLinear(out[i * 3 + 2]));
    const C = Math.hypot(lab[1], lab[2]);
    Ls[i] = clamp(lab[0], 0, 1);
    sc += C;
    sc2 += C * C;
    ss += lab[0] > 1e-3 ? C / Math.hypot(C, lab[0]) : 0;
  }
  const muC = sc / n;
  const sigC = Math.sqrt(Math.max(0, sc2 / n - muC * muC));
  const [l1, l99] = quantiles(Ls, [0.01, 0.99], 1024);
  const uciqe = 0.468 * sigC + 0.2745 * (l99 - l1) + 0.2576 * (ss / n);
  // --- UIQM = 0.0282·UICM + 0.2953·UISM + 3.5753·UIConM
  const rg: number[] = [], yb: number[] = [];
  for (let i = 0; i < n; i += 2) {
    const r = out[i * 3] * 255, g = out[i * 3 + 1] * 255, b = out[i * 3 + 2] * 255;
    rg.push(r - g);
    yb.push((r + g) / 2 - b);
  }
  const A = alphaTrimmed(rg), B = alphaTrimmed(yb);
  const uicm = -0.0268 * Math.hypot(A.mu, B.mu) + 0.1586 * Math.sqrt(A.s2 + B.s2);
  const bs = 8;
  const eme = (f: (x: number, y: number) => number) => {
    let s = 0, k = 0;
    for (let by = 0; by + bs <= h; by += bs)
      for (let bx = 0; bx + bs <= w; bx += bs) {
        let mx = 0, mn = Infinity;
        for (let y = by; y < by + bs; y++)
          for (let x = bx; x < bx + bs; x++) {
            const v = f(x, y);
            if (v > mx) mx = v;
            if (v < mn) mn = v;
          }
        if (mn > 1e-3 && mx > mn) s += 2 * Math.log(mx / mn);
        k++;
      }
    return k ? s / k : 0;
  };
  const sob = (c: number) => (x: number, y: number) => {
    const X = clamp(x, 1, w - 2), Y = clamp(y, 1, h - 2);
    const p = (dx: number, dy: number) => out[((Y + dy) * w + X + dx) * 3 + c] * 255;
    const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
    const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
    return (Math.hypot(gx, gy) / 1020) * p(0, 0) + 1e-3;
  };
  const uism = 0.299 * eme(sob(0)) + 0.587 * eme(sob(1)) + 0.114 * eme(sob(2));
  let conm = 0, kb = 0;
  for (let by = 0; by + bs <= h; by += bs)
    for (let bx = 0; bx + bs <= w; bx += bs) {
      let mx = 0, mn = Infinity;
      for (let y = by; y < by + bs; y++)
        for (let x = bx; x < bx + bs; x++) {
          const v = Ls[y * w + x];
          if (v > mx) mx = v;
          if (v < mn) mn = v;
        }
      const s = mx + mn, d = mx - mn;
      if (s > 1e-4 && d > 1e-4) conm += (d / s) * Math.log(d / s);
      kb++;
    }
  const uiconm = kb ? -conm / kb : 0;
  const uiqm = 0.0282 * uicm + 0.2953 * uism + 3.5753 * uiconm;

  // --- over-processing against the source
  const Yo = new Float32Array(n), Yi = new Float32Array(n);
  let clip = 0, mo = 0, mi = 0;
  for (let i = 0; i < n; i++) {
    const r = out[i * 3], g = out[i * 3 + 1], b = out[i * 3 + 2];
    Yo[i] = luma(r, g, b);
    Yi[i] = luma(src[i * 4], src[i * 4 + 1], src[i * 4 + 2]) / 255;
    mo += Yo[i];
    mi += Yi[i];
    // highlights only: a channel at 0 in deep water is physics, not processing
    if (Math.max(src[i * 4], src[i * 4 + 1], src[i * 4 + 2]) < 254 && Math.max(r, g, b) >= 0.995) clip++;
  }
  const norm = mi > 1e-6 ? mo / mi : 1;
  const bo1 = boxMean(Yo, w, h, 1), bi1 = boxMean(Yi, w, h, 1);
  const bo4 = boxMean(bo1, w, h, 4), bi4 = boxMean(bi1, w, h, 4);
  // flat areas of the SOURCE: lowest quarter of local gradient
  const gi = new Float32Array(n);
  for (let i = 0; i < n; i++) gi[i] = Math.min(1, Math.abs(bi1[i] - bi4[i]) * 8);
  const [g25] = quantiles(gi, [0.25], 512);
  let no = 0, ni = 0, lo = 0, li = 0;
  for (let i = 0; i < n; i++) {
    lo += Math.abs(bo1[i] - bo4[i]);
    li += Math.abs(bi1[i] - bi4[i]);
    if (gi[i] <= g25) {
      no += Math.abs(Yo[i] - bo1[i]);
      ni += Math.abs(Yi[i] - bi1[i]);
    }
  }
  return {
    uciqe,
    uiqm,
    clip: clip / n,
    noiseAmp: ni > 1e-6 ? no / (ni * Math.max(0.25, norm)) : 1,
    lcRatio: li > 1e-6 ? lo / (li * Math.max(0.25, norm)) : 1,
  };
}
