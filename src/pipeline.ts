/**
 * Underwater image recovery pipeline.
 *
 * Pure functions over RGBA ImageData. No dependencies, no network, no server:
 * every pixel stays in the browser tab.
 *
 * Stage order follows the classical literature (Jaffe-McGlamery absorption
 * model + He dark channel prior + Zuiderveld CLAHE):
 *   1. white balance      (gray-world on LAB chroma)
 *   2. red restoration    (Jaffe-McGlamery spectral expansion)
 *   3. dehazing           (dark channel prior; transmission smoothed by a
 *                         windowed minimum, NOT He's guided filter — see README)
 *   4. contrast           (CLAHE on L only)
 *   5. detail             (CLAHE + a plain box unsharp mask; the unsharp is
 *                         not edge-aware and not noise-aware — see README)
 *   6. tone               (levels + gamma)
 */

export type StageName =
  | 'whiteBalance'
  | 'redRestore'
  | 'dehaze'
  | 'clahe'
  | 'sharpen'
  | 'tone';

export interface Params {
  // 1. white balance
  wbStrength: number; // 0..1  how far to pull a/b means to neutral
  warm: number; // -50..50 manual b (yellow/blue) bias
  greenBias: number; // -50..50 manual a (green/red) bias
  // 2. red restoration
  redStrength: number; // 0..1
  // 3. dehazing
  dehazeStrength: number; // 0..1 (omega)
  // 4. contrast
  claheClip: number; // 1..8
  claheTiles: number; // 4..16
  // 5. detail
  sharpenAmount: number; // 0..2
  // 6. tone
  gamma: number; // 0.5..2.0  (1 = neutral)
  blackPoint: number; // 0..0.2
  whitePoint: number; // 0.8..1
  // global
  saturation: number; // 0..1.5
  auto: boolean;
}

export const DEFAULT_PARAMS: Params = {
  wbStrength: 1,
  warm: 0,
  greenBias: 0,
  redStrength: 0.6,
  dehazeStrength: 0.75,
  claheClip: 2,
  claheTiles: 8,
  sharpenAmount: 0.6,
  gamma: 1.1,
  blackPoint: 0.02,
  whitePoint: 0.98,
  saturation: 1.15,
  auto: true,
};

export interface Analysis {
  meanA: number;
  meanB: number;
  castA: number; // meanA minus the neutral-grey reference
  castB: number;
  redDeficit: number; // (meanG - meanR) / meanG, pre-white-balance
  blueDominance: number; // b - (r+g)/2, in 0..255 units
  contrast: number; // luma stddev / 255
  isUnderwater: number; // 0..1 confidence
  suggestedRed: number;
  suggestedDehaze: number;
  suggestedGamma: number;
  meanLuma: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/* ---------------------------------------------------------------- helpers */

/**
 * sRGB <-> linear, needed so light math happens in a perceptually sane space.
 *
 * Both directions are table-driven. `toLinear` has only 256 possible inputs
 * (it is fed bytes), and `toSrgb` is smooth and monotonic, so a table plus
 * linear interpolation is indistinguishable from `Math.pow` while removing six
 * `pow` calls per pixel — measured 2.0-2.2x faster end to end.
 */
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
/** Exactly the previous value: `src.data` is always an integer 0..255. */
const toLinear = (c8: number): number => LIN[c8];

// 4096 entries is ~16x finer than the 8-bit output grid, so interpolation error
// stays well under half a quantisation step. ENC holds *float* sRGB: rounding
// here (as the old toSrgb did) is what made smooth water gradients band.
const ENC_N = 4096;
const ENC = new Float32Array(ENC_N + 1);
for (let i = 0; i <= ENC_N; i++) {
  const l = i / ENC_N;
  ENC[i] = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}
/**
 * linear -> sRGB, returning 0..1 as a float (no rounding, no /255).
 *
 * The `x >= ENC_N` branch is load-bearing, not defensive: interpolating at
 * exactly 1.0 would read ENC[ENC_N + 1], one past the end, and the resulting
 * NaN lands in a Uint8ClampedArray as 0 — i.e. every fully clipped channel
 * would come out black.
 */
function toSrgbF(l: number): number {
  const x = clamp(l, 0, 1) * ENC_N;
  if (x >= ENC_N) return ENC[ENC_N];
  const i = x | 0;
  const a = ENC[i];
  return a + (ENC[i + 1] - a) * (x - i);
}

/**
 * Hash a pixel index to a uniform value in [-1, 1).
 *
 * The `/2^32` then `*2 - 1` is load-bearing: dividing by 2^31 alone yields
 * [0, 2), which is a *positive* bias rather than noise. It brightens every
 * pixel it touches and reads as visible film grain instead of dither.
 *
 * The final 8-bit write is the only quantisation left in the pipeline, and the
 * tone curve + unsharp stretch the steps that land near it, which is exactly
 * where underwater's smooth blue gradients turn into contour bands. Half an
 * LSB of zero-mean noise costs two hashes per pixel and removes them.
 */
function ditherNoise(x: number): number {
  let h = Math.imul(x ^ 0x9e3779b9, 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h / 4294967296) * 2 - 1;
}

/* ------------------------------------------------------------- 1. analyse */

export function analyse(src: ImageData): Analysis {
  const d = src.data;
  let sr = 0,
    sg = 0,
    sb = 0,
    sl = 0,
    sl2 = 0,
    cnt = 0;
  // Lab chroma needs mean r/g/b; accumulate first, convert once (cheap and
  // close enough for a mean-based decision).
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    sr += r;
    sg += g;
    sb += b;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sl += l;
    sl2 += l * l;
    cnt++;
  }
  if (cnt === 0) {
    return {
      meanA: 0,
      meanB: 0,
      castA: 0,
      castB: 0,
      redDeficit: 0,
      blueDominance: 0,
      contrast: 0,
      isUnderwater: 0,
      suggestedRed: 0,
      suggestedDehaze: 0,
      suggestedGamma: 1,
      meanLuma: 0,
    };
  }
  const mr = sr / cnt,
    mg = sg / cnt,
    mb = sb / cnt;
  const meanLuma = sl / cnt;
  const contrast = Math.sqrt(Math.max(0, sl2 / cnt - meanLuma * meanLuma)) / 255;

  // mean Lab chroma via sRGB->XYZ->Lab (D65)
  const lr = toLinear(Math.round(mr)),
    lg = toLinear(Math.round(mg)),
    lb = toLinear(Math.round(mb));
  const X = 0.4124 * lr + 0.3576 * lg + 0.1805 * lb;
  const Y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  const Z = 0.0193 * lr + 0.1192 * lg + 0.9505 * lb;
  const f = (t: number) =>
    t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f(X),
    fy = f(Y),
    fz = f(Z);
  const meanA = 500 * (fx - fy);
  const meanB = 200 * (fy - fz);

  // An sRGB grey (r=g=b) is not Lab-neutral under D65, so a gray-world shift
  // would tint even a perfectly neutral photo. Measure that reference chroma
  // and subtract it, so only a real cast survives.
  const ln = toLinear(Math.round(mr));
  const Xn = (0.4124 + 0.3576 + 0.1805) * ln;
  const Yn = (0.2126 + 0.7152 + 0.0722) * ln;
  const Zn = (0.0193 + 0.1192 + 0.9505) * ln;
  const baseA = 500 * (f(Xn) - f(Yn));
  const baseB = 200 * (f(Yn) - f(Zn));
  const castA = meanA - baseA;
  const castB = meanB - baseB;

  const blueDominance = mb - (mr + mg) / 2; // >0 = blue cast

  // Confidence heuristic, tuned for consumer dive/goggle footage:
  // blue-green cast, weak red, flat contrast.
  const castScore = clamp((blueDominance / 45) * 0.6 + (castB / 30) * 0.2, 0, 1);
  const redLoss = clamp((mg - mr) / 60, 0, 1);
  const redDeficit = clamp((mg - mr) / (mg + 1e-6), 0, 1);
  const flat = clamp((0.35 - contrast) / 0.3, 0, 1);
  const isUnderwater = clamp(castScore * 0.45 + redLoss * 0.3 + flat * 0.25, 0, 1);

  return {
    meanA,
    meanB,
    castA,
    castB,
    redDeficit,
    blueDominance,
    contrast,
    isUnderwater,
    suggestedRed: clamp(0.3 + 0.7 * redLoss, 0.2, 1),
    suggestedDehaze: clamp(0.35 + 0.85 * flat + 0.3 * castScore, 0.2, 1),
    suggestedGamma: clamp(1.28 - 0.5 * meanLuma / 255, 0.85, 1.35),
    meanLuma,
  };
}

/* ------------------------------------------------- 1. white balance (LAB) */

/**
 * Gray-world style white balance applied to the a/b chroma channels only, so
 * luminance is untouched. We work in linear light for the correction, then
 * return to sRGB.
 */
function whiteBalance(
  buf: Float32Array,
  n: number,
  p: Params,
  a: Analysis,
) {
  // Shift only the *cast* relative to a neutral grey of the same brightness,
  // so a colour-accurate photo is left alone.
  const wbA = a.castA * (0.8 * p.wbStrength);
  const wbB = a.castB * (0.8 * p.wbStrength);
  const manA = p.greenBias * 0.5;
  const manB = p.warm * 0.5;
  for (let i = 0, p3 = 0; p3 < n; p3++, i += 3) {
    const r = buf[i],
      g = buf[i + 1],
      b = buf[i + 2];
    const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
    const f = (t: number) =>
      t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const fx = f(X),
      fy = f(Y),
      fz = f(Z);
    let la = 500 * (fx - fy) - wbA + manA;
    let lb = 200 * (fy - fz) - wbB + manB;
    const L = 116 * fy - 16;
    // Back to XYZ. The forward matrix is already D65-normalised (white maps to
    // X=0.9505, Y=1, Z=1.0888), so scaling by the white point again here would
    // tint every pixel.
    const fyi = (L + 16) / 116;
    const fx2 = fyi + la / 500;
    const fz2 = fyi - lb / 200;
    const inv = (t: number) => {
      const t3 = t * t * t;
      return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
    };
    const X2 = inv(fx2);
    const Y2 = inv(fyi);
    const Z2 = inv(fz2);
    buf[i] = clamp(3.2406 * X2 - 1.5372 * Y2 - 0.4986 * Z2, 0, 1);
    buf[i + 1] = clamp(-0.9689 * X2 + 1.8758 * Y2 + 0.0415 * Z2, 0, 1);
    buf[i + 2] = clamp(0.0557 * X2 - 0.204 * Y2 + 1.057 * Z2, 0, 1);
  }
}

/* ----------------------------------------------- 2. red channel restoration */

/**
 * Jaffe-McGlamery: per-channel transmittance t_c = exp(-beta_c * d) with
 * beta_r > beta_g > beta_b. Recovering the red signal means expanding the
 * compressed red range toward its observed maximum, and lifting green a little.
 * The expansion is exponential in the deficit so bright red (coral, wetsuit)
 * does not blow out while dull reds come back.
 */
function redRestore(
  buf: Float32Array,
  n: number,
  p: Params,
  deficitHint: number,
) {
  if (p.redStrength <= 0) return;
  // Observed maxima anchor the expansion target.
  let mr = 0,
    mg = 0;
  for (let i = 0, p3 = 0; p3 < n; p3++, i += 3) {
    if (buf[i] > mr) mr = buf[i];
    if (buf[i + 1] > mg) mg = buf[i + 1];
  }
  const tr = clamp(mr, 0.02, 1);
  const tg = clamp(mg, 0.02, 1);
  // How much red is genuinely missing. White balance runs first and equalises
  // the channel means, so the post-WB ratio is no longer a usable signal —
  // the caller passes the pre-WB deficit measured from the original pixels.
  // A neutral image scores ~0 and must be left alone, or grey turns magenta.
  const deficit = clamp(deficitHint, 0, 1);
  if (deficit <= 0.02) return;
  // Cap the expansion. Without a ceiling, a scene that is only mildly
  // red-deficient gets a large exponent and the frame swings magenta.
  const s = Math.min(p.redStrength, 0.5) * Math.min(deficit, 0.6);

  // Anchor the expansion at the observed max so nothing clips:
  //   f(v) = tr * (v/tr)^(1-s)   with  f(0)=0 and f(tr)=tr
  // This widens a compressed red range without inventing light or blowing out
  // pixels that were already bright.
  const k = 1 - s;
  for (let i = 0, p3 = 0; p3 < n; p3++, i += 3) {
    buf[i] = tr * Math.pow(clamp(buf[i] / tr, 0, 1), k);
  }
  // Green follows red up in step, so a warm scene is not over-corrected yellow.
  const kg = Math.pow(tg, -s * 0.5);
  for (let i = 1, p3 = 0; p3 < n; p3++, i += 3) {
    buf[i] = clamp(buf[i] * kg, 0, 1);
  }
}

/* ------------------------------------------ 3. dehazing (dark channel prior) */

/** Separable min filter, radius r, on a single channel Float32Array. */
function minFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  // van Herk / Gil-Werman: split the row into blocks of size 2r+1, compute
  // prefix and suffix minima within each block, then each window minimum is
  // min(suffix[i], prefix[i+2r]) — O(n) regardless of radius, versus the O(n*r)
  // of a sliding window. At r=3..5 over 720p the naive version was the single
  // most expensive thing in the dehaze stage.
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let b0 = 0; b0 < w; b0 += win) {
      const b1 = Math.min(w, b0 + win);
      // prefix minima (inclusive)
      let m = 1;
      for (let x = b0; x < b1; x++) {
        const v = src[row + x];
        if (v < m) m = v;
        tmp[row + x] = m;
      }
      // suffix minima (inclusive)
      m = 1;
      for (let x = b1 - 1; x >= b0; x--) {
        const v = src[row + x];
        if (v < m) m = v;
        out[row + x] = m;
      }
    }
  }
  // combine along x: window min at x = min(suffix[x], prefix[min(w-1, x+2r)])
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x2 = Math.min(w - 1, x + 2 * r);
      const a = out[row + x];
      const b = tmp[row + x2];
      tmp[row + x] = a < b ? a : b;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let b0 = 0; b0 < h; b0 += win) {
      const b1 = Math.min(h, b0 + win);
      let m = 1;
      for (let y = b0; y < b1; y++) {
        const v = tmp[y * w + x];
        if (v < m) m = v;
        out[y * w + x] = m;
      }
      m = 1;
      for (let y = b1 - 1; y >= b0; y--) {
        const v = tmp[y * w + x];
        if (v < m) m = v;
        tmp[y * w + x] = m;
      }
    }
    for (let y = 0; y < h; y++) {
      const y2 = Math.min(h - 1, y + 2 * r);
      const a = tmp[y * w + x];
      const b = out[y2 * w + x];
      tmp[y * w + x] = a < b ? a : b;
    }
  }
  return tmp;
}

function dehaze(buf: Float32Array, w: number, h: number, p: Params) {
  const omega = p.dehazeStrength;
  if (omega <= 0) return;
  const n = w * h;
  const dark = new Float32Array(n);
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const bch = new Float32Array(n);
  for (let i = 0, p3 = 0; p3 < n; p3++, i += 3) {
    r[p3] = buf[i];
    g[p3] = buf[i + 1];
    bch[p3] = buf[i + 2];
  }
  // dark channel = min over channels of a local min
  const mr = minFilter(r, w, h, 3);
  const mg = minFilter(g, w, h, 3);
  const mb = minFilter(bch, w, h, 3);
  for (let i = 0; i < n; i++) dark[i] = Math.min(mr[i], mg[i], mb[i]);

  // Atmospheric light: the brightest pixels *within* the darkest pixels
  // (He et al.). Sorting every pixel to find that top 0.1% costs O(n log n)
  // and dominated the frame budget, so bucket the dark channel into a
  // 1024-bin histogram and walk down the bins instead — O(n), same answer.
  const BINS = 1024;
  const hist = new Int32Array(BINS);
  for (let i = 0; i < n; i++) {
    const b = clamp(Math.floor(dark[i] * BINS), 0, BINS - 1);
    hist[b]++;
  }
  const top = Math.max(1, Math.floor(n * 0.001));
  // find the cutoff bin holding the top `top` darkest-channel pixels
  let acc = 0,
    cutoff = 0;
  for (let b = BINS - 1; b >= 0; b--) {
    if (hist[b] === 0) continue;
    if (acc + hist[b] >= top) {
      cutoff = b;
      break;
    }
    acc += hist[b];
    cutoff = b;
  }
  // average the channels over pixels at or above the cutoff bin
  const lo = cutoff / BINS;
  let aR = 0,
    aG = 0,
    aB = 0,
    cntA = 0;
  for (let i = 0; i < n; i++) {
    if (dark[i] >= lo) {
      aR += r[i];
      aG += g[i];
      aB += bch[i];
      cntA++;
    }
  }
  if (cntA === 0) {
    aR = aG = aB = 0.5;
    cntA = 1;
  }
  aR /= cntA;
  aG /= cntA;
  aB /= cntA;
  const A = Math.max(aR, aG, aB, 0.05);
  const aArr = [aR, aG, aB];

  // Haze presence. The dark channel prior assumes the dark channel sits well
  // below the atmospheric light. In a clean image dark ~= A everywhere, so
  // driving omega to full strength would divide by a tiny transmission and
  // collapse the whole frame toward the atmospheric colour. Scale omega by how
  // much veil is actually present: clean scenes get omega_eff ~ 0, which makes
  // t = 1 and the whole stage a no-op.
  let sumDark = 0;
  for (let i = 0; i < n; i++) sumDark += dark[i];
  const meanDark = sumDark / n;
  const haze = clamp(1 - meanDark / A, 0, 1);
  const omegaEff = omega * Math.pow(haze, 0.7);
  if (omegaEff < 0.01) return;

  // transmission
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = 1 - omegaEff * (dark[i] / A);
  }
  // refine with a min filter: keeps distant haze while restoring near detail
  const tRef = minFilter(t, w, h, 5);
  for (let i = 0, p3 = 0; p3 < n; p3++, i += 3) {
    const tr = Math.max(0.25, tRef[p3]);
    buf[i] = clamp((buf[i] - aArr[0]) / tr + aArr[0], 0, 1);
    buf[i + 1] = clamp((buf[i + 1] - aArr[1]) / tr + aArr[1], 0, 1);
    buf[i + 2] = clamp((buf[i + 2] - aArr[2]) / tr + aArr[2], 0, 1);
  }
}

/* ------------------------------------------- 4/5. luminance ops: L + CLAHE */

/** Separable box blur, radius r. */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const norm = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[y * w + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / norm;
      sum -= src[y * w + clamp(x - r, 0, w - 1)];
      sum += src[y * w + clamp(x + r + 1, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / norm;
      sum -= tmp[clamp(y - r, 0, h - 1) * w + x];
      sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x];
    }
  }
  return out;
}

/**
 * CLAHE on the L channel (Zuiderveld). Tiles x tiles local histograms, clip at
 * clipLimit * tilePixels / 256, redistribute, then bilinear-interpolate the four
 * neighbouring tile mappings so there are no seams.
 */
function clahe(L: Float32Array, w: number, h: number, tiles: number, clipLimit: number) {
  const tw = Math.max(1, Math.round(w / tiles));
  const th = Math.max(1, Math.round(h / tiles));
  // one histogram LUT per tile; boundaries are smoothed by bilinear blending
  // between the four neighbouring LUTs (below), not by blurring the LUTs
  const luts: Float32Array[] = [];
  const BINS = 256;
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const hist = new Float32Array(BINS);
      const x0 = tx * tw,
        x1 = Math.min(w, x0 + tw);
      const y0 = ty * th,
        y1 = Math.min(h, y0 + th);
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = clamp(Math.round(L[y * w + x] * 255), 0, 255);
          hist[v]++;
          count++;
        }
      }
      const limit = Math.max(1, (clipLimit * count) / BINS);
      let excess = 0;
      for (let i = 0; i < BINS; i++) {
        if (hist[i] > limit) {
          excess += hist[i] - limit;
          hist[i] = limit;
        }
      }
      const inc = excess / BINS;
      let cum = 0;
      const lut = new Float32Array(BINS);
      for (let i = 0; i < BINS; i++) {
        cum += hist[i] + inc;
        lut[i] = cum / count;
      }
      luts.push(lut);
    }
  }
  const out = new Float32Array(L.length);
  for (let y = 0; y < h; y++) {
    const fy = y / th - 0.5;
    const ty0 = clamp(Math.floor(fy), 0, tiles - 1);
    const ty1 = clamp(ty0 + 1, 0, tiles - 1);
    const wy = fy - Math.floor(fy);
    for (let x = 0; x < w; x++) {
      const fx = x / tw - 0.5;
      const tx0 = clamp(Math.floor(fx), 0, tiles - 1);
      const tx1 = clamp(tx0 + 1, 0, tiles - 1);
      const wx = fx - Math.floor(fx);
      const v = clamp(Math.round(L[y * w + x] * 255), 0, 255);
      const l00 = luts[ty0 * tiles + tx0][v];
      const l01 = luts[ty0 * tiles + tx1][v];
      const l10 = luts[ty1 * tiles + tx0][v];
      const l11 = luts[ty1 * tiles + tx1][v];
      const top = l00 + (l01 - l00) * wx;
      const bot = l10 + (l11 - l10) * wx;
      out[y * w + x] = top + (bot - top) * wy;
    }
  }
  return out;
}

/* ------------------------------------------------------------ entry point */

export function process(
  src: ImageData,
  p: Params,
  a?: Analysis,
): { image: ImageData; analysis: Analysis } {
  const w = src.width,
    h = src.height,
    n = w * h;
  const analysis = a ?? analyse(src);
  const buf = new Float32Array(n * 3);
  for (let i = 0, p3 = 0, q = 0; p3 < n; p3++, i += 4, q += 3) {
    buf[q] = toLinear(src.data[i]);
    buf[q + 1] = toLinear(src.data[i + 1]);
    buf[q + 2] = toLinear(src.data[i + 2]);
  }

  whiteBalance(buf, n, p, analysis);
  redRestore(buf, n, p, analysis.redDeficit);
  dehaze(buf, w, h, p);

  // Photometric stages (white balance, red restore, dehazing) belong in linear
  // light, where the absorption/scattering model is physically meaningful. The
  // remaining stages are perceptual, so convert to sRGB first — running CLAHE
  // or unsharp on linear luma wastes most of their gain to the gamma curve.
  const enc = new Float32Array(n * 3);
  for (let q = 0; q < n * 3; q += 3) {
    // Float all the way through: rounding here is what caused banding.
    enc[q] = toSrgbF(buf[q]);
    enc[q + 1] = toSrgbF(buf[q + 1]);
    enc[q + 2] = toSrgbF(buf[q + 2]);
  }

  // perceptual luminance plane
  const L = new Float32Array(n);
  for (let p3 = 0, q = 0; p3 < n; p3++, q += 3) {
    L[p3] = clamp(
      0.2126 * enc[q] + 0.7152 * enc[q + 1] + 0.0722 * enc[q + 2],
      0,
      1,
    );
  }

  if (p.claheClip > 0) {
    const Lc = clahe(L, w, h, p.claheTiles, p.claheClip);
    // CLAHE is about local contrast, not overall brightness: keep the mean.
    let sm = 0,
      sc = 0;
    for (let i = 0; i < n; i++) {
      sm += L[i];
      sc += Lc[i];
    }
    const k = sc > 1e-6 ? sm / sc : 1;
    // Push the new luminance back into the colour planes, preserving chroma
    // ratios so local contrast rises without shifting hue.
    for (let i = 0, q = 0; i < n; i++, q += 3) {
      const nv = clamp(Lc[i] * k, 0, 1);
      const scale = L[i] > 1e-4 ? nv / L[i] : 1;
      enc[q] = clamp(enc[q] * scale, 0, 1);
      enc[q + 1] = clamp(enc[q + 1] * scale, 0, 1);
      enc[q + 2] = clamp(enc[q + 2] * scale, 0, 1);
      L[i] = nv;
    }
  }

  if (p.sharpenAmount > 0) {
    const blur = boxBlur(L, w, h, 2);
    const amt = p.sharpenAmount;
    for (let i = 0, q = 0; i < n; i++, q += 3) {
      const v = clamp(L[i] + amt * (L[i] - blur[i]), 0, 1);
      const scale = L[i] > 1e-4 ? v / L[i] : 1;
      enc[q] = clamp(enc[q] * scale, 0, 1);
      enc[q + 1] = clamp(enc[q + 1] * scale, 0, 1);
      enc[q + 2] = clamp(enc[q + 2] * scale, 0, 1);
      L[i] = v;
    }
  }

  // tone: levels then gamma.
  // The LUT is indexed on the float sRGB value, not on a rounded byte — a
  // 256-entry table fed a quantised index re-imposed exactly the 8-bit steps
  // the float path above exists to avoid.
  const invGamma = 1 / p.gamma;
  const TONE_N = 4095;
  const lut = new Float32Array(TONE_N + 1);
  for (let i = 0; i <= TONE_N; i++) {
    let v = i / TONE_N;
    v = clamp(
      (v - p.blackPoint) / Math.max(1e-4, p.whitePoint - p.blackPoint),
      0,
      1,
    );
    lut[i] = clamp(Math.pow(v, invGamma), 0, 1);
  }
  const tone = (v: number): number => {
    const x = clamp(v, 0, 1) * TONE_N;
    // same off-by-one guard as toSrgbF: at exactly 1.0 the interpolation
    // would step past the table and produce NaN
    if (x >= TONE_N) return lut[TONE_N];
    const i = x | 0;
    const a = lut[i];
    return a + (lut[i + 1] - a) * (x - i);
  };

  // Final de-cast guard. The stages above can leave a residual global tint
  // (typically magenta, from red expansion outrunning green). Measure the
  // output's mean chroma against a neutral grey and remove the excess, so the
  // result reads as "recovered colour" rather than a colour filter.
  if (p.wbStrength > 0) {
    let sr = 0,
      sg = 0,
      sb = 0;
    for (let q = 0; q < n * 3; q += 3) {
      sr += enc[q];
      sg += enc[q + 1];
      sb += enc[q + 2];
    }
    const mr = sr / n,
      mg = sg / n,
      mb = sb / n;
    // target: channel means equal, i.e. the grey-world solution
    const mAvg = (mr + mg + mb) / 3;
    const kR = mAvg / (mr + 1e-6);
    const kG = mAvg / (mg + 1e-6);
    const kB = mAvg / (mb + 1e-6);
    // limit the correction to a gentle trim so local colour is preserved
    const g = 0.6 * p.wbStrength;
    // Weight the trim toward mid-tones. A flat global gain chases the bright
    // foreground (here a wall of yellow fish) and leaves deep shadows, which
    // carry almost no red signal, tinted purple. Mid-tones are where the cast
    // is actually visible and where the correction reads as natural.
    for (let i = 0, q = 0; i < n; i++, q += 3) {
      const l =
        0.2126 * enc[q] + 0.7152 * enc[q + 1] + 0.0722 * enc[q + 2];
      // 0 in deep shadow, 1 through the mid-tones, easing off in highlights
      const w =
        l < 0.35
          ? Math.pow(clamp(l / 0.35, 0, 1), 1.5)
          : l > 0.8
            ? Math.max(0, 1 - (l - 0.8) / 0.2) * 0.5 + 0.5
            : 1;
      const e = g * w;
      enc[q] = clamp(enc[q] * (1 + (clamp(kR, 0.7, 1.4) - 1) * e), 0, 1);
      enc[q + 1] = clamp(enc[q + 1] * (1 + (clamp(kG, 0.7, 1.4) - 1) * e), 0, 1);
      enc[q + 2] = clamp(enc[q + 2] * (1 + (clamp(kB, 0.7, 1.4) - 1) * e), 0, 1);
    }
  }

  const out = new ImageData(w, h);
  const od = out.data;
  const halfLsb = 0.5 / 255;
  for (let i = 0, p3 = 0, q = 0; p3 < n; p3++, i += 4, q += 3) {
    // enc is already sRGB-encoded; re-encoding here would apply gamma twice.
    // tone() takes the float directly, so no 8-bit round trip before the curve.
    let r = tone(enc[q]);
    let g = tone(enc[q + 1]);
    let b = tone(enc[q + 2]);
    if (p.saturation !== 1) {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = clamp(l + (r - l) * p.saturation, 0, 1);
      g = clamp(l + (g - l) * p.saturation, 0, 1);
      b = clamp(l + (b - l) * p.saturation, 0, 1);
    }
    // Triangular dither: (u - v) over two uniform draws. Half an LSB of peak
    // amplitude is below the visible noise floor but decorrelates the final
    // 8-bit rounding, which is what makes banding appear.
    const d0 = ditherNoise(p3) * halfLsb;
    const d1 = ditherNoise(p3 + 0x51ed2701) * halfLsb;
    od[i] = clamp(Math.round(r * 255 + d0), 0, 255);
    od[i + 1] = clamp(Math.round(g * 255 + d0), 0, 255);
    od[i + 2] = clamp(Math.round(b * 255 + d1), 0, 255);
    od[i + 3] = src.data[i + 3];
  }
  return { image: out, analysis };
}

/**
 * Auto-tuned params for a given image, merged over the user's other choices.
 *
 * Every gain is scaled by how strongly the image actually reads as underwater.
 * A shot taken with a strobe already has its reds back; pushing the same
 * correction at it only produces oversaturated, posterised neon.
 *
 * `manual` holds the keys the user has taken ownership of by moving a slider or
 * picking a preset. Those are left alone. Without this, auto silently overwrote
 * 5 of the 9 sliders — the control moved, the image did not, and the app looked
 * broken.
 */
export function autoParams(
  base: Params,
  a: Analysis,
  manual?: ReadonlySet<keyof Params>,
): Params {
  const k = 0.35 + 0.65 * a.isUnderwater; // global aggression
  const out = { ...base } as Params;
  const set = (key: keyof Params, v: number) => {
    if (!manual?.has(key)) (out as unknown as Record<string, number>)[key] = v;
  };
  set('redStrength', a.suggestedRed * k);
  set('dehazeStrength', a.suggestedDehaze * k);
  set('gamma', 1 + (a.suggestedGamma - 1) * k);
  set('claheClip', clamp(1 + 2.2 * (1 - a.contrast), 1, 3.2) * k);
  set('sharpenAmount', clamp(0.3 + 0.7 * (1 - a.contrast), 0.2, 1) * k);
  // a well-exposed, already colourful frame should not also be saturated
  set('saturation', 1 + (base.saturation - 1) * k);
  return out;
}
