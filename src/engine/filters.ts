/**
 * Small-image filters for the analysis mirror. These run on the ~256 px
 * analysis frame only, so clarity beats cleverness; everything is O(n) or
 * O(n·r) with r ≤ 4.
 */

/** Separable box mean with edge clamping, radius r. */
let scratch = new Float32Array(0);

export function boxMean(src: Float32Array, w: number, h: number, r: number, out?: Float32Array): Float32Array {
  if (scratch.length < src.length) scratch = new Float32Array(src.length);
  const tmp = scratch;
  const dst = out ?? new Float32Array(src.length);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let k = -r; k <= r; k++) s += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s * norm;
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = s * norm;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return dst;
}

/** Separable min filter, radius r (square window). */
export function minFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const dst = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      const x0 = Math.max(0, x - r),
        x1 = Math.min(w - 1, x + r);
      for (let k = x0; k <= x1; k++) if (src[row + k] < m) m = src[row + k];
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = Infinity;
      const y0 = Math.max(0, y - r),
        y1 = Math.min(h - 1, y + r);
      for (let k = y0; k <= y1; k++) if (tmp[k * w + x] < m) m = tmp[k * w + x];
      dst[y * w + x] = m;
    }
  }
  return dst;
}

let gf = new Float32Array(0);

/**
 * He et al. guided filter, returning the *averaged coefficients* rather than
 * the filtered output. The GPU evaluates `q = meanA · I + meanB` against the
 * full-resolution guide, which is exactly the Fast Guided Filter upsampling:
 * transmission is estimated at 256 px but its edges follow full-res detail.
 */
export function guidedCoefficients(
  I: Float32Array,
  p: Float32Array,
  w: number,
  h: number,
  r: number,
  eps: number,
): { a: Float32Array; b: Float32Array } {
  const n = w * h;
  if (gf.length < n * 8) gf = new Float32Array(n * 8);
  const v = (k: number) => gf.subarray(k * n, (k + 1) * n);
  const Ip = v(0), II = v(1), mI = v(2), mP = v(3), mIp = v(4), mII = v(5), a = v(6), b = v(7);
  for (let i = 0; i < n; i++) {
    Ip[i] = I[i] * p[i];
    II[i] = I[i] * I[i];
  }
  boxMean(I, w, h, r, mI);
  boxMean(p, w, h, r, mP);
  boxMean(Ip, w, h, r, mIp);
  boxMean(II, w, h, r, mII);
  for (let i = 0; i < n; i++) {
    const cov = mIp[i] - mI[i] * mP[i];
    const vr = mII[i] - mI[i] * mI[i];
    a[i] = cov / (vr + eps);
    b[i] = mP[i] - a[i] * mI[i];
  }
  // outputs are fresh: the caller keeps them past the next call
  return { a: boxMean(a, w, h, r), b: boxMean(b, w, h, r) };
}

/** Value at quantile q (0..1) of values assumed in [0,1], via a histogram. */
export function quantiles(src: Float32Array, qs: number[], bins = 1024): number[] {
  const hist = new Uint32Array(bins);
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    hist[v <= 0 ? 0 : v >= 1 ? bins - 1 : (v * bins) | 0]++;
  }
  const out: number[] = [];
  for (const q of qs) {
    const target = q * src.length;
    let acc = 0,
      b = 0;
    for (; b < bins; b++) {
      acc += hist[b];
      if (acc >= target) break;
    }
    out.push((Math.min(b, bins - 1) + 0.5) / bins);
  }
  return out;
}
