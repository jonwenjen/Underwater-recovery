/**
 * Colour math shared by the CPU analysis mirror and (by construction) the
 * GLSL shaders. Anything changed here must be changed in `shaders.ts` too —
 * the auto engine predicts what the GPU will produce from these formulas.
 */

export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

export type Vec3 = [number, number, number];
/** Row-major 3×3. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const luma = (r: number, g: number, b: number) => LUMA_R * r + LUMA_G * g + LUMA_B * b;

/* ------------------------------------------------------------ transfer */

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(l: number): number {
  const v = clamp(l, 0, 1);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** 8-bit sRGB code → linear. 256 entries, so a table beats `pow` every time. */
export const LIN8 = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
  return t;
})();

const ENC_N = 4096;
const ENC = (() => {
  const t = new Float32Array(ENC_N + 1);
  for (let i = 0; i <= ENC_N; i++) t[i] = linearToSrgb(i / ENC_N);
  return t;
})();
/** Linear → sRGB (float, not rounded) via a 4k table with interpolation. */
export function encodeFast(l: number): number {
  if (l <= 0) return 0;
  if (l >= 1) return 1;
  const x = l * ENC_N;
  const i = x | 0;
  return ENC[i] + (ENC[i + 1] - ENC[i]) * (x - i);
}

/**
 * Highlight shoulder: identity below 0.8, then a tanh roll-off that approaches
 * 1.0 instead of clipping, so exposure lifts do not flatten bright water.
 */
export function shoulder(x: number): number {
  const k = 0.8;
  return x < k ? x : k + (1 - k) * Math.tanh((x - k) / (1 - k));
}

/* ------------------------------------------------------------- matrices */

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}
export function apply3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
export function inv3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h,
    B = -(d * i - f * g),
    C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const k = 1 / det;
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
  ];
}
const diag = (x: number, y: number, z: number): Mat3 => [x, 0, 0, 0, y, 0, 0, 0, z];

const SRGB_TO_XYZ: Mat3 = [
  0.4124, 0.3576, 0.1805,
  0.2126, 0.7152, 0.0722,
  0.0193, 0.1192, 0.9505,
];
const BRADFORD: Mat3 = [
  0.8951, 0.2664, -0.1614,
  -0.7502, 1.7135, 0.0367,
  0.0389, -0.0685, 1.0296,
];
/** linear sRGB → Bradford cone space, and back. */
const RGB_TO_LMS = mul3(BRADFORD, SRGB_TO_XYZ);
const LMS_TO_RGB = inv3(RGB_TO_LMS);
const LMS_WHITE = apply3(RGB_TO_LMS, [1, 1, 1]);

/**
 * White balance as a von Kries adaptation in Bradford cone space: one 3×3
 * matrix that maps the estimated illuminant to a neutral of equal luminance.
 * `temp` (+ warmer) and `tint` (+ magenta) are applied as luminance-neutral
 * gains afterwards.
 */
export function whiteBalanceMatrix(illum: Vec3, temp: number, tint: number): Mat3 {
  const y = Math.max(1e-4, luma(illum[0], illum[1], illum[2]));
  const n: Vec3 = [illum[0] / y, illum[1] / y, illum[2] / y];
  const lms = apply3(RGB_TO_LMS, n);
  const cat = mul3(
    LMS_TO_RGB,
    mul3(
      diag(
        LMS_WHITE[0] / Math.max(1e-4, lms[0]),
        LMS_WHITE[1] / Math.max(1e-4, lms[1]),
        LMS_WHITE[2] / Math.max(1e-4, lms[2]),
      ),
      RGB_TO_LMS,
    ),
  );
  const gr = 1 + 0.3 * temp,
    gg = 1 - 0.22 * tint,
    gb = 1 - 0.3 * temp;
  const gy = luma(gr, gg, gb);
  return mul3(diag(gr / gy, gg / gy, gb / gy), cat);
}

/** Row-major → column-major Float32Array for `uniformMatrix3fv`. */
export function toGLMat3(m: Mat3): Float32Array {
  return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}
