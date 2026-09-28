/**
 * Depth-guided physical restoration, in the spirit of
 * "Deep See Water" / Jamieson, How, Girdhar, ICRA 2023
 * (<https://arxiv.org/abs/2303.04025>, doi:10.1109/ICRA48891.2023.10160477).
 *
 * Provenance and licence
 * ----------------------
 * warplab/DeepSeeColor is AGPL-3.0; this repository is MIT. No code from it
 * is used. What is reimplemented here is the published physical model, which
 * is just the Akkaynak–Treibitz underwater image formation model:
 *
 *     I_c(x) = J_c(x) * A_c(z) + B_c(z)
 *     A_c(z) = exp(-a_c * z)              attenuation
 *     B_c(z) = beta_c * (1 - A_c(z))      backscatter
 *     J_c    = (I_c - B_c) / A_c          restoration
 *
 * The published work fits a_c and beta_c per image with a small self-supervised
 * network (25 scalars, 1x1 convolutions). A browser has no depth map and no
 * optimiser budget per frame, so this module takes the route the paper's own
 * analysis points to: solve the closed form with fixed Jerlov water-type
 * coefficients and let the existing dark-channel pass supply a pseudo-depth.
 * That is a documented approximation, not a reproduction — the gain clamp
 * below is doing the work a trained network would otherwise do.
 *
 * A note on attribution: the commonly cited "Deep See Water: Towards
 * Underwater Image Enhancement Using CNN" (Li, Guo, Loy, He, ECCV 2018) could
 * not be verified to exist — searches of the full ECCV 2018 programme, DBLP,
 * Crossref and arXiv all came back empty. The ICRA 2023 paper above is real
 * and is what warplab/DeepSeeColor actually implements.
 */

import type { Vec3 } from './color.ts';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Per-channel attenuation coefficients a_c, in 1/m, by water type. */
export interface WaterType {
  ar: number;
  ag: number;
  ab: number;
  /** Backscatter scale. */
  beta: number;
}

export const JERLOV: Record<string, WaterType> = {
  /** Most open-ocean clear water. Red is gone within a few metres. */
  blue: { ar: 0.45, ag: 0.09, ab: 0.025, beta: 0.9 },
  /** Coastal: more particulate, so more backscatter and faster falloff. */
  coastal: { ar: 0.38, ag: 0.11, ab: 0.06, beta: 1.1 },
  /** Green inland / algal water: green survives, red dies. */
  green: { ar: 0.5, ag: 0.05, ab: 0.16, beta: 1.0 },
};

/**
 * Hard ceiling on the restoration gain.
 *
 * The physical gain exp(a_c * z) is unbounded: a pixel 40 m out with almost no
 * surviving red asks for a multiple of 100, and in a real image that pixel is
 * sensor noise, not signal. Clamping at 3 costs a little accuracy on genuinely
 * distant subjects and removes an entire class of magenta confetti. The
 * published implementation clamps for the same reason.
 */
export const MAX_GAIN = 3;

/** The restoration of one pixel at depth `z` (metres). */
export function physicalRestore(
  I: number,
  rgb: Vec3,
  w: WaterType,
  z: number,
  backscatter: number,
): number {
  if (z <= 0) return rgb[I];
  const a = I === 0 ? w.ar : I === 1 ? w.ag : w.ab;
  const att = Math.exp(-a * z);
  const b = backscatter * w.beta * (1 - att);
  const gain = clamp(Math.exp(a * z), 1, MAX_GAIN);
  return Math.max(0, (rgb[I] - b) * gain);
}

/** Per-channel version, which is what the shader actually wants. */
export function physicalRestoreRGB(rgb: Vec3, w: WaterType, z: number, backscatter: number): Vec3 {
  if (z <= 0) return [rgb[0], rgb[1], rgb[2]];
  const out: number[] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = c === 0 ? w.ar : c === 1 ? w.ag : w.ab;
    const att = Math.exp(-a * z);
    // Differential gain, anchored on green: exp(0) = 1 for green, so the
    // best-preserved channel passes through untouched.
    const gain = clamp(Math.exp((a - w.ag) * z), c === 2 ? 0 : 1, MAX_GAIN);
    // Never remove more than half a channel: mirrors the shader guard, which
    // stops the backscatter term from exceeding the red that survived.
    const b = Math.min(backscatter * w.beta * (1 - att), rgb[c] * 0.5);
    out[c] = Math.max(0, (rgb[c] - b) * gain);
  }
  return out as Vec3;
}

/**
 * Least-squares fit of the backscatter scale for one channel, over a set of
 * (depth, observed) samples. Returns the scale that minimises the residual of
 * `obs = s * (1 - exp(-a z))`, which is the closed form of the objective the
 * published method minimises with gradient descent.
 */
export function fitBackscatter(zs: Float32Array, obs: Float32Array, w: WaterType, channel = 1): number {
  const a = channel === 0 ? w.ar : channel === 1 ? w.ag : w.ab;
  let num = 0;
  let den = 0;
  for (let i = 0; i < zs.length; i++) {
    const basis = 1 - Math.exp(-a * zs[i]);
    num += obs[i] * basis;
    den += basis * basis;
  }
  return den > 1e-9 ? clamp(num / den, 0, 1) : 0;
}

/**
 * Least-squares fit of a per-channel attenuation scale against an observed
 * falloff, used when the water type is unknown. Returns [a_r, a_g, a_b].
 */
export function fitAttenuation(zs: Float32Array, obs: Float32Array, w: WaterType): [number, number, number] {
  const base = [w.ar, w.ag, w.ab];
  const out: number[] = [];
  for (let c = 0; c < 3; c++) {
    // fit a scale on the fixed Jerlov slope: obs ~ exp(-k * a * z)
    let num = 0;
    let den = 0;
    for (let i = 0; i < zs.length; i++) {
      const basis = -base[c] * zs[i];
      num += obs[i] * basis;
      den += basis * basis;
    }
    out.push(clamp(den > 1e-9 ? num / den : 1, 0.05, 4));
  }
  return out as [number, number, number];
}

/**
 * The restoration as the FINAL shader applies it (`physical` in shaders.ts),
 * on sRGB-encoded 0..1 colour: per-channel attenuation `a` (a_c·z, already
 * differential against green), backscatter scale `back` (β folded in), gain
 * clamped at MAX_GAIN, never more than half a channel subtracted.
 */
export function physicalGL(c: number, a: number, back: number): number {
  const A = Math.exp(-a);
  const B = back * (1 - A);
  const g = clamp(Math.exp(a), 0, MAX_GAIN);
  const b = Math.min(B, c * 0.5);
  return Math.max(0, (c - b) * g);
}
