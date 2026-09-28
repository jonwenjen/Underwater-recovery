/**
 * Re-tunes the auto engine against ground-truth scenes:
 *   node --experimental-strip-types scripts/optimize.ts [--report] [--real[=dir]]
 * --report  score the current constants, presets and profiles; no search
 * --real    also report 23 real underwater photographs against reference images
 *           (EUVP test pairs; fetch once with `node scripts/fetch-euvp.mjs`).
 *           Reported, NOT tuned on: EUVP references are clear underwater
 *           photographs that keep much of the water's colour (reference red
 *           can be ~20/255), not colour-corrected truth, so fitting them
 *           would teach auto not to restore colour. They show over-processing
 *           (local contrast, exposure) on real footage.
 *
 * Synthetic scenes: the verify reef (scripts/verify-scene.js, true colours
 * known) degraded with the Jaffe–McGlamery model under a different condition:
 * blue water at 4 / 8 / 12 m, green water, murky water with grain, a strobe
 * close up, sunlit shallows with beams and a clipped surface band, plus a
 * clean non-underwater photo that auto must leave alone. Two reef layouts are
 * used so the constants do not fit one picture.
 *
 * Score of an output (lower is better), on surfaces:
 *   mean OKLab ΔE to the true colour ·4 (hue, chroma and lightness at once)
 *   + chromaticity error ·2 (the colour itself, whatever the exposure: ΔE
 *     alone barely noticed surfaces turning grey)
 *   + |local contrast / truth's − 1| ·0.3  +  white-slate chroma ·1
 * and on the whole frame: blown fraction ·8, water hue outside 150–275° ·0.3;
 * on the clean photo, mean change ·4. Real photographs have no masks: every
 * pixel is compared with the reference (ΔE ·4, local contrast, clipping).
 *
 * 1. Coordinate descent over TUNING (src/engine/auto.ts) on the suite.
 * 2. For each preset, coordinate descent over the values it locks, on the
 *    scene it is made for; a preset is kept only where it beats full auto.
 * 3. The imported 全自動 profiles: their strength searched on the suite
 *    (engine colour stages off, the method in their place).
 * The result is printed; chosen values are written into auto.ts / params.ts
 * by hand (README "How auto was tuned").
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AutoEngine, mirrorRender, TUNING, type FrameState } from '../src/engine/auto.ts';
import { srgbToLinear, toOklab } from '../src/engine/color.ts';
import { boxMean } from '../src/engine/filters.ts';
import { applySurface, surfaceMask } from '../src/engine/light.ts';
import { DEFAULT_PARAMS, isAutoKey, PRESETS, type AutoKey, type Params } from '../src/engine/params.ts';

(globalThis as unknown as { window: unknown }).window = globalThis;
await import('./verify-scene.js');
interface Truth {
  J: Float32Array;
  object: Uint8Array;
  slate: Uint8Array;
  w: number;
  h: number;
}
const S = (globalThis as unknown as {
  __scene: {
    truth(w: number, h: number, pan?: number, seed?: number): Truth;
    degrade(t: Truth, water: string, depth: number, seed?: number, opts?: Record<string, number | boolean>): Uint8ClampedArray;
    clean(t: Truth): Uint8ClampedArray;
  };
}).__scene;

const REPORT = process.argv.includes('--report');
/** --presets: keep TUNING as it is, search presets and profiles only */
const PRESETS_ONLY = process.argv.includes('--presets');
const realArg = process.argv.find((a) => a.startsWith('--real'));
const REAL_DIR = realArg ? (realArg.split('=')[1] ?? '/tmp/euvp') : null;

interface Ref {
  T: Truth;
  lab: Float32Array;
  lc: number;
}
/** Mean |L − local mean L| over surfaces: the detail CLAHE / clarity restore. */
function localContrast(Lf: Float32Array, object: Uint8Array, w: number, h: number): number {
  const Ls = boxMean(Lf, w, h, 1); // grain is not detail
  const m = boxMean(Ls, w, h, 4);
  let s = 0,
    c = 0;
  for (let i = 0; i < w * h; i++)
    if (object[i]) {
      s += Math.abs(Ls[i] - m[i]);
      c++;
    }
  return s / Math.max(1, c);
}
function ref(T: Truth): Ref {
  const n = T.w * T.h;
  const lab = new Float32Array(n * 3);
  const Lf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = toOklab(srgbToLinear(T.J[i * 3]), srgbToLinear(T.J[i * 3 + 1]), srgbToLinear(T.J[i * 3 + 2]));
    lab.set(v, i * 3);
    Lf[i] = v[0];
  }
  return { T, lab, lc: localContrast(Lf, T.object, T.w, T.h) };
}
const W = 192,
  H = 108;
const R1 = ref(S.truth(W, H));
const R2 = ref(S.truth(W, H, 0.35, 11));

interface Scene {
  name: string;
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  ref: Ref;
  clean?: boolean;
}
const syn = (name: string, rgba: Uint8ClampedArray, r: Ref, clean = false): Scene => ({ name, rgba, w: W, h: H, ref: r, clean });
const SCENES: Scene[] = [
  syn('blue4', S.degrade(R1.T, 'blue', 4), R1),
  syn('blue8', S.degrade(R1.T, 'blue', 8), R1),
  syn('blue8b', S.degrade(R2.T, 'blue', 8, 5), R2),
  syn('blue12', S.degrade(R1.T, 'blue', 12), R1),
  syn('green6', S.degrade(R2.T, 'green', 6), R2),
  syn('murky5', S.degrade(R1.T, 'murky', 5, 3, { noise: 6 }), R1),
  syn('strobe10', S.degrade(R2.T, 'blue', 10, 3, { strobe: 3 }), R2),
  syn('sunny2.5', S.degrade(R1.T, 'blue', 2.5, 3, { beams: true, surface: true }), R1),
  syn('clean', S.clean(R1.T), R1, true),
];
/** Preset-only scenes (not part of the auto suite). */
const EXTRA: Scene[] = [syn('blue18', S.degrade(R2.T, 'blue', 18, 7), R2)];

/** Real photographs: raw frame and its reference, every pixel scored. */
const REAL: Scene[] = [];
if (REAL_DIR) {
  if (!existsSync(join(REAL_DIR, 'index.json'))) throw new Error(`no ${REAL_DIR}/index.json — run node scripts/fetch-euvp.mjs first`);
  for (const { name, w, h } of JSON.parse(readFileSync(join(REAL_DIR, 'index.json'), 'utf8')) as { name: string; w: number; h: number }[]) {
    const raw = new Uint8ClampedArray(readFileSync(join(REAL_DIR, `${name}-raw.rgba`)));
    const rf = readFileSync(join(REAL_DIR, `${name}-ref.rgba`));
    const J = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) J[i * 3 + c] = rf[i * 4 + c] / 255;
    const T: Truth = { J, object: new Uint8Array(w * h).fill(1), slate: new Uint8Array(w * h), w, h };
    REAL.push({ name: `euvp-${name}`, rgba: raw, w, h, ref: ref(T) });
  }
}
const byName = (name: string) => [...SCENES, ...EXTRA].find((s) => s.name === name)!;

/* ------------------------------------------------------------------ score */
function render(sc: Scene, params: Params, locked: Set<AutoKey>): { out: Float32Array; st: FrameState } {
  const { w, h } = sc;
  const st = new AutoEngine().step(sc.rgba, w, h, { params, locked, dt: 0, snap: true, noise: { rgba: sc.rgba, w, h } });
  const out = mirrorRender(sc.rgba, w, h, st);
  const sf = st.surface;
  if (sf.hl > 0 || sf.tone !== 0 || sf.warm !== 0)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const q = (y * w + x) * 3;
        const m = surfaceMask((x + 0.5) / w, (y + 0.5) / h, sf.ax, sf.ay, sf.bx, sf.by);
        const c = applySurface([out[q], out[q + 1], out[q + 2]], m, sf.hl, sf.tone, sf.warm);
        out[q] = c[0];
        out[q + 1] = c[1];
        out[q + 2] = c[2];
      }
  return { out, st };
}

export interface Breakdown {
  total: number;
  dE: number;
  err: number;
  cRatio: number;
  dL: number;
  lc: number;
  slate: number;
  blown: number;
  hue: number;
}

function score(sc: Scene, params: Params, locked: Set<AutoKey>): Breakdown {
  const { out } = render(sc, params, locked);
  const n = sc.w * sc.h;
  if (sc.clean) {
    let d = 0;
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) d += Math.abs(out[i * 3 + c] - sc.rgba[i * 4 + c] / 255);
    const harm = d / (n * 3);
    return { total: 4 * harm, dE: 0, err: harm, cRatio: 0, dL: 0, lc: 0, slate: 0, blown: 0, hue: 0 };
  }
  const { T, lab: truthLab } = sc.ref;
  const Lo = new Float32Array(n);
  let dE = 0, err = 0, cnt = 0, cO = 0, cT = 0, lO = 0, lT = 0, sl = 0, sn = 0, blown = 0, wa = 0, wb = 0, wn = 0;
  for (let i = 0; i < n; i++) {
    const q = i * 3;
    const r = out[q], g = out[q + 1], b = out[q + 2];
    if (Math.min(r, g, b) >= 0.98) blown++;
    const lab = toOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
    Lo[i] = lab[0];
    if (!T.object[i]) {
      wa += lab[1];
      wb += lab[2];
      wn++;
      continue;
    }
    const s = r + g + b + 1e-3,
      st = T.J[q] + T.J[q + 1] + T.J[q + 2] + 1e-3;
    err += Math.abs(r / s - T.J[q] / st) + Math.abs(g / s - T.J[q + 1] / st) + Math.abs(b / s - T.J[q + 2] / st);
    dE += Math.hypot(lab[0] - truthLab[q], lab[1] - truthLab[q + 1], lab[2] - truthLab[q + 2]);
    cO += Math.hypot(lab[1], lab[2]);
    cT += Math.hypot(truthLab[q + 1], truthLab[q + 2]);
    lO += lab[0];
    lT += truthLab[q];
    if (T.slate[i]) {
      sl += Math.hypot(lab[1], lab[2]);
      sn++;
    }
    cnt++;
  }
  err /= cnt;
  const cRatio = cO / Math.max(1e-6, cT);
  const dL = (lO - lT) / cnt;
  const slate = sn ? sl / sn : 0;
  blown /= n;
  let hue = 0;
  if (wn) {
    const deg = ((Math.atan2(wb / wn, wa / wn) * 180) / Math.PI + 360) % 360;
    hue = deg < 150 ? (150 - deg) / 90 : deg > 275 ? (deg - 275) / 90 : 0;
  }
  const lcRatio = localContrast(Lo, T.object, sc.w, sc.h) / sc.ref.lc;
  const lc = Math.abs(lcRatio - 1);
  dE /= cnt;
  const total = 4 * dE + 2 * err + 0.3 * lc + slate + 8 * blown + 0.3 * hue;
  return { total, dE, err, cRatio, dL, lc: lcRatio, slate, blown, hue };
}

type Setting = { params: Params; locked: Set<AutoKey> };
const AUTO = (): Setting => ({ params: { ...DEFAULT_PARAMS, auto: true } as Params, locked: new Set<AutoKey>() });
const fromSet = (s: Record<string, number>): Setting => {
  const params = { ...DEFAULT_PARAMS, auto: true, ...s } as Params;
  const locked = new Set<AutoKey>();
  for (const k of Object.keys(s)) if (isAutoKey(k as keyof Params)) locked.add(k as AutoKey);
  return { params, locked };
};
const mean = (scenes: Scene[], st: Setting, pick: (b: Breakdown) => number = (b) => b.total) =>
  scenes.length ? scenes.reduce((a, sc) => a + pick(score(sc, st.params, st.locked)), 0) / scenes.length : 0;
const suiteOf = (st: Setting) => mean(SCENES, st);
const suite = () => suiteOf(AUTO());

const f3 = (x: number) => x.toFixed(3);
function table(label: string) {
  const { params, locked } = AUTO();
  console.log(`\n${label}`);
  console.log('scene      total   ΔE_ok   chromaErr  C/Ct   L−Lt    LC/LCt  slateC  blown  hue');
  for (const sc of SCENES) {
    const b = score(sc, params, locked);
    console.log(
      `${sc.name.padEnd(10)} ${f3(b.total)}   ${f3(b.dE)}   ${f3(b.err)}      ${f3(b.cRatio)}  ${f3(b.dL)}  ${f3(b.lc)}   ${f3(b.slate)}   ${f3(b.blown)}  ${f3(b.hue)}`,
    );
  }
  if (REAL.length) {
    const avg = (k: keyof Breakdown) => mean(REAL, AUTO(), (b) => b[k]);
    const src = REAL.reduce((a, sc) => a + sourceDE(sc), 0) / REAL.length;
    console.log(
      `real ×${REAL.length}   ${f3(avg('total'))}   ${f3(avg('dE'))}   ${f3(avg('err'))}      ${f3(avg('cRatio'))}  ${f3(avg('dL'))}  ${f3(avg('lc'))}   —       ${f3(avg('blown'))}  —   (source ΔE ${f3(src)})`,
    );
  }
  console.log(`suite mean ${f3(suite())}`);
}
/** ΔE of the untouched source against the reference (the "do nothing" baseline). */
function sourceDE(sc: Scene): number {
  let d = 0;
  const n = sc.w * sc.h;
  for (let i = 0; i < n; i++) {
    const l = toOklab(srgbToLinear(sc.rgba[i * 4] / 255), srgbToLinear(sc.rgba[i * 4 + 1] / 255), srgbToLinear(sc.rgba[i * 4 + 2] / 255));
    d += Math.hypot(l[0] - sc.ref.lab[i * 3], l[1] - sc.ref.lab[i * 3 + 1], l[2] - sc.ref.lab[i * 3 + 2]);
  }
  return d / n;
}

/* ----------------------------------------------------- 1. TUNING search */
type TKey = keyof typeof TUNING;
const RANGES: Record<TKey, [number, number]> = {
  // ranges keep every constant inside what looks sane on real footage
  // (e.g. red gain beyond 1.6 amplifies red-channel noise in deep water)
  redGain: [0.6, 1.6],
  blueGain: [0.2, 1.2],
  wbGain: [0.6, 1],
  dehazeBase: [0, 0.1], // non-underwater frames: nearly untouched
  dehazeGain: [0.4, 0.9], // base + gain ≤ 1 (the slider's range)
  depthGain: [0, 2.5],
  claheBase: [0, 0.2],
  claheFlat: [0, 0.5],
  kLo: [0.1, 0.24],
  vibBase: [0, 0.3],
  vibGain: [0, 0.6],
  deCastGain: [0, 1],
  vividAuto: [0, 0.8],
};
const before = { ...TUNING };
table('before (current TUNING)');

let best = suite();
for (let pass = 0; pass < (REPORT || PRESETS_ONLY ? 0 : 3); pass++) {
  let improved = false;
  for (const k of Object.keys(RANGES) as TKey[]) {
    const [lo, hi] = RANGES[k];
    const step = (hi - lo) * (pass === 0 ? 0.15 : pass === 1 ? 0.07 : 0.03);
    for (const dir of [1, -1]) {
      for (;;) {
        const old = TUNING[k];
        const v = Math.min(hi, Math.max(lo, +(old + dir * step).toFixed(3)));
        if (v === old) break;
        TUNING[k] = v;
        const s = suite();
        if (s < best - 1e-4) {
          best = s;
          improved = true;
        } else {
          TUNING[k] = old;
          break;
        }
      }
    }
  }
  console.log(`pass ${pass + 1}: suite ${f3(best)}`);
  if (!improved && pass > 0) break;
}
if (!REPORT && !PRESETS_ONLY) {
  console.log('\nTUNING before → after');
  for (const k of Object.keys(RANGES) as TKey[]) console.log(`  ${k.padEnd(11)} ${String(before[k]).padEnd(6)} → ${TUNING[k]}`);
  table('after (optimised TUNING)');
}

/* ----------------------------------------------------- 2. preset search */
const PRESET_SCENE: Record<string, string> = {
  blue: 'blue18',
  green: 'green6',
  murky: 'murky5',
  strobe: 'strobe10',
  sunny: 'sunny2.5',
};
const PRANGE: Partial<Record<keyof Params, [number, number]>> = {
  redComp: [0, 1.6],
  blueComp: [0, 1], // slider range
  depthColor: [0, 0.6],
  dehaze: [0, 0.95],
  wbStrength: [0, 1],
  clahe: [0, 1],
  vibrance: [-0.5, 0.8],
  tint: [-1, 1],
  temp: [-1, 1],
  highlights: [-1, 0.5],
  whites: [0.7, 1], // slider range
  shadows: [-0.5, 0.8],
  waterTint: [0, 1],
  exposure: [-1, 1],
  surfaceHL: [0, 1],
  contrast: [-1, 1],
};
/** Per-preset limits that keep each preset's character (淺水／陽光 protects
 * highlights, 混濁 keeps dehazing, 閃燈 keeps red compensation light). */
const PKEEP: Record<string, Partial<Record<keyof Params, [number, number]>>> = {
  // lower white points clip beams on the GPU (clarity); a sunlit-shallows
  // preset keeps turquoise water and does not wash colour out
  sunny: { highlights: [-1, 0], whites: [0.97, 1], waterTint: [0.5, 1], vibrance: [-0.2, 0.8] },
  murky: { dehaze: [0.6, 0.95] },
  strobe: { redComp: [0, 0.8] },
  green: { tint: [-0.6, 0.6] },
  blue: { vibrance: [-0.3, 0.8] }, // a deep-water preset should not wash colour out
};
console.log('\npresets (on their own scene; auto = full auto on that scene)');
for (const [key, sceneName] of Object.entries(PRESET_SCENE)) {
  const sc = byName(sceneName);
  // candidate keys a preset does not lock yet (dropped again if auto does as well)
  const TRY: Record<string, Record<string, number>> = {
    sunny: { surfaceHL: 0.5 },
    strobe: { dehaze: 0.5, depthColor: 0.2, wbStrength: 0.8, deCast: 0.5 },
  };
  const set: Record<string, number> = { ...(PRESETS[key].set as Record<string, number>), ...(REPORT ? {} : TRY[key]) };
  const evalSet = (s: Record<string, number>) => {
    const st = fromSet(s);
    return score(sc, st.params, st.locked).total;
  };
  const autoS = evalSet({});
  const startS = evalSet(set);
  let bestP = startS;
  // search the preset's own keys; detail/restore keys are not visible in the mirror
  const keys = Object.keys(set).filter((k) => k in PRANGE);
  for (let pass = 0; pass < (REPORT ? 0 : 3); pass++)
    for (const k of keys) {
      const [lo, hi] = PKEEP[key]?.[k as keyof Params] ?? PRANGE[k as keyof Params]!;
      const step = (hi - lo) * (pass === 0 ? 0.1 : pass === 1 ? 0.05 : 0.02);
      for (const dir of [1, -1])
        for (;;) {
          const old = set[k];
          const v = Math.min(hi, Math.max(lo, +(old + dir * step).toFixed(2)));
          if (v === old) break;
          set[k] = v;
          const s = evalSet(set);
          if (s < bestP - 1e-4) bestP = s;
          else {
            set[k] = old;
            break;
          }
        }
    }
  // a lock that does no better than auto is dropped (auto keeps adapting)
  for (const k of REPORT ? [] : Object.keys(set)) {
    if (!(k in PRANGE) || !isAutoKey(k as keyof Params) || PKEEP[key]?.[k as keyof Params]) continue;
    const trial = { ...set };
    delete trial[k];
    const s = evalSet(trial);
    if (s <= bestP + 1e-3) {
      delete set[k];
      bestP = Math.min(bestP, s);
    }
  }
  console.log(
    `  ${key.padEnd(7)} ${sceneName.padEnd(9)} auto ${f3(autoS)}  preset ${f3(startS)} → ${f3(bestP)}  ${bestP < autoS ? 'beats auto' : 'NOT better than auto'}`,
  );
  console.log(`          ${JSON.stringify(set)}`);
}

/* ------------------------------------------- 3. imported 全自動 profiles */
// Each profile replaces the engine's colour correction with its own method;
// its strength is searched on the ground-truth suite.
const PROFILE_AMOUNT: Record<string, keyof Params> = {
  '全自動-bornfree': 'matrixMix',
  '全自動-nikolajbech': 'matrixMix',
  '全自動-T77701': 'meanPull',
  '全自動-warplab': 'physicalMix',
};
console.log('\nimported profiles (suite score; lower is better; full auto for reference)');
const autoSuite = suiteOf(AUTO());
const scoreParts = (st: Setting) =>
  `synthetic ΔE ${f3(mean(SCENES.filter((s) => !s.clean), st, (b) => b.dE))}` +
  (REAL.length ? `, real ΔE ${f3(mean(REAL, st, (b) => b.dE))}` : '');
console.log(`  全自動              suite ${f3(autoSuite)}  ${scoreParts(AUTO())}`);
for (const [name, amtKey] of Object.entries(PROFILE_AMOUNT)) {
  const set = { ...(PRESETS[name].set as Record<string, number>) };
  const start = suiteOf(fromSet(set));
  let bestS = start;
  for (let pass = 0; pass < (REPORT ? 0 : 2); pass++) {
    const step = pass === 0 ? 0.1 : 0.05;
    for (const dir of [1, -1])
      for (;;) {
        const old = set[amtKey as string];
        const v = Math.min(1, Math.max(0.1, +(old + dir * step).toFixed(2)));
        if (v === old) break;
        set[amtKey as string] = v;
        const s = suiteOf(fromSet(set));
        if (s < bestS - 1e-4) bestS = s;
        else {
          set[amtKey as string] = old;
          break;
        }
      }
  }
  console.log(`  ${name.padEnd(18)} suite ${f3(start)} → ${f3(bestS)}  ${amtKey} ${set[amtKey as string]}  ${scoreParts(fromSet(set))}`);
}
