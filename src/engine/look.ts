/**
 * The "look" stage: user curves (RGB master + R/G/B) and an 8-band HSL mixer.
 * Applied last in the FINAL shader; these JS twins build the LUT and let the
 * tests check the maths the shader mirrors (`applyLook` in shaders.ts).
 */
import { clamp, fromOklab, linearToSrgb, smoothstep, srgbToLinear, toOklab, type Vec3 } from './color.ts';

/* ---------------------------------------------------------------- curves */

export type Pt = [number, number];
export interface Curves {
  rgb: Pt[];
  r: Pt[];
  g: Pt[];
  b: Pt[];
}
export type CurveChannel = keyof Curves;

const line = (): Pt[] => [
  [0, 0],
  [1, 1],
];
export const identityCurves = (): Curves => ({ rgb: line(), r: line(), g: line(), b: line() });

export const isIdentityCurve = (pts: Pt[]) => pts.every(([x, y]) => Math.abs(x - y) < 1e-6);
export const isIdentityCurves = (c: Curves) =>
  isIdentityCurve(c.rgb) && isIdentityCurve(c.r) && isIdentityCurve(c.g) && isIdentityCurve(c.b);

/**
 * Monotone cubic (Fritsch–Carlson) through the control points: smooth like a
 * spline but never overshoots, so a curve can never invert or ring.
 * Outside the first/last point the curve is flat (black / white point).
 */
export function curveFn(points: Pt[]): (x: number) => number {
  const pts = [...points]
    .map(([x, y]) => [clamp(x, 0, 1), clamp(y, 0, 1)] as Pt)
    .sort((a, b) => a[0] - b[0])
    .filter((p, i, arr) => i === 0 || p[0] - arr[i - 1][0] > 1e-4);
  const n = pts.length;
  if (n === 0) return (x) => x;
  if (n === 1) return () => pts[0][1];
  const xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i],
      b = m[i + 1] / d[i],
      s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i],
      t = (x - xs[i]) / h;
    const t2 = t * t,
      t3 = t2 * t;
    return clamp(
      (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1],
      0,
      1,
    );
  };
}

export const LOOK_N = 256;

/** RGBA LUT: channel c = master(curve_c(x)) — per-channel first, then RGB. */
export function buildCurveLut(c: Curves): Float32Array {
  const fm = curveFn(c.rgb),
    fr = curveFn(c.r),
    fg = curveFn(c.g),
    fb = curveFn(c.b);
  const lut = new Float32Array(LOOK_N * 4);
  for (let i = 0; i < LOOK_N; i++) {
    const x = i / (LOOK_N - 1);
    lut[i * 4] = fm(fr(x));
    lut[i * 4 + 1] = fm(fg(x));
    lut[i * 4 + 2] = fm(fb(x));
    lut[i * 4 + 3] = 1;
  }
  return lut;
}

export function sampleCurveLut(lut: Float32Array, ch: 0 | 1 | 2, x: number): number {
  const f = clamp(x, 0, 1) * (LOOK_N - 1);
  const i = Math.min(LOOK_N - 2, Math.floor(f));
  return lut[i * 4 + ch] + (lut[(i + 1) * 4 + ch] - lut[i * 4 + ch]) * (f - i);
}

/* ------------------------------------------------------------------- HSL */

export const HSL_BANDS = [
  { key: 'red', label: '紅', rgb: [1, 0, 0] },
  { key: 'orange', label: '橙', rgb: [1, 0.5, 0] },
  { key: 'yellow', label: '黃', rgb: [1, 1, 0] },
  { key: 'green', label: '綠', rgb: [0, 1, 0] },
  { key: 'aqua', label: '青', rgb: [0, 1, 1] },
  { key: 'blue', label: '藍', rgb: [0, 0, 1] },
  { key: 'purple', label: '紫', rgb: [0.5, 0, 1] },
  { key: 'magenta', label: '洋紅', rgb: [1, 0, 1] },
] as const;

const TAU = Math.PI * 2;

/** OKLCh hue of each band's reference colour, ascending in [0, 2π). */
export const HSL_CENTERS: number[] = HSL_BANDS.map(({ rgb }) => {
  const lab = toOklab(srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2]));
  const h = Math.atan2(lab[2], lab[1]);
  return h < 0 ? h + TAU : h;
});

/** Values per band, each −100 … 100 (hue: ±30°; saturation: ×0 … ×2; luminance: ±0.2 L). */
export interface Hsl {
  h: number[];
  s: number[];
  l: number[];
}
export const identityHsl = (): Hsl => ({ h: new Array(8).fill(0), s: new Array(8).fill(0), l: new Array(8).fill(0) });
export const isIdentityHsl = (x: Hsl) => [...x.h, ...x.s, ...x.l].every((v) => v === 0);

/**
 * Band weights for a hue: a partition of unity that eases between the two
 * neighbouring band centres, so adjusting 藍 fades smoothly into 青 and 紫
 * with no seams. Mirrors `hslWeights` in GLSL.
 */
export function hslWeights(hue: number): number[] {
  const hh = ((hue % TAU) + TAU) % TAU;
  const c = HSL_CENTERS;
  const w = new Array(8).fill(0);
  let i0 = 7,
    a: number,
    b: number;
  for (let i = 0; i < 7; i++)
    if (hh >= c[i] && hh < c[i + 1]) {
      i0 = i;
      break;
    }
  if (i0 < 7) {
    a = c[i0];
    b = c[i0 + 1];
  } else if (hh >= c[7]) {
    a = c[7];
    b = c[0] + TAU;
  } else {
    a = c[7] - TAU;
    b = c[0];
  }
  const t = smoothstep(0, 1, (hh - a) / (b - a));
  w[i0] = 1 - t;
  w[(i0 + 1) % 8] += t;
  return w;
}

/** In-gamut OKLab → linear sRGB: shrink chroma (by bisection) until it fits. */
export function fitLab(L: number, a: number, b: number): Vec3 {
  const ok = (c: Vec3) => Math.min(c[0], c[1], c[2]) >= -1e-4 && Math.max(c[0], c[1], c[2]) <= 1.0001;
  let c = fromOklab(L, a, b);
  if (ok(c)) return c;
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 6; i++) {
    const mid = 0.5 * (lo + hi);
    if (ok(fromOklab(L, a * mid, b * mid))) lo = mid;
    else hi = mid;
  }
  c = fromOklab(L, a * lo, b * lo);
  return [clamp(c[0], 0, 1), clamp(c[1], 0, 1), clamp(c[2], 0, 1)];
}

/** Apply the HSL mixer to one sRGB-encoded colour. */
export function applyHsl(rgb: Vec3, x: Hsl): Vec3 {
  const lab = toOklab(srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2]));
  const C = Math.hypot(lab[1], lab[2]);
  if (C < 1e-5) return rgb; // greys have no hue: nothing to adjust
  const h = Math.atan2(lab[2], lab[1]);
  const w = hslWeights(h);
  let dh = 0,
    ds = 0,
    dl = 0;
  for (let i = 0; i < 8; i++) {
    dh += w[i] * x.h[i];
    ds += w[i] * x.s[i];
    dl += w[i] * x.l[i];
  }
  const colourful = smoothstep(0.003, 0.02, C); // true greys stay put; pale colours (water!) respond fully
  const h2 = h + (dh / 100) * (Math.PI / 6) * colourful;
  const C2 = C * Math.max(0, 1 + (ds / 100) * colourful);
  const L2 = clamp(lab[0] + (dl / 100) * 0.2 * colourful, 0, 1);
  const lin = fitLab(L2, C2 * Math.cos(h2), C2 * Math.sin(h2));
  return [linearToSrgb(lin[0]), linearToSrgb(lin[1]), linearToSrgb(lin[2])];
}

/** Everything the FINAL pass needs for the look stage. */
export interface Look {
  curves: Curves;
  hsl: Hsl;
}
export const identityLook = (): Look => ({ curves: identityCurves(), hsl: identityHsl() });
export const cloneLook = (l: Look): Look => ({
  curves: {
    rgb: l.curves.rgb.map((p) => [...p] as Pt),
    r: l.curves.r.map((p) => [...p] as Pt),
    g: l.curves.g.map((p) => [...p] as Pt),
    b: l.curves.b.map((p) => [...p] as Pt),
  },
  hsl: { h: [...l.hsl.h], s: [...l.hsl.s], l: [...l.hsl.l] },
});
