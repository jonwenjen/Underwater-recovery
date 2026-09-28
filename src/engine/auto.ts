/**
 * The auto engine.
 *
 * Each frame, the renderer hands over a ~256 px RGBA readback of the source.
 * This module runs a CPU *mirror* of the photometric half of the shader
 * pipeline on it, stage by stage, measuring what each stage needs from the
 * output of the previous one:
 *
 *   linearise → water-type & underwater score
 *   → Ancuti red/blue compensation         (needs channel means)
 *   → Bradford white balance               (needs illuminant estimate)
 *   → dark channel dehaze                  (needs water light A, haze map)
 *   → auto exposure                        (needs log-average luminance)
 *   → CLAHE                                (needs tile histograms)
 *   → levels / shadows / de-cast           (need output percentiles & means)
 *
 * Scalars are smoothed over time with an exponential moving average whose
 * time constant is the `response` slider, and snap instantly on a scene cut,
 * a seek, or a still image. Spatial maps (transmission, CLAHE tiles) are
 * recomputed every frame so they follow motion, with only light smoothing on
 * the CLAHE tiles to stop shimmer.
 */
import {
  boostChroma,
  fromOklab,
  LIN8,
  LUMA_B,
  LUMA_G,
  LUMA_R,
  clamp,
  encodeFast,
  luma,
  mix,
  shoulder,
  smoothstep,
  srgbToLinear,
  toOklab,
  whiteBalanceMatrix,
  type Mat3,
  type Vec3,
} from './color.ts';
import { boxMean, guidedCoefficients, minFilter, quantiles } from './filters.ts';
import { buildClahe, buildCurve, sampleClahe, sampleCurve } from './luts.ts';
import { detectBeams, detectSurface, estimateNoise, neutralLight, type BeamDetect } from './light.ts';
import { AUTO_KEYS, type AutoKey, type Params } from './params.ts';
import { analyzeColorMatrix } from './matrix.ts';
import { analyzeMeanPull, meanPull } from './twostep.ts';
import { JERLOV } from './physical.ts';

/**
 * Long edge of the analysis frame. Every map computed from it is low-frequency
 * and upsampled edge-aware on the GPU; 192 and 256 gave identical recovery
 * error on the ground-truth scenes, and 192 costs 44 % less.
 */
export const ANALYSIS_EDGE = 192;
/** Mean surface chroma (OKLab) that 豐富色彩 at full strength aims for; the
 * ground-truth reef scene measures 0.077, the flat default output 0.03–0.06. */
export const CHROMA_TARGET = 0.085;

/**
 * Every constant that maps a measurement to an auto value, in one place so
 * scripts/optimize.ts can search them against the ground-truth scene suite.
 * Values below are the optimizer's result (see README "How auto was tuned").
 */
export const TUNING = {
  redGain: 1.6, // Ancuti α for red at full underwater confidence
  blueGain: 1.15, // same for blue in green water
  wbGain: 0.98, // white-balance strength
  dehazeBase: 0.1, // dehaze on a non-underwater frame
  dehazeGain: 0.9, // extra dehaze at full underwater confidence (sum ≤ 1)
  depthGain: 0.7, // distance colour compensation per unit residual red deficit
  claheBase: 0,
  claheFlat: 0.22, // CLAHE on flat frames (dehaze already restores contrast)
  kLo: 0.24, // auto exposure lifts frames whose log-average is below this
  vibBase: 0,
  vibGain: 0.34,
  deCastGain: 0.88,
  vividAuto: 0.25, // automatic 豐富色彩 in full-auto mode
};
export const T0 = 0.3; // transmission floor: keeps far water from turning to noise
/**
 * Share of the dehazed *colour* kept; the rest of dehaze acts on luminance.
 * Tuned against ground-truth scenes (scripts/verify-scene.js): 0.3 gave the
 * lowest colour error with the highest contrast of {0, 0.3, 0.6}.
 */
export const DEHAZE_CHROMA = 0.3;

export interface FrameState {
  // compensation
  aR: number;
  aB: number;
  dR: number;
  dB: number;
  // dehaze
  A: Vec3;
  Aout: Vec3; // veil colour after clearing
  post: Vec3; // eyedropper residual gain
  k: Vec3; // per-channel gain slope vs. distance (1 - t)
  dehazeOn: boolean;
  coef: Float32Array; // RGBA per small pixel: meanA, meanB, 0, 0
  coefW: number;
  coefH: number;
  // white balance & exposure
  wb: Mat3;
  expMul: number;
  // CLAHE
  clahe: Float32Array | null;
  claheTiles: number;
  claheMix: number;
  claheK: number;
  // tone & colour
  curve: Float32Array;
  gain: Vec3;
  deCast: number;
  vibrance: number;
  saturation: number;
  chromaGain: number; // 豐富色彩: hue-preserving OKLab chroma gain (1 = off)
  warmGain: number; // extra gain for reds → yellows
  // detail
  sharpen: number;
  restore: number; // 畫質修復 pre-pass strength
  shoulder: number; // highlight roll-off amount
  sharpenRadius: number;
  threshold: number;
  denoise: number;
  clarity: number;
  beams: { x: number; y: number; amount: number; length: number; warm: number; thr: number };
  surface: { ax: number; ay: number; bx: number; by: number; hl: number; tone: number; warm: number };
  /** 光線去洋紅: highlights above `thr` (output luma) lose magenta by `amount`. */
  neutral: { thr: number; amount: number };
  /** 全自動-bornfree / 全自動-nikolajbech: the 3x3 sRGB matrix and offset. */
  mixMat: Mat3;
  mixOff: Vec3;
  mixAmt: number;
  /** 全自動-T77701: per channel (mean, min, max, darkFraction), 0..1 units. */
  pull: Float32Array;
  pullAmt: number;
  /** 全自動-warplab: per-channel attenuation (1/m) and the backscatter scale. */
  physA: Vec3;
  physBack: number;
  physAmt: number;
  /** Values actually applied for every auto key (for the UI). */
  effective: Record<AutoKey, number>;
  stats: FrameStats;
}

export interface FrameStats {
  underwater: number;
  water: 'blue' | 'green' | 'neutral';
  haze: number;
  illum: Vec3;
  waterLight: Vec3;
  sceneCut: boolean;
  analysisMs: number;
  /** Mean OKLab chroma of surfaces before the colour stage. */
  chroma: number;
  /** 0..1 detection confidence for sun beams / a bright surface band. */
  beamPresence: number;
  surfacePresence: number;
  /** Grain σ in 8-bit steps at processing scale (0 when not probed). */
  noise: number;
}

/** Eyedropper state: the illuminant it implies, and a residual gain fixed on first use. */
export interface Pick {
  illum: Vec3;
  uv: [number, number];
  post: Vec3 | null;
}


/**
 * Colour cast of an RGB buffer, on the same scale the bench uses:
 * positive is blue, negative is warm. This is the quantity the four imported
 * methods have to stop being allowed to dominate.
 */
function castOf(rgb: Float32Array, n: number): number {
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < n; i++) { r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2]; }
  return b / n - (r / n + g / n) / 2;
}

/** Upper bound on how far an imported method may move the colour cast. */
export const MAX_CAST_DRIFT = 1.5;

export interface StepOptions {
  params: Params;
  locked: ReadonlySet<AutoKey>;
  /** Seconds since the previous frame; ≤ 0 means "still image": snap. */
  dt: number;
  /** Force a snap (seek, new file). */
  snap?: boolean;
  /** Processing-scale crop for the grain estimate (see Renderer.readNoise). */
  noise?: { rgba: Uint8Array | Uint8ClampedArray; w: number; h: number };
}

export class AutoEngine {
  private smoothed = new Map<string, number>();
  private sig: Float32Array | null = null;
  private lastLut: Float32Array | null = null;
  private lastTiles = 0;
  private lastComp: Float32Array | null = null;
  private lastW = 0;
  private lastH = 0;
  /** Eyedropper: set by `pickAt`, copied to export engines. */
  pick: Pick | null = null;
  private pool = new Map<string, Float32Array>();
  private bins = new Uint16Array(0);
  private frameNo = 0;
  private beamCache: BeamDetect | null = null;
  /** Per-frame scratch buffers, reused across frames to keep GC out of playback. */
  private buf(name: string, len: number): Float32Array {
    let b = this.pool.get(name);
    if (!b || b.length !== len) {
      b = new Float32Array(len);
      this.pool.set(name, b);
    }
    return b;
  }

  reset() {
    this.beamCache = null;
    this.smoothed.clear();
    this.sig = null;
    this.lastLut = null;
  }

  /** Eyedropper: sample the compensated (pre-WB) frame at uv and use it as the illuminant. */
  pickAt(u: number, v: number): Vec3 | null {
    const J = this.lastComp;
    if (!J) return null;
    const w = this.lastW,
      h = this.lastH;
    const cx = clamp(Math.floor(u * w), 0, w - 1),
      cy = clamp(Math.floor(v * h), 0, h - 1);
    let r = 0,
      g = 0,
      b = 0,
      c = 0;
    for (let y = Math.max(0, cy - 1); y <= Math.min(h - 1, cy + 1); y++)
      for (let x = Math.max(0, cx - 1); x <= Math.min(w - 1, cx + 1); x++) {
        const i = (y * w + x) * 3;
        r += J[i];
        g += J[i + 1];
        b += J[i + 2];
        c++;
      }
    const y = Math.max(1e-4, luma(r / c, g / c, b / c));
    this.pick = { illum: [r / c / y, g / c / y, b / c / y], uv: [u, v], post: null };
    return this.pick.illum;
  }

  step(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, o: StepOptions): FrameState {
    const t0 = performance.now();
    const p = o.params;
    const n = w * h;
    const cut = this.detectCut(rgba, n);
    const snap = !!o.snap || o.dt <= 0 || cut || this.smoothed.size === 0;
    const tau = Math.max(0.05, p.response);
    const rate = snap ? 1 : 1 - Math.exp(-o.dt / tau);
    const S = (key: string, target: number, r = rate) => {
      const prev = this.smoothed.get(key);
      const v = prev === undefined || snap ? target : prev + (target - prev) * r;
      this.smoothed.set(key, v);
      return v;
    };
    const eff: Partial<Record<AutoKey, number>> = {};
    const E = (k: AutoKey, autoTarget: number) => {
      const a = S(k, autoTarget);
      const v = !p.auto || o.locked.has(k) ? p[k] : a;
      eff[k] = v;
      return v;
    };

    /* 1. linearise + scene statistics ------------------------------- */
    const lin = this.buf('lin', n * 3);
    let s8r = 0, s8g = 0, s8b = 0, sl = 0, sl2 = 0;
    let lr = 0, lg = 0, lb = 0;
    for (let i = 0, q = 0; i < n; i++, q += 3) {
      const r8 = rgba[i * 4], g8 = rgba[i * 4 + 1], b8 = rgba[i * 4 + 2];
      s8r += r8; s8g += g8; s8b += b8;
      const l8 = LUMA_R * r8 + LUMA_G * g8 + LUMA_B * b8;
      sl += l8; sl2 += l8 * l8;
      const r = LIN8[r8], g = LIN8[g8], b = LIN8[b8];
      lin[q] = r; lin[q + 1] = g; lin[q + 2] = b;
      lr += r; lg += g; lb += b;
    }
    const mr8 = s8r / n, mg8 = s8g / n, mb8 = s8b / n;
    const mR = lr / n, mG = lg / n, mB = lb / n;
    const ml = sl / n;
    const contrast = Math.sqrt(Math.max(0, sl2 / n - ml * ml)) / 255;

    // Underwater score: blue-or-green cast, weak red, flat contrast.
    const blueDom = mb8 - (mr8 + mg8) / 2;
    const greenDom = mg8 - (mr8 + mb8) / 2;
    const castScore = clamp(Math.max(blueDom, greenDom * 0.9) / 40, 0, 1);
    const redLoss = clamp((Math.max(mg8, mb8) - mr8) / 60, 0, 1);
    const flat = clamp((0.3 - contrast) / 0.25, 0, 1);
    const uw = S('uw', clamp(castScore * 0.45 + redLoss * 0.35 + flat * 0.2, 0, 1));
    // How much to trust the scene is underwater at all: a clean land photo
    // (score < 0.2) gets almost nothing, a clear underwater frame gets it all.
    const gate = smoothstep(0.2, 0.55, uw);
    // 豐富色彩 strength: every adaptive amount below scales with it
    const vivid = clamp(E('vivid', TUNING.vividAuto * gate), 0, 1);
    const gateWb = smoothstep(0.15, 0.45, uw);
    const water: FrameStats['water'] = uw < 0.3 ? 'neutral' : mG > mB * 1.08 ? 'green' : 'blue';

    /* 2. Ancuti compensation ----------------------------------------- */
    const defR = clamp((mG - mR) / Math.max(1e-4, mG), 0, 1);
    const defB = clamp((mG - mB) / Math.max(1e-4, mG), 0, 1);
    const dR = S('dR', Math.max(0, mG - mR));
    const dB = S('dB', Math.max(0, mG - mB));
    const aR = E('redComp', defR > 0.04 ? TUNING.redGain * gate : 0);
    const aB = E('blueComp', clamp(defB / 0.25, 0, 1) * TUNING.blueGain * gate);
    const comp = this.buf('comp', n * 3);
    let cr = 0, cg = 0;
    for (let q = 0; q < n * 3; q += 3) {
      const r = lin[q], g = lin[q + 1], b = lin[q + 2];
      const r2 = Math.min(1, r + aR * dR * (1 - r) * g);
      const b2 = Math.min(1, b + aB * dB * (1 - b) * g);
      comp[q] = r2; comp[q + 1] = g; comp[q + 2] = b2;
      cr += r2; cg += g;
    }

    /* 3. white balance (grey world on the compensated frame) -------- */
    // Balanced *before* dehazing (Ancuti's order): the veil then reads as a
    // near-neutral grey, so the dark channel measures haze instead of the
    // missing red, and dehaze cannot skew the illuminant estimate. Grey
    // world, not a higher Minkowski norm: bright subjects (coral, strobe
    // highlights) otherwise dominate the estimate and leave the water cast.
    let pr = 0, pg = 0, pb = 0, pc = 0;
    for (let q = 0; q < n * 3; q += 3) {
      const r = comp[q], g = comp[q + 1], b = comp[q + 2];
      if (Math.max(r, g, b) > 0.97 || luma(r, g, b) < 0.004) continue;
      pr += r; pg += g; pb += b; pc++;
    }
    let ill: Vec3 = pc > 0 ? [pr / pc, pg / pc, pb / pc] : [1, 1, 1];
    if (this.pick) ill = this.pick.illum;
    const iy = Math.max(1e-4, luma(ill[0], ill[1], ill[2]));
    const illum: Vec3 = [S('Ir', ill[0] / iy), S('Ig', ill[1] / iy), S('Ib', ill[2] / iy)];
    const wbS = E('wbStrength', this.pick ? 1 : TUNING.wbGain * gateWb);
    const wb = whiteBalanceMatrix(
      [mix(1, illum[0], wbS), mix(1, illum[1], wbS), mix(1, illum[2], wbS)],
      p.temp,
      p.tint,
    );
    this.lastComp = comp;
    this.lastW = w;
    this.lastH = h;
    const bal = this.buf('bal', n * 3);
    for (let q = 0; q < n * 3; q += 3) {
      const r = comp[q], g = comp[q + 1], b = comp[q + 2];
      bal[q] = Math.max(0, wb[0] * r + wb[1] * g + wb[2] * b);
      bal[q + 1] = Math.max(0, wb[3] * r + wb[4] * g + wb[5] * b);
      bal[q + 2] = Math.max(0, wb[6] * r + wb[7] * g + wb[8] * b);
    }

    /* 4. haze-lines dehaze ------------------------------------------ */
    // Water light: the smoothest region that the Red Channel Prior (Galdran
    // et al.: min(1 - R, G, B)) calls hazy. The texture term matters: sunlit
    // sand is often *brighter* than open water, so brightness-only estimates
    // (dark channel, plain RCP) pick the seabed and then crush the water.
    const rs = Math.max(1, Math.round(Math.max(w, h) / 110));
    const dmin = this.buf('dmin', n);
    const Ls = this.buf('Ls', n);
    const Ls2 = this.buf('Ls2', n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      dmin[i] = Math.min(1 - rgba[j] / 255, rgba[j + 1] / 255, rgba[j + 2] / 255);
      const l = luma(rgba[j], rgba[j + 1], rgba[j + 2]) / 255;
      Ls[i] = l;
      Ls2[i] = l * l;
    }
    const prior = minFilter(dmin, w, h, rs);
    const mLs = boxMean(Ls, w, h, 3);
    const mLs2 = boxMean(Ls2, w, h, 3);
    // Candidates: smooth (local σ < 1.5 %) and in the hazier 30 % by the
    // prior. The water body is the *dominant* such colour by area; a white
    // slate or tank is smooth and hazy-looking too, but small.
    const [p70] = quantiles(prior, [0.7], 512);
    const votes = new Uint32Array(512);
    let nc = 0;
    for (let i = 0; i < n; i++) {
      const sd = Math.sqrt(Math.max(0, mLs2[i] - mLs[i] * mLs[i]));
      dmin[i] = prior[i] - 4 * sd; // fallback score
      if (sd < 0.015 && prior[i] >= p70) {
        const j = i * 4;
        votes[((rgba[j] >> 5) << 6) | ((rgba[j + 1] >> 5) << 3) | (rgba[j + 2] >> 5)]++;
        nc++;
      }
    }
    let best = -1;
    if (nc >= 0.01 * n) {
      let bv = 0;
      for (let b = 0; b < 512; b++) if (votes[b] > bv) { bv = votes[b]; best = b; }
    }
    const [cutoff] = best < 0 ? quantiles(dmin, [0.995], 512) : [0];
    let ar = 0, ag = 0, ab = 0, ac = 0, rr = 0, rg = 0, rb = 0;
    for (let i = 0, q = 0; i < n; i++, q += 3) {
      const j = i * 4;
      const take = best >= 0
        ? (((rgba[j] >> 5) << 6) | ((rgba[j + 1] >> 5) << 3) | (rgba[j + 2] >> 5)) === best
        : dmin[i] >= cutoff - 1 / 512;
      if (take) {
        ar += bal[q]; ag += bal[q + 1]; ab += bal[q + 2]; ac++;
        rr += comp[q]; rg += comp[q + 1]; rb += comp[q + 2];
      }
    }
    ac = Math.max(1, ac);
    const A: Vec3 = [
      S('Ar', clamp(ar / ac, 0.01, 1)),
      S('Ag', clamp(ag / ac, 0.01, 1)),
      S('Ab', clamp(ab / ac, 0.01, 1)),
    ];
    // What the cleared water should look like: the measured water light at
    // the same brightness, with `waterTint` of its original hue kept. 0 gives
    // a neutral grey veil (flat, lifeless), 1 keeps the full cast.
    const ry = Math.max(1e-4, luma(rr, rg, rb)),
      ay = luma(A[0], A[1], A[2]);
    const keep = mix(clamp(p.waterTint, 0, 1), Math.max(p.waterTint, 0.8), 0.6 * vivid);
    const hue: Vec3 = [mix(1, rr / ry, keep), mix(1, rg / ry, keep), mix(1, rb / ry, keep)];
    const hy = Math.max(1e-4, luma(hue[0], hue[1], hue[2]));
    const Aout: Vec3 = [
      S('Aor', (ay * hue[0]) / hy),
      S('Aog', (ay * hue[1]) / hy),
      S('Aob', (ay * hue[2]) / hy),
    ];
    // Haze-lines (Berman et al., CVPR 2016 / BMVC 2017): I - A = t·(J - A),
    // so along each colour direction from A, the pixel farthest from A is
    // (nearly) haze-free and t = |I - A| / max|I - A| on that line. Directions
    // are binned on a cube map (6 faces × 6 × 6); `darkN` stores 1 - t.
    const NB = 6;
    const rmax = new Float32Array(6 * NB * NB);
    const bin = this.bins.length === n ? this.bins : (this.bins = new Uint16Array(n));
    const rad = this.buf('rad', n);
    for (let i = 0, q = 0; i < n; i++, q += 3) {
      const x = bal[q] - A[0], y = bal[q + 1] - A[1], z = bal[q + 2] - A[2];
      const ax = Math.abs(x), ay2 = Math.abs(y), az = Math.abs(z);
      let face: number, u: number, v: number, m: number;
      if (ax >= ay2 && ax >= az) { face = x > 0 ? 0 : 1; m = ax; u = y; v = z; }
      else if (ay2 >= az) { face = y > 0 ? 2 : 3; m = ay2; u = x; v = z; }
      else { face = z > 0 ? 4 : 5; m = az; u = x; v = y; }
      m = Math.max(m, 1e-6);
      const bu = Math.min(NB - 1, Math.floor(((u / m + 1) / 2) * NB));
      const bv = Math.min(NB - 1, Math.floor(((v / m + 1) / 2) * NB));
      const b = (face * NB + bu) * NB + bv;
      bin[i] = b;
      const r = Math.sqrt(x * x + y * y + z * z);
      rad[i] = r;
      if (r > rmax[b]) rmax[b] = r;
    }
    const [rGlobal] = quantiles(rad, [0.99], 1024);
    const darkN = this.buf('darkN', n);
    for (let i = 0; i < n; i++) {
      // a sparse direction with a short max radius would call everything on it
      // haze-free; never trust a line shorter than half the global radius
      const rm = Math.max(rmax[bin[i]], 0.5 * rGlobal, 1e-3);
      darkN[i] = 1 - clamp(rad[i] / rm, 0, 1);
    }
    const [d10, d50, d90] = quantiles(darkN, [0.1, 0.5, 0.9], 512);
    // Only dehaze when there is a *spread* between near and far: a flat frame
    // (all dark ≈ A) has no depth cue and would collapse toward A.
    const hazeAct = S('hazeAct', smoothstep(0.06, 0.3, d90 - d10));
    const omega = E('dehaze', TUNING.dehazeBase + TUNING.dehazeGain * gate) * hazeAct;
    const dehazeOn = omega > 0.005;
    const I = this.buf('I', n);
    const tRaw = this.buf('tRaw', n);
    for (let i = 0, q = 0; i < n; i++, q += 3) {
      I[i] = Math.sqrt(luma(bal[q], bal[q + 1], bal[q + 2]));
      tRaw[i] = clamp(1 - omega * darkN[i], 0, 1);
    }
    const gr = Math.max(2, Math.round(Math.max(w, h) / 48));
    const { a: ca, b: cb } = guidedCoefficients(I, tRaw, w, h, gr, 1e-3);
    const coef = this.buf('coef', n * 4);
    for (let i = 0; i < n; i++) {
      coef[i * 4] = dehazeOn ? ca[i] : 0;
      coef[i * 4 + 1] = dehazeOn ? cb[i] : 1;
    }
    const resDef = clamp((cg - cr) / Math.max(1e-4, cg), 0, 1);
    const depth = E('depthColor', clamp(resDef * TUNING.depthGain, 0, 0.6) * gate);
    // Distance-weighted colour gain: light from far objects (low t) lost the
    // most red on the way, so red is lifted in proportion to (1 - t).
    const k: Vec3 = [1.6 * depth, 0, -0.35 * depth];

    /* 5. exposure --------------------------------------------------- */
    const Wb = bal; // dehazed in place
    const tMap = this.buf('tMap', n);
    let logSum = 0;
    for (let i = 0, q = 0; i < n; i++, q += 3) {
      if (dehazeOn) {
        const t = clamp(coef[i * 4] * I[i] + coef[i * 4 + 1], 0, 1);
        tMap[i] = t;
        // J = (I - A)/t · (1 + k·(1-t)) + A, with the remaining veil re-tinted
        // toward A_out in proportion to how much veil the pixel holds. Where t reaches
        // its floor there is no surface, only water: dividing by t there just
        // amplifies the water gradient into noise and clips, so blend to an
        // unamplified re-tint (the classic "DCP fails on sky" fix).
        const m = 1 - smoothstep(T0, T0 + 0.25, t);
        const div = mix(Math.max(t, T0), 1, m),
          far = (1 - t) * (1 - m),
          veil = clamp((1 - t) / (1 - T0), 0, 1); // how much of A is in this pixel
        const w0 = Wb[q], w1 = Wb[q + 1], w2 = Wb[q + 2];
        const j0 = Math.max(0, ((w0 - A[0]) / div) * (1 + k[0] * far) + A[0] + (Aout[0] - A[0]) * veil);
        const j1 = Math.max(0, ((w1 - A[1]) / div) * (1 + k[1] * far) + A[1] + (Aout[1] - A[1]) * veil);
        const j2 = Math.max(0, ((w2 - A[2]) / div) * (1 + k[2] * far) + A[2] + (Aout[2] - A[2]) * veil);
        // A single t cannot undo wavelength-dependent loss, so full-colour
        // dehaze shifts hues. Take its luminance (clarity) and mostly keep the
        // balanced chroma; `DEHAZE_CHROMA` of the dehazed colour mixes back in.
        const yr = (luma(j0, j1, j2) + 1e-4) / (luma(w0, w1, w2) + 1e-4);
        Wb[q] = mix(w0 * yr, j0, DEHAZE_CHROMA);
        Wb[q + 1] = mix(w1 * yr, j1, DEHAZE_CHROMA);
        Wb[q + 2] = mix(w2 * yr, j2, DEHAZE_CHROMA);
      } else tMap[i] = 1;
      if ((i & 3) === 0) logSum += Math.log(luma(Wb[q], Wb[q + 1], Wb[q + 2]) + 1e-4);
    }
    // Eyedropper: after the stages above, make the picked patch exactly
    // neutral with a luminance-preserving gain, measured once and then held
    // (so in video it does not chase whatever passes under that point).
    let post: Vec3 = [1, 1, 1];
    if (this.pick) {
      if (!this.pick.post) {
        const cx = clamp(Math.floor(this.pick.uv[0] * w), 0, w - 1),
          cy = clamp(Math.floor(this.pick.uv[1] * h), 0, h - 1);
        let pr2 = 0, pg2 = 0, pb2 = 0, pc2 = 0;
        for (let y = Math.max(0, cy - 1); y <= Math.min(h - 1, cy + 1); y++)
          for (let x = Math.max(0, cx - 1); x <= Math.min(w - 1, cx + 1); x++) {
            const q = (y * w + x) * 3;
            pr2 += Wb[q]; pg2 += Wb[q + 1]; pb2 += Wb[q + 2]; pc2++;
          }
        const py = luma(pr2, pg2, pb2);
        this.pick.post = [
          clamp(py / Math.max(1e-5, pr2), 0.5, 2),
          clamp(py / Math.max(1e-5, pg2), 0.5, 2),
          clamp(py / Math.max(1e-5, pb2), 0.5, 2),
        ];
      }
      post = this.pick.post;
      for (let q = 0; q < n * 3; q += 3) {
        Wb[q] *= post[0]; Wb[q + 1] *= post[1]; Wb[q + 2] *= post[2];
      }
    }
    const key = Math.exp(logSum / Math.ceil(n / 4));
    // Dead zone: lift dim frames, tame hot ones, leave a good exposure alone.
    const kk = Math.max(1e-4, key);
    const kLo = TUNING.kLo + 0.08 * vivid; // rich colour also means a more luminous frame
    const evTarget = kk < kLo ? Math.log2(kLo / kk) * 0.7 : kk > 0.32 ? Math.log2(0.32 / kk) * 0.7 : 0;
    const ev = E('exposure', clamp(evTarget, -1, 1.5));
    const expMul = Math.pow(2, ev);
    // Highlight roll-off only when something can push values past 1: an
    // exposure lift, dehaze, WB or compensation. With all of them off
    // (「原始」) the pipeline is an exact identity.
    const sh = clamp(Math.max((expMul - 1) * 4, dehazeOn ? 1 : 0, wbS * 4, (aR + aB) * 4), 0, 1);
    const shl = (x: number) => x + (shoulder(x) - x) * sh;

    /* 6. encode + CLAHE --------------------------------------------- */
    const e = this.buf('e', n * 3);
    const L = this.buf('L', n);
    let sL = 0, sL2 = 0;
    for (let i = 0, q = 0; i < n; i++, q += 3) {
      const r = encodeFast(shl(Wb[q] * expMul));
      const g = encodeFast(shl(Wb[q + 1] * expMul));
      const b = encodeFast(shl(Wb[q + 2] * expMul));
      e[q] = r; e[q + 1] = g; e[q + 2] = b;
      const l = luma(r, g, b);
      L[i] = l; sL += l; sL2 += l * l;
    }
    const mL = sL / n;
    const stdL = Math.sqrt(Math.max(0, sL2 / n - mL * mL));
    const flat2 = clamp((0.24 - stdL) / 0.16, 0, 1);
    // Dehaze already restores most of the lost contrast; CLAHE only tops up
    // what is still flat, less so the more dehaze did.
    const claheS = E('clahe', clamp((TUNING.claheBase + TUNING.claheFlat * flat2) * (1 - 0.4 * omega), 0, 0.35));
    const tiles = clamp(Math.round(p.claheTiles), 2, 16);
    let clahe: Float32Array | null = null;
    const claheMix = claheS > 0.001 ? Math.min(1, 2 * claheS) : 0;
    let claheK = 1;
    if (claheMix > 0) {
      clahe = buildClahe(L, w, h, tiles, 1.2 + 2 * claheS);
      if (!snap && this.lastLut && this.lastTiles === tiles && this.lastLut.length === clahe.length) {
        const rl = 1 - Math.exp(-o.dt / Math.min(0.3, tau));
        const prev = this.lastLut;
        for (let i = 0; i < clahe.length; i++) clahe[i] = prev[i] + (clahe[i] - prev[i]) * rl;
      }
      this.lastLut = clahe;
      this.lastTiles = tiles;
      let sm = 0;
      const mapped = this.buf('mapped', n);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          mapped[i] = sampleClahe(clahe, tiles, L[i], (x + 0.5) / w, (y + 0.5) / h);
          sm += mapped[i];
        }
      claheK = S('claheK', sm > 1e-6 ? clamp(sL / sm, 0.8, 1.25) : 1);
      for (let i = 0, q = 0; i < n; i++, q += 3) {
        const L2 = mix(L[i], mapped[i] * claheK, claheMix);
        const s = (L2 + 1e-4) / (L[i] + 1e-4);
        e[q] *= s; e[q + 1] *= s; e[q + 2] *= s;
        L[i] = L2;
      }
    }

    /* 7. levels, shadows, de-cast ----------------------------------- */
    const [pLo, pMed, pHi] = quantiles(L, [0.003, 0.5, 0.997], 1024);
    const blacks = E('blacks', clamp(pLo * 0.85, 0, 0.1));
    const whites = E('whites', clamp(pHi + 0.005, 0.88, 1));
    const shadows = E('shadows', clamp((0.4 - pMed) * 1.2, 0, 0.35));
    let wr = 0, wg = 0, wbb = 0, ws = 0;
    for (let i = 0, q = 0; i < n; i++, q += 3) {
      const l = L[i];
      // measured on near surfaces only: open water keeps its (chosen) tint
      const wgt =
        (l < 0.3 ? (l / 0.3) ** 1.5 : l > 0.8 ? 0.5 + 0.5 * Math.max(0, 1 - (l - 0.8) / 0.2) : 1) *
        smoothstep(0.3, 0.75, tMap[i]);
      wr += e[q] * wgt; wg += e[q + 1] * wgt; wbb += e[q + 2] * wgt; ws += wgt;
    }
    const gm = ws > 0 ? [wr / ws, wg / ws, wbb / ws] : [1, 1, 1];
    const gAvg = (gm[0] + gm[1] + gm[2]) / 3;
    const gain: Vec3 = [
      S('gR', clamp(gAvg / Math.max(1e-4, gm[0]), 0.85, 1.2)),
      S('gG', clamp(gAvg / Math.max(1e-4, gm[1]), 0.85, 1.2)),
      S('gB', clamp(gAvg / Math.max(1e-4, gm[2]), 0.85, 1.2)),
    ];
    // de-cast pulls toward grey; ease it off when rich colour is wanted
    const deCast = this.pick ? 0 : E('deCast', S('deCastSafe', TUNING.deCastGain * gate * (1 - 0.5 * vivid) * this.deCastGuard(e, L, tMap, gain)));
    // Measure how colourful the surfaces actually are (mean OKLab chroma,
    // near surfaces, every 4th pixel) and derive the gain that brings them
    // toward a vivid target. Measured, so a frame that is already colourful
    // gets little and a flat one gets a lot. Skipped entirely when off.
    let cSum = 0, cW = 0;
    for (let i = 0, q = 0; vivid > 0 && i < n; i += 4, q += 12) {
      const wgt = smoothstep(0.3, 0.75, tMap[i]) * smoothstep(0.05, 0.2, L[i]);
      if (wgt <= 0) continue;
      const lab = toOklab(srgbToLinear(clamp(e[q], 0, 1)), srgbToLinear(clamp(e[q + 1], 0, 1)), srgbToLinear(clamp(e[q + 2], 0, 1)));
      cSum += Math.hypot(lab[1], lab[2]) * wgt;
      cW += wgt;
    }
    const chroma = cW > 0 ? cSum / cW : 0;
    const chromaGain = S('cGain', 1 + vivid * (clamp(CHROMA_TARGET / Math.max(chroma, 0.01), 1, 2.6) - 1));
    const warmGain = S('warmG', 0.45 * vivid);
    const vibrance = E('vibrance', TUNING.vibBase + TUNING.vibGain * gate);
    const curve = buildCurve({
      blacks,
      whites,
      contrast: clamp(p.contrast + 0.08 * vivid, -1, 1),
      highlights: p.highlights,
      shadows,
    });

    /* 8. light: beams + surface highlights ---------------------------- */
    // streaks are measured on the *source* luminance: correction amplifies
    // grain in open water far more than it amplifies the beams
    // Beam geometry changes slowly: in video, re-detect every 3rd frame (and
    // on every snap); stills always detect.
    this.frameNo++;
    if (snap || !this.beamCache || this.frameNo % 3 === 0) {
      const Lraw = this.buf('Lraw', n);
      for (let i = 0, j = 0; i < n; i++, j += 4) Lraw[i] = luma(rgba[j], rgba[j + 1], rgba[j + 2]) / 255;
      this.beamCache = detectBeams(Lraw, w, h);
    }
    const bd = this.beamCache;
    const sd = detectSurface(L, e, w, h);
    const beamX = E('beamX', bd.x);
    const beamY = E('beamY', bd.y);
    // natural by default: only a gentle lift where beams are clearly there
    const beams = E('beams', 0.2 * bd.presence * gate);
    const beamThr = S('beamThr', bd.thr);
    const surfaceHL = E('surfaceHL', clamp(sd.presence * (0.25 + 4 * sd.clip + 0.6 * Math.max(0, sd.top - 0.7)), 0, 0.9));
    const surfAx = E('surfAx', sd.ax);
    const surfAy = E('surfAy', sd.ay);
    const surfBx = E('surfBx', sd.bx);
    const surfBy = E('surfBy', sd.by);
    // where there is sunlight in the frame, its bright part (upper 15 % of the
    // upper frame, where beams and the surface are; through the tone curve)
    // must not render pink
    const [lTop] = quantiles(L.subarray(0, w * Math.max(1, Math.floor(h * 0.7))), [0.85], 512);
    const neutralThr = S('nThr', sampleCurve(curve, clamp(lTop, 0, 1)));
    const neutralAmt = E('lightNeutral', 0.85 * Math.max(bd.presence, sd.presence) * gate);

    /* 9. grain → 畫質修復, 降噪, 銳化門檻, 銳化 ------------------------ */
    const sigma = S('noise', o.noise ? estimateNoise(o.noise.rgba, o.noise.w, o.noise.h) : 1);
    const restore = E('restore', 0.85 * smoothstep(2.5, 9, sigma));
    const denoise = E('denoise', 0.15 + 0.5 * smoothstep(1.5, 7, sigma));
    const threshold = E('threshold', clamp(0.012 + (2.2 * sigma) / 255, 0.015, 0.08));
    const sharpen = E('sharpen', 0.35 * (1 - 0.7 * smoothstep(3, 10, sigma)));

    // Borrowed-method profiles. Skipped entirely unless a preset turned one
    // on, so the default pipeline costs nothing extra.
    let mixMat: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    let mixOff: Vec3 = [0, 0, 0];
    let mixAmt = 0;
    let pullAmt = 0;
    let pull: Float32Array = new Float32Array(12);
    let physA: Vec3 = [0, 0, 0];
    let physBack = 0;
    let physMix = 0;
    // Imported profiles are bounded by the colour they are allowed to move.
    //
    // Measured on UIEB with ground-truth references, the four methods at full
    // strength land 27-40 units of cast away from the engine's own auto
    // result, and are 2.5-3x worse against truth. Re-enabling the engine's
    // own redComp alongside them changed nothing (36.9 -> 37.1), so this is
    // not double-counting: the methods simply pull somewhere the engine's
    // measured pipeline does not. So rather than trust them with the colour
    // balance, each one is scaled back until the cast it induces fits inside
    // MAX_CAST_DRIFT. They keep their tonal and structural work and lose
    // their ability to hijack the white balance.
    if (p.matrixMix > 0.0001 || p.meanPull > 0.0001 || p.physicalMix > 0.0001) {
      const n = Math.max(1, w * h);
      // 0..255 throughout: the matrix offset is scaled by 255 at apply time,
      // so measuring in normalised units saturates every pixel to white and
      // the cast reads a flat zero.
      const src = new Float32Array(n * 3);
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        src[j] = rgba[j]; src[j + 1] = rgba[j + 1]; src[j + 2] = rgba[j + 2];
      }
      // Measure in the domain the method actually runs in. The method is
      // applied to the engine's GRADED output, which has already had the water
      // cast removed. Measuring against the raw frame under-reports the shift
      // by roughly an order of magnitude, because on a still-blue frame the
      // matrix's red lift and blue subtraction largely cancel in the cast
      // metric — and it is the de-blued frame that goes warm. Grey-world
      // normalising the buffer puts the measurement in that domain.
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += src[i * 3 + c];
        const m = sum / n;
        if (m > 1e-4) for (let i = 0; i < n; i++) src[i * 3 + c] = Math.min(255, src[i * 3 + c] * (127.5 / m));
      }
      const before = castOf(src, n);
      const trial = Float32Array.from(src);
      if (p.matrixMix > 0.0001) {
        const cm = analyzeColorMatrix(rgba as Uint8ClampedArray, w, h, {
          analysis: p.matrixGrid >= 0.5 ? 'fixed256' : 'full',
          hueLimit: p.matrixHue,
        });
        mixMat = cm.m;
        mixOff = cm.off;
        for (let i = 0; i < n; i++) {
          const r = src[i * 3], g = src[i * 3 + 1], b = src[i * 3 + 2];
          const m = cm.m;
          trial[i * 3] = clamp(m[0] * r + m[1] * g + m[2] * b + cm.off[0] * 255, 0, 255);
          trial[i * 3 + 1] = clamp(m[3] * r + m[4] * g + m[5] * b + cm.off[1] * 255, 0, 255);
          trial[i * 3 + 2] = clamp(m[6] * r + m[7] * g + m[8] * b + cm.off[2] * 255, 0, 255);
        }
      }
      if (p.meanPull > 0.0001) {
        const mp = analyzeMeanPull(rgba as Uint8ClampedArray, w, h);
        for (let c = 0; c < 3; c++) {
          pull[c * 4] = mp.stats[c].mean / 255;
          pull[c * 4 + 1] = mp.stats[c].min / 255;
          pull[c * 4 + 2] = mp.stats[c].max / 255;
          pull[c * 4 + 3] = mp.dark[c];
        }
        for (let i = 0; i < n; i++) {
          for (let c = 0; c < 3; c++) {
            const st = { mean: pull[c * 4] * 255, min: pull[c * 4 + 1] * 255, max: pull[c * 4 + 2] * 255 };
            trial[i * 3 + c] = meanPull(trial[i * 3 + c], st, pull[c * 4 + 3], 1);
          }
        }
      }
      if (p.physicalMix > 0.0001) {
        let mr = 0, mg = 0, mn2 = 0;
        for (let i = 0; i < n; i++) { mr += src[i * 3]; mg += src[i * 3 + 1]; mn2++; }
        const starvation = mn2 ? clamp(1 - mr / Math.max(1, mg), 0, 1) : 0;
        const wt = water === 'green' ? JERLOV.green : water === 'blue' ? JERLOV.blue : JERLOV.coastal;
        const haz = clamp(hazeAct, 0, 1);
        const depth = 12 * haz * clamp(p.physicalDepth, 0, 1) * starvation;
        physA = [Math.max(0, wt.ar - wt.ag) * depth, 0, 0];
        physBack = 0.08 * haz;
        physMix = p.physicalMix * smoothstep(0.12, 0.55, starvation);
        if (physMix > 0.0001) {
          for (let i = 0; i < n; i++) {
            const gain = clamp(Math.exp(physA[0]), 1, 3);
            const bsub = Math.min(physBack * wt.beta * (1 - Math.exp(-wt.ar * depth)), trial[i * 3] * 0.5);
            trial[i * 3] = Math.max(0, trial[i * 3] - bsub) * gain;
          }
        }
      }
      // Scale the whole profile back until its cast shift fits the budget.
      const shift = Math.abs(castOf(trial, n) - before);
      const k = shift > MAX_CAST_DRIFT ? MAX_CAST_DRIFT / shift : 1;
      mixAmt = p.matrixMix * k;
      pullAmt = p.meanPull * k;
      physMix *= k;
    }

    for (const k2 of AUTO_KEYS) if (eff[k2] === undefined) eff[k2] = p[k2];

    return {
      mixMat, mixOff, mixAmt, pull, pullAmt,
      physA, physBack, physAmt: physMix,
      aR, aB, dR, dB,
      A, Aout, post, k, dehazeOn, coef, coefW: w, coefH: h,
      wb, expMul,
      clahe, claheTiles: tiles, claheMix, claheK,
      curve, gain, deCast, vibrance, saturation: p.saturation, chromaGain, warmGain,
      sharpen, sharpenRadius: p.sharpenRadius, threshold, restore, shoulder: sh,
      denoise, clarity: p.clarity,
      beams: { x: beamX, y: beamY, amount: beams, length: p.beamLength, warm: p.beamWarm, thr: beamThr },
      surface: { ax: surfAx, ay: surfAy, bx: surfBx, by: surfBy, hl: surfaceHL, tone: p.surfaceTone, warm: p.surfaceWarm },
      neutral: { thr: neutralThr, amount: neutralAmt },
      effective: eff as Record<AutoKey, number>,
      stats: {
        underwater: uw,
        water,
        haze: clamp(d50 * hazeAct, 0, 1),
        illum,
        waterLight: A,
        sceneCut: cut,
        analysisMs: performance.now() - t0,
        chroma,
        noise: o.noise ? sigma : 0,
        beamPresence: bd.presence,
        surfacePresence: sd.presence,
      },
    };
  }

  /**
   * Scene-cut detector: total-variation distance between colour histograms of
   * consecutive frames. Camera pans score ~0.05–0.15; a cut scores > 0.3.
   */

  /**
   * How much of the de-cast gain is safe (0..1). The gain is grey-world on
   * near surfaces, which is wrong on a bottom that is truly coloured (beige
   * sand reads as a yellow cast): applied there it turns open water violet
   * and sun beams / the surface magenta. Measured after the gain: open water
   * must stay blue–green (OKLCh hue ≤ 275°) and bright light must not turn
   * magenta; otherwise the strength is bisected down until both hold.
   */
  private deCastGuard(e: Float32Array, L: Float32Array, tMap: Float32Array, gain: Vec3): number {
    const n = L.length;
    const [, , lHi] = quantiles(L, [0.5, 0.9, 0.97], 512);
    const water = [0, 0, 0, 0], bright = [0, 0, 0, 0];
    for (let i = 0, q = 0; i < n; i += 2, q += 6) {
      const far = 1 - smoothstep(0.3, 0.75, tMap[i]);
      const acc = L[i] >= lHi ? bright : far > 0.5 ? water : null;
      if (!acc) continue;
      acc[0] += e[q]; acc[1] += e[q + 1]; acc[2] += e[q + 2]; acc[3]++;
    }
    const bad = (k: number) => {
      for (const [acc, test] of [
        [water, (h: number, c: number) => c > 0.02 && h > 275 && h < 345],
        [bright, (h: number, c: number) => c > 0.025 && h > 290 && h < 350],
      ] as const) {
        if (acc[3] < 20) continue;
        const m = [0, 1, 2].map((c) => clamp((acc[c] / acc[3]) * (1 + (gain[c] - 1) * k), 0, 1));
        const lab = toOklab(srgbToLinear(m[0]), srgbToLinear(m[1]), srgbToLinear(m[2]));
        const h = ((Math.atan2(lab[2], lab[1]) * 180) / Math.PI + 360) % 360;
        if (test(h, Math.hypot(lab[1], lab[2]))) return true;
      }
      return false;
    };
    if (!bad(1)) return 1;
    if (bad(0)) return 0; // already off-hue before de-cast: do not make it worse
    let lo = 0, hi = 1;
    for (let it = 0; it < 6; it++) {
      const mid = 0.5 * (lo + hi);
      if (bad(mid)) hi = mid;
      else lo = mid;
    }
    return lo;
  }
  private detectCut(rgba: Uint8Array | Uint8ClampedArray, n: number): boolean {
    // 4×4×4 histogram with *soft* (trilinear) binning: a uniform water body
    // drifting in colour moves weight smoothly between bins instead of
    // flipping across a hard edge all at once, which read as a false cut.
    const sig = new Float32Array(64);
    const step = n > 20000 ? 2 : 1;
    let cnt = 0;
    for (let i = 0; i < n; i += step) {
      const j = i * 4;
      const f0 = Math.min(2.999, Math.max(0, rgba[j] / 85 - 0.5));
      const f1 = Math.min(2.999, Math.max(0, rgba[j + 1] / 85 - 0.5));
      const f2 = Math.min(2.999, Math.max(0, rgba[j + 2] / 85 - 0.5));
      const i0 = f0 | 0, i1 = f1 | 0, i2 = f2 | 0;
      const w0 = f0 - i0, w1 = f1 - i1, w2 = f2 - i2;
      for (let a = 0; a < 2; a++)
        for (let b = 0; b < 2; b++)
          for (let c = 0; c < 2; c++)
            sig[((i0 + a) << 4) | ((i1 + b) << 2) | (i2 + c)] +=
              (a ? w0 : 1 - w0) * (b ? w1 : 1 - w1) * (c ? w2 : 1 - w2);
      cnt++;
    }
    for (let i = 0; i < 64; i++) sig[i] /= cnt;
    const prev = this.sig;
    this.sig = sig;
    if (!prev) return false;
    let d = 0;
    for (let i = 0; i < 64; i++) d += Math.abs(sig[i] - prev[i]);
    return d * 0.5 > 0.3;
  }
}

/**
 * Scale OKLab chroma by `k`, but if that leaves sRGB, bisect back toward the
 * original (k = 1, in gamut) so only the *added* chroma is given up: hue and
 * lightness stay, nothing clips to a flat patch. Mirrors `gamutFit` in GLSL.
 */
export function gamutFit(lab: Vec3, k: number): Vec3 {
  const at = (f: number) => fromOklab(lab[0], lab[1] * f, lab[2] * f);
  const ok = (c: Vec3) => Math.min(c[0], c[1], c[2]) >= -1e-4 && Math.max(c[0], c[1], c[2]) <= 1.0001;
  let c = at(k);
  if (ok(c)) return c;
  let lo = 1, hi = k;
  for (let i = 0; i < 5; i++) {
    const mid = 0.5 * (lo + hi);
    if (ok(at(mid))) lo = mid;
    else hi = mid;
  }
  c = at(lo);
  return [clamp(c[0], 0, 1), clamp(c[1], 0, 1), clamp(c[2], 0, 1)];
}

/**
 * CPU reference of the final colour stage at analysis resolution — used by the
 * tests and by the photo thumbnails. Omits spatial detail (sharpen/clarity).
 */
export function mirrorRender(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, s: FrameState): Float32Array {
  const n = w * h;
  const out = new Float32Array(n * 3);
  const [kr, kg, kb] = s.k;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x,
        j = i * 4,
        q = i * 3;
      let r = LIN8[rgba[j]], g = LIN8[rgba[j + 1]], b = LIN8[rgba[j + 2]];
      r = Math.min(1, r + s.aR * s.dR * (1 - r) * g);
      b = Math.min(1, b + s.aB * s.dB * (1 - b) * g);
      const m = s.wb;
      const rw = Math.max(0, m[0] * r + m[1] * g + m[2] * b);
      const gw = Math.max(0, m[3] * r + m[4] * g + m[5] * b);
      const bw = Math.max(0, m[6] * r + m[7] * g + m[8] * b);
      r = rw; g = gw; b = bw;
      if (s.dehazeOn) {
        const I = Math.sqrt(luma(r, g, b));
        const t = clamp(s.coef[i * 4] * I + s.coef[i * 4 + 1], 0, 1);
        const m = 1 - smoothstep(T0, T0 + 0.25, t);
        const div = mix(Math.max(t, T0), 1, m),
          far = (1 - t) * (1 - m),
          veil = clamp((1 - t) / (1 - T0), 0, 1);
        const j0 = Math.max(0, ((r - s.A[0]) / div) * (1 + kr * far) + s.A[0] + (s.Aout[0] - s.A[0]) * veil);
        const j1 = Math.max(0, ((g - s.A[1]) / div) * (1 + kg * far) + s.A[1] + (s.Aout[1] - s.A[1]) * veil);
        const j2 = Math.max(0, ((b - s.A[2]) / div) * (1 + kb * far) + s.A[2] + (s.Aout[2] - s.A[2]) * veil);
        const yr = (luma(j0, j1, j2) + 1e-4) / (luma(r, g, b) + 1e-4);
        r = mix(r * yr, j0, DEHAZE_CHROMA);
        g = mix(g * yr, j1, DEHAZE_CHROMA);
        b = mix(b * yr, j2, DEHAZE_CHROMA);
      }
      const r2 = r * s.post[0] * s.expMul, g2 = g * s.post[1] * s.expMul, b2 = b * s.post[2] * s.expMul;
      const sl = (x: number) => x + (shoulder(x) - x) * s.shoulder;
      let er = encodeFast(sl(r2)), eg = encodeFast(sl(g2)), eb = encodeFast(sl(b2));
      if (s.clahe && s.claheMix > 0) {
        const L = luma(er, eg, eb);
        const L2 = mix(L, sampleClahe(s.clahe, s.claheTiles, L, (x + 0.5) / w, (y + 0.5) / h) * s.claheK, s.claheMix);
        const sc = (L2 + 1e-4) / (L + 1e-4);
        er *= sc; eg *= sc; eb *= sc;
      }
      // de-cast (mid-tone weighted), curve on luminance, vibrance/saturation
      const l0 = luma(er, eg, eb);
      const wgt = l0 < 0.3 ? (l0 / 0.3) ** 1.5 : l0 > 0.8 ? 0.5 + 0.5 * Math.max(0, 1 - (l0 - 0.8) / 0.2) : 1;
      const ew = s.deCast * wgt;
      er *= 1 + (s.gain[0] - 1) * ew;
      eg *= 1 + (s.gain[1] - 1) * ew;
      eb *= 1 + (s.gain[2] - 1) * ew;
      const l1 = luma(er, eg, eb);
      const f = clamp(l1, 0, 1) * 1023;
      const fi = Math.min(1022, Math.floor(f));
      const lc = s.curve[fi] + (s.curve[fi + 1] - s.curve[fi]) * (f - fi);
      const sc2 = (lc + 1e-3) / (l1 + 1e-3);
      er *= sc2; eg *= sc2; eb *= sc2;
      const l2 = luma(er, eg, eb);
      const sat = Math.max(er, eg, eb) - Math.min(er, eg, eb);
      const k2 = s.saturation + s.vibrance * (1 - smoothstep(0, 0.6, sat));
      let fr = clamp(l2 + (er - l2) * k2, 0, 1),
        fg = clamp(l2 + (eg - l2) * k2, 0, 1),
        fb = clamp(l2 + (eb - l2) * k2, 0, 1);
      if (s.chromaGain > 1.0001 || s.warmGain > 0.0001) {
        const lab = toOklab(srgbToLinear(fr), srgbToLinear(fg), srgbToLinear(fb));
        const C = Math.hypot(lab[1], lab[2]);
        if (C > 1e-5) {
          const k3 = boostChroma(C, Math.atan2(lab[2], lab[1]), s.chromaGain, s.warmGain) / C;
          const rgb = gamutFit(lab, k3);
          fr = encodeFast(rgb[0]); fg = encodeFast(rgb[1]); fb = encodeFast(rgb[2]);
        }
      }
      if (s.neutral.amount > 0) [fr, fg, fb] = neutralLight([fr, fg, fb], s.neutral.thr, s.neutral.amount);
      out[q] = fr;
      out[q + 1] = fg;
      out[q + 2] = fb;
    }
  return out;
}
