/**
 * Two-step single-image enhancement — Fu, Fan, Ling, Huang, Ding,
 * "Two-Step Approach for Single Underwater Image Enhancement", ISPACS 2017.
 * <https://xueyangfu.github.io/paper/2017/ISPACS/ISPACS2017.pdf>
 *
 * Provenance: implemented from the paper's equations. The upstream GitHub
 * "resource" this was taken from is a link list with no code, and it is not a
 * licence-bearing source, so nothing could be — or was — copied.
 *
 * What is ported, and why
 * -----------------------
 * The paper is two steps: per-channel mean pull (Eq. 1-2) then an optimal
 * contrast blend against a CLAHE reference (Eq. 5-6). The contrast step is NOT
 * ported, for two reasons worth stating plainly:
 *
 *  1. Its gradient terms cancel analytically when both weights are equal, so
 *     the stated closed form (Eq. 6) is a plain weighted average dressed up
 *     with a Fourier denominator whose DC gain is 1/2 — i.e. printing it
 *     faithfully halves the brightness of every image. The correct
 *     Tikhonov-regularised form is implementable but is "weighted average plus
 *     a high-frequency shelf", which this engine already obtains from CLAHE +
 *     clarity, so it would add cost and no new capability.
 *
 * What IS ported is Eq. 2's protection branch, which is the genuinely
 * missing idea: when a channel is so attenuated that most of it is piled near
 * black, a contrast stretch blows the shadow noise apart, so instead of
 * stretching you SHIFT the channel, which moves its mean while leaving its
 * spread exactly alone. On a red channel crushed to ~10 grey levels that is
 * the difference between lifting the subject and detonating the sensor noise.
 *
 * Constants are the paper's: target mean 128, the "is this channel crushed"
 * probe is the fraction of pixels at or below 40, the protection threshold is
 * 0.7, and lambda is 0.4. (A widely circulated MATLAB reproduction uses 0.1
 * and a strict `<` at the mean; neither matches the paper.)
 */

const TARGET_MEAN = 128;
/** A pixel at or below this counts as "crushed". */
const DARK_LEVEL = 40;
/** Above this fraction of crushed pixels, protect the channel. */
const PROTECT_FRACTION = 0.7;
/** The paper's lambda, "to obtain colorful results". */
export const LAMBDA = 0.4;

export interface ChannelStats {
  mean: number;
  min: number;
  max: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Fraction of a channel's pixels at or below DARK_LEVEL — the "is this
 * channel destroyed?" probe from Eq. 2.
 */
export function darkFraction(values: Uint8ClampedArray | Float32Array, step = 1): number {
  let n = 0;
  let dark = 0;
  for (let i = 0; i < values.length; i += step) {
    n++;
    if (values[i] <= DARK_LEVEL) dark++;
  }
  return n ? dark / n : 0;
}

/** Mean / min / max over one channel, sampled every `step` pixels. */
export function channelStats(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  c: number,
  step = 1,
): ChannelStats {
  let sum = 0;
  let min = 255;
  let max = 0;
  let n = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4 + c;
      if (rgba[i + 3] === 0) continue;
      const v = rgba[i];
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
      n++;
    }
  }
  if (!n) return { mean: TARGET_MEAN, min: 0, max: 255 };
  return { mean: sum / n, min, max };
}

/**
 * Eq. 2 for a single channel value.
 *
 * `dark` is the crushed-pixel fraction: above PROTECT_FRACTION the channel is
 * shifted, otherwise it is stretched about its mean and re-anchored so the
 * mean lands on 128.
 */
export function toneAdjust(v: number, s: ChannelStats, dark: number, lambda = LAMBDA): number {
  if (dark > PROTECT_FRACTION) {
    return clamp(v - lambda * (s.mean - TARGET_MEAN), 0, 255);
  }
  if (s.mean <= TARGET_MEAN) {
    // Eq. 2: scale = (min - 128) / (min - mean). Written as (128 - min) the
    // sign flips: when mean < 128 both terms are negative and the ratio must
    // come out POSITIVE, otherwise the channel is inverted and the clamp hides
    // it as a crushed black.
    const span = s.min - s.mean;
    const scale = span === 0 ? 1 : (s.min - TARGET_MEAN) / span;
    return clamp((v - s.mean) * scale + TARGET_MEAN, 0, 255);
  }
  const span = s.max - s.mean;
  const scale = span === 0 ? 1 : (s.max - TARGET_MEAN) / span;
  return clamp((v - s.mean) * scale + TARGET_MEAN, 0, 255);
}

export interface MeanPullState {
  /** Per-channel dark fraction, the Eq. 2 branch selector. */
  dark: Vec3ish;
  /** Per-channel statistics, reused by the shader mirror. */
  stats: ChannelStats[];
  /** 0..1 blend between "do nothing" and "full Eq. 1/2". */
  amount: number;
}
type Vec3ish = [number, number, number];

/** Analyse a frame for Eq. 2. `step` trades accuracy for speed. */
export function analyzeMeanPull(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  step = 1,
): MeanPullState {
  const dark: Vec3ish = [0, 0, 0];
  const stats: ChannelStats[] = [];
  const one = new Float32Array(Math.ceil((w / step) * (h / step)));
  for (let c = 0; c < 3; c++) {
    let n = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4 + c;
        if (rgba[i + 3] === 0) continue;
        one[n++] = rgba[i];
      }
    }
    let d = 0;
    for (let i = 0; i < n; i++) if (one[i] <= DARK_LEVEL) d++;
    dark[c] = n ? d / n : 0;
    stats.push(channelStats(rgba, w, h, c, step));
  }
  return { dark, stats, amount: 1 };
}

/** The correction for one channel, in the same form the shader will apply. */
export function meanPull(v: number, s: ChannelStats, dark: number, amount = 1): number {
  const full = toneAdjust(v, s, dark, LAMBDA);
  return v + (full - v) * amount;
}

/**
 * Eq. 2 as the FINAL shader applies it (`meanPull` in shaders.ts), on 0..1
 * values. `s` = (mean, min, max, darkFraction) in 0..1 units.
 *
 * One deliberate deviation for video: the published method switches between
 * shifting and stretching at a dark fraction of exactly 0.7. A frame whose
 * channel hovers there would flip between the two every few frames, so the
 * two are blended over 0.6–0.8 instead. Away from that band the result is
 * the published one.
 */
export function meanPullGL(v: number, s: ArrayLike<number>, o: number, amount: number): number {
  const T = TARGET_MEAN / 255;
  const mean = s[o], mn = s[o + 1], mx = s[o + 2], dark = s[o + 3];
  const shifted = v - LAMBDA * (mean - T);
  const anchor = mean <= T ? mn : mx;
  const span = anchor - mean;
  const scale = Math.abs(span) < 1e-5 ? 1 : (anchor - T) / span;
  const stretched = (v - mean) * scale + T;
  const t = dark <= 0.6 ? 0 : dark >= 0.8 ? 1 : ((dark - 0.6) / 0.2) ** 2 * (3 - 2 * ((dark - 0.6) / 0.2));
  const full = clamp(stretched + (shifted - stretched) * t, 0, 1); // uint8 store, as published
  return v + (full - v) * amount;
}
