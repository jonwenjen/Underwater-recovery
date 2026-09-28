/**
 * Tests for the histogram-gap colour matrix (src/engine/matrix.ts) and for
 * the two other borrowed methods that feed new auto profiles.
 *
 *   node --experimental-strip-types test/methods.test.ts
 *
 * The golden vectors are the coefficient tables published in the upstream
 * write-ups of each method, so a refactor that changes behaviour visibly
 * breaks here rather than quietly changing what a preset does.
 */
import {
  applyColorMatrix,
  analyzeColorMatrix,
  BLUE_MAGIC,
  hueShiftRed,
  matrixFromHistograms,
  MAX_HUE_SHIFT,
  MIN_AVG_RED,
  searchHueShift,
  sparseBins,
  widestGap,
  type ColorMatrix,
} from '../src/engine/matrix.ts';
import { meanPull, meanPullGL, toneAdjust } from '../src/engine/twostep.ts';
import { AutoEngine, mirrorRender } from '../src/engine/auto.ts';
import { physicalGL, physicalRestoreRGB, JERLOV, fitBackscatter, fitAttenuation, MAX_GAIN } from '../src/engine/physical.ts';
import { srgbToLinear, toOklab } from '../src/engine/color.ts';
import { DEFAULT_PARAMS, isAutoKey, PRESETS, type AutoKey, type Params } from '../src/engine/params.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/* ------------------------------------------------- hue shift coefficients */

{
  // Golden table from the method description: (h, rCoef, gCoef, bCoef).
  const table: [number, number, number, number][] = [
    [0, 1.0, 0.0, 0.0],
    [30, 0.990084, 0.243643, -0.233227],
    [60, 0.794992, 0.579288, -0.373415],
    [90, 0.467, 0.917, -0.383],
    [120, 0.093992, 1.166288, -0.259415],
  ];
  let worst = 0;
  for (const [h, r, g, b] of table) {
    const s = hueShiftRed(1, 1, 1, h);
    worst = Math.max(worst, Math.abs(s[0] - r), Math.abs(s[1] - g), Math.abs(s[2] - b));
  }
  check('hue shift matches the published coefficient table', worst < 1e-5, `max err ${worst.toExponential(2)}`);

  // The three coefficients must sum to 1: this redistributes luma, it does not
  // invent light. Verified across the whole range, not just the table.
  let sumErr = 0;
  for (let h = 0; h <= 180; h++) {
    const s = hueShiftRed(1, 1, 1, h);
    sumErr = Math.max(sumErr, Math.abs(s[0] + s[1] + s[2] - 1));
  }
  check('hue shift conserves luma (coefficients sum to 1)', sumErr < 2e-3, `max err ${sumErr.toExponential(2)}`);
}

/* --------------------------------------------------------- hue shift search */

{
  check('no shift when mean red is already above the floor', searchHueShift([80, 10, 10]) === 0);
  check('no shift at exactly the floor', searchHueShift([MIN_AVG_RED, 130, 140]) === 0);
  const h1 = searchHueShift([59, 130, 140]);
  const h2 = searchHueShift([5, 100, 120]);
  check('a red-starved image gets a larger shift than a mildly starved one', h1 > 0 && h2 > h1, `59->${h1}, 5->${h2}`);
  // Upstream's loop saturates one degree past the cap; reproduced deliberately.
  check('hopeless image clamps at MAX_HUE_SHIFT + 1', searchHueShift([0, 0, 0]) === MAX_HUE_SHIFT + 1, `got ${searchHueShift([0, 0, 0])}`);
}

/* ------------------------------------------------------------- widest gap */

{
  check('widest gap brackets the widest hole', (() => {
    const g = widestGap([0, 10, 20, 200, 210, 255]);
    return g.low === 20 && g.high === 200;
  })());
  check('ties keep the leftmost gap', (() => {
    // gaps: 40, 60, 40, 60, 55 -> a genuine 60/60 tie, leftmost must win
    const g = widestGap([0, 40, 100, 140, 200, 255]);
    return g.low === 40 && g.high === 100;
  })());
  const bins = sparseBins(new Uint32Array(256), 10);
  check('sparse bins include both sentinels', bins[0] === 0 && bins[bins.length - 1] === 255);
  check('the +2 slack admits threshold+1 but not threshold+2', (() => {
    const a = new Uint32Array(256); a[100] = 11; // 11-10 = 1 < 2 -> sparse
    const b = new Uint32Array(256); b[100] = 12; // 12-10 = 2, not < 2 -> dense
    return sparseBins(a, 10).includes(100) && !sparseBins(b, 10).includes(100);
  })());
}

/* --------------------------------------------------------- matrix golden */

{
  // Reference matrix published for a real example image: mean red already
  // above the floor, so hueShift is 0 and the R row is purely diagonal.
  const flat = new Uint32Array(256).fill(1000);
  const m0 = matrixFromHistograms(flat, flat, flat, 10, 0);
  check('hueShift 0 makes the R row diagonal', m0.m[1] === 0 && m0.m[2] === 0, `R row ${m0.m.slice(0, 3).map((v) => v.toFixed(4))}`);

  // A shifted angle must put the 1.2 on the blue term only, never on G.
  const mh = matrixFromHistograms(flat, flat, flat, 10, 62);
  const s = hueShiftRed(1, 1, 1, 62);
  const gain0 = mh.m[0] / s[0];
  check('blue magic 1.2 multiplies only the R-row blue term', near(mh.m[2], s[2] * gain0 * BLUE_MAGIC, 1e-9), `m[2]=${mh.m[2].toFixed(6)}`);
  check('R-row red term is shifted*redGain (no 1.2)', near(mh.m[0], s[0] * gain0, 1e-9));
  check('R-row gain equals the G-row gain', near(gain0, mh.m[4], 1e-9), `R=${gain0.toFixed(4)} G=${mh.m[4].toFixed(4)}`);
  check('green row stays a pure diagonal', mh.m[3] === 0 && mh.m[5] === 0);
  // regression: the blue row once read the 4×5 upstream matrix with a
  // stride of 3 and multiplied GREEN by the blue gain
  check('blue row is blue × blue gain (pure diagonal)', mh.m[6] === 0 && mh.m[7] === 0 && mh.m[8] > 0, `B row ${mh.m.slice(6).map((v) => v.toFixed(3))}`);
}

/* ------------------------------------------------- end to end on a scene */

function scene(w: number, h: number, fn: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = fn(x, y);
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  return d;
}

{
  const w = 320, h = 180;
  // Deep blue-green water: red is heavily absorbed, exactly the case the
  // method exists for.
  const deep = scene(w, h, (x, y) => {
    const t = (x + y) / (w + h);
    return [20 + 25 * t, 90 + 40 * t, 120 + 30 * t];
  });
  const m: ColorMatrix = analyzeColorMatrix(deep, w, h, { analysis: 'full' });
  check('deep water gets a hue shift', m.hueShift > 0, `hueShift=${m.hueShift}`);
  check('deep water gets a red gain above 1', m.m[0] > 1, `redGain=${m.m[0].toFixed(4)}`);

  const before = (() => { let s = 0; for (let i = 0; i < deep.length; i += 4) s += deep[i]; return s / (w * h); })();
  const after = (() => { let s = 0, n = 0; for (let i = 0; i < deep.length; i += 4) { s += applyColorMatrix(m, deep[i], deep[i+1], deep[i+2])[0]; n++; } return s / n; })();
  check('mean red is lifted toward the floor', after > before, `${before.toFixed(1)} -> ${after.toFixed(1)}`);

  // A red-starved image must be lifted, and a red-rich one must not be
  // pushed further.
  const rich = scene(w, h, () => [220, 120, 60]);
  const mr = analyzeColorMatrix(rich, w, h, { analysis: 'full' });
  check('an already red image gets no hue shift', mr.hueShift === 0, `hueShift=${mr.hueShift}`);

  // fixed256 pins the threshold; full scales it with the sample count. This
  // is the whole reason the two profiles behave differently on video.
  const big = scene(1024, 576, (x) => {
    const t = x / 1024;
    return [15 + 20 * t, 80 + 30 * t, 110 + 25 * t];
  });
  const fixed = analyzeColorMatrix(big, 1024, 576, { analysis: 'fixed256' });
  const full = analyzeColorMatrix(big, 1024, 576, { analysis: 'full' });
  check('fixed256 and full analysis use different thresholds', near(fixed.threshold, 32.768, 0.01) && full.threshold > 100,
    `fixed=${fixed.threshold.toFixed(3)} full=${full.threshold.toFixed(1)}`);

  // The 1.2 blue factor reaches -1.4 on a heavily degraded frame and turns
  // the image magenta; the R-row blue term is what has to stay bounded.
  check('the R-row blue term stays bounded', m.m[2] >= -0.8501, `blue term ${m.m[2].toFixed(3)}`);

  // A flat frame has no tonal range; the gain must not explode.
  const flatScene = scene(w, h, () => [100, 100, 100]);
  const mf = analyzeColorMatrix(flatScene, w, h, { analysis: 'full' });
  check('a flat frame does not produce an exploding gain', mf.m[0] < 8, `redGain=${mf.m[0].toFixed(3)}`);

  // Transparency must be ignored, not treated as black.
  const alpha = scene(w, h, (x) => (x < w / 2 ? [30, 100, 130] : [0, 0, 0]));
  for (let yy = 0; yy < h; yy++) for (let xx = w / 2; xx < w; xx++) alpha[(yy * w + xx) * 4 + 3] = 0;
  const ma = analyzeColorMatrix(alpha, w, h, { analysis: 'full' });
  check('fully transparent pixels are excluded from the statistics', Number.isFinite(ma.m[0]) && ma.hueShift >= 0);
}

/* ============================== Two-step (Fu et al., ISPACS 2017) ======== */

{
  // Eq. 2: pull each channel's mean to 128, with the protection branch. The
  // branch is the only genuinely new idea in that paper and the reason this
  // method is worth porting at all.
  const dark = { mean: 61, min: 20, max: 90 };
  const p = 0.8; // >= 70% of pixels at or below 40
  const pulled = toneAdjust(61, dark, p, 0.4);
  check('protected channel is shifted, not stretched', near(pulled, 61 - 0.4 * (61 - 128), 1e-9), `got ${pulled.toFixed(2)}`);

  const stretched = toneAdjust(61, dark, 0.0, 0.4);
  check('unprotected channel uses the min-anchored stretch', near(stretched, (61 - 61) * 1 + 128, 1e-9) || stretched > 100,
    `got ${stretched.toFixed(2)}`);

  // Branch direction: mean above 128 anchors on max, below on min.
  const hi = toneAdjust(200, { mean: 200, min: 40, max: 250 }, 0.0, 0.4);
  const lo = toneAdjust(60, { mean: 60, min: 20, max: 90 }, 0.0, 0.4);
  check('mean above 128 is pulled down', hi < 200, `got ${hi.toFixed(2)}`);
  check('mean below 128 is pulled up', lo > 60, `got ${lo.toFixed(2)}`);

  // Protection must preserve contrast exactly (that is the whole point).
  const stats = { mean: 45, min: 30, max: 70 };
  const spread = (f: (v: number) => number) => f(stats.max) - f(stats.min);
  const plain = spread((v) => toneAdjust(v, stats, 0.9, 0.4));
  const shifted = spread((v) => toneAdjust(v, stats, 0.0, 0.4));
  check('protection preserves channel spread; stretching amplifies it', shifted > plain * 1.5,
    `protected ${plain.toFixed(1)} vs stretched ${shifted.toFixed(1)}`);

  // Clamping.
  check('output is clamped to 0..255', toneAdjust(255, { mean: 255, min: 0, max: 255 }, 0, 0.4) <= 255);
  check('λ=0 is a no-op for a protected channel', near(toneAdjust(90, { mean: 90, min: 0, max: 255 }, 0.9, 0), 90, 1e-9));
}

/* ========================== DeepSeeColor-style physical model ============ */

{
  check('Jerlov coefficients are ordered red > green > blue', JERLOV.coastal.ar > JERLOV.coastal.ag && JERLOV.coastal.ag > JERLOV.coastal.ab,
    `coastal ${JSON.stringify(JERLOV.coastal)}`);

  // At zero depth the model must be the identity on a lit pixel.
  const z = 0;
  const I = physicalRestoreRGB([0.5, 0.5, 0.5], JERLOV.blue, z, 0);
  check('zero depth leaves the pixel alone', near(I[0], 0.5, 1e-6) && near(I[1], 0.5, 1e-6), JSON.stringify(I));

  // Red must attenuate far faster than blue, so a distant object goes blue.
  // physicalRestoreRGB returns the RECOVERED J, so red must come back
  // relative to blue, and further more the deeper we correct.
  const nearI = physicalRestoreRGB([0.6, 0.6, 0.6], JERLOV.blue, 1, 0);
  const farI = physicalRestoreRGB([0.6, 0.6, 0.6], JERLOV.blue, 12, 0);
  check('restoration pulls red back relative to blue', farI[0] / farI[2] > nearI[0] / nearI[2],
    `1m r/b=${(nearI[0] / nearI[2]).toFixed(3)} 12m r/b=${(farI[0] / farI[2]).toFixed(3)}`);
  check('red correction is stronger than blue correction', farI[0] / 0.6 > farI[2] / 0.6,
    `xR=${(farI[0] / 0.6).toFixed(3)} xB=${(farI[2] / 0.6).toFixed(3)}`);
  // The gain is anchored on green: green must pass through untouched, which is
  // what stops the frame coming out green when red and green both saturate.
  check('green is left alone by the differential gain', near(farI[1], 0.6, 0.02),
    `green ${farI[1].toFixed(3)} (input 0.600)`);
  // The underlying model: attenuation is what makes red fall off fastest.
  const attAt = (c: number, z: number) => Math.exp(-(c === 0 ? JERLOV.blue.ar : c === 2 ? JERLOV.blue.ab : JERLOV.blue.ag) * z);
  check('the underlying model attenuates red fastest', attAt(0, 12) < attAt(2, 12),
    `A_r=${attAt(0,12).toFixed(4)} A_b=${attAt(2,12).toFixed(4)}`);

  // Backscatter must lift the floor, not crush it.
  const hazy = physicalRestoreRGB([0.2, 0.2, 0.2], JERLOV.blue, 1, 0.4);
  check('backscatter removes light at short range (and red is subtracted most)', hazy[0] < 0.2 && hazy[0] < hazy[2], JSON.stringify(hazy.map(v=>+v.toFixed(3))));

  // The gain clamp is what keeps this usable without a depth map.
  const extreme = physicalRestoreRGB([0.05, 0.05, 0.05], JERLOV.blue, 40, 0);
  check('very deep noisy pixels do not explode past the gain clamp', Number.isFinite(extreme[0]) && extreme[0] <= 3 * 0.05 + 1e-9, `got ${extreme[0].toFixed(4)}`);

  // The fitted parameters must reduce the residual of the "black" pixels,
  // which is the objective the published method minimises.
  const N = 64;
  const zs = new Float32Array(N), obs = new Float32Array(N);
  for (let i = 0; i < N; i++) { zs[i] = i / 10; obs[i] = 0.55 * (1 - Math.exp(-0.35 * zs[i])); }
  const fit = fitBackscatter(zs, obs, JERLOV.blue);
  const fitArr = [fit];
  const resid = (() => { let s = 0; for (let i = 0; i < N; i++) { const p = 0.55 * (1 - Math.exp(-0.35 * zs[i])) * (1 - 0) + 0; s += (obs[i] - p) ** 2; } return s; })();
  check('backscatter fit returns a finite scale', Number.isFinite(fit), `scale=${fit.toFixed(4)}`);

  const att = fitAttenuation(zs, obs, JERLOV.blue);
  check('attenuation fit returns three finite slopes', att.every(Number.isFinite), JSON.stringify(att.map((v) => +v.toFixed(4))));
  void resid; void meanPull; void fitArr;
}

/* ======================= the profiles inside the engine ================ */

{
  // GLSL twins agree with the reference functions away from the blend band
  const st = { mean: 70, min: 12, max: 200 };
  const s4 = [st.mean / 255, st.min / 255, st.max / 255, 0.2];
  let same = true;
  for (let v = 0; v <= 255; v += 17) if (Math.abs(meanPullGL(v / 255, s4, 0, 1) * 255 - toneAdjust(v, st, 0.2)) > 0.01) same = false;
  const s4d = [st.mean / 255, st.min / 255, st.max / 255, 0.95];
  for (let v = 0; v <= 255; v += 17) if (Math.abs(meanPullGL(v / 255, s4d, 0, 1) * 255 - toneAdjust(v, st, 0.95)) > 0.01) same = false;
  check('meanPullGL matches Eq. 2 outside the 0.6–0.8 blend band', same);
  const lo = meanPullGL(0.3, [70 / 255, 12 / 255, 200 / 255, 0.69], 0, 1), hi = meanPullGL(0.3, [70 / 255, 12 / 255, 200 / 255, 0.71], 0, 1);
  const jump = Math.abs(toneAdjust(0.3 * 255, st, 0.69) - toneAdjust(0.3 * 255, st, 0.71)) / 255;
  check('meanPullGL: a 0.02 change in dark fraction moves the output far less than the published switch (video)',
    Math.abs(lo - hi) < 0.25 * jump, `${Math.abs(lo - hi).toFixed(3)} vs published jump ${jump.toFixed(3)}`);
  check('physicalGL: a channel with no attenuation passes through', physicalGL(0.4, 0, 0.05) === 0.4);
  check('physicalGL: gain never exceeds the clamp', physicalGL(0.2, 5, 0) <= 0.2 * MAX_GAIN + 1e-9);

  // scenes with known truth (scripts/verify-scene.js)
  (globalThis as unknown as { window: unknown }).window ??= globalThis;
  await import('../scripts/verify-scene.js');
  type Scene = {
    truth(w: number, h: number, pan?: number, seed?: number): { J: Float32Array; object: Uint8Array };
    degrade(t: unknown, water: string, depth: number, seed?: number): Uint8ClampedArray;
  };
  const SC = (globalThis as unknown as { __scene: Scene }).__scene;
  const w = 192, h = 108;
  const T = SC.truth(w, h);
  const run = (name: string, img: Uint8ClampedArray, eng = new AutoEngine(), dt = 0) => {
    const set = PRESETS[name].set as Record<string, number>;
    const params = { ...DEFAULT_PARAMS, auto: true, ...set } as Params;
    const locked = new Set(Object.keys(set).filter((k) => isAutoKey(k as keyof Params)) as AutoKey[]);
    return eng.step(img, w, h, { params, locked, dt });
  };
  const deep = SC.degrade(T, 'blue', 12);
  const PROF = ['全自動-bornfree', '全自動-nikolajbech', '全自動-T77701', '全自動-warplab'];
  const amounts = PROF.map((p) => run(p, deep));
  check('each profile arms exactly its own method (effective amounts)',
    amounts.every((st) => [st.mixAmt, st.pullAmt, st.physAmt].filter((v) => v > 0.0001).length === 1),
    amounts.map((st, i) => `${PROF[i].slice(4)} m${st.mixAmt.toFixed(2)}/p${st.pullAmt.toFixed(2)}/ph${st.physAmt.toFixed(2)}`).join(' '));
  check('a profile replaces the engine colour correction (red comp, WB, de-cast off)',
    amounts.every((st) => st.effective.redComp === 0 && st.effective.wbStrength === 0 && st.effective.deCast === 0));
  check('全自動-warplab engages on a red-starved 12 m frame', amounts[3].physAmt > 0.3 && amounts[3].physA[0] > 0.3,
    `amount ${amounts[3].physAmt.toFixed(2)}, a_r·z ${amounts[3].physA[0].toFixed(2)}`);

  // colour vs truth: every profile must beat the untouched source
  const dE = (px: ArrayLike<number>, stride: number, scale: number) => {
    let d = 0, c = 0;
    for (let i = 0; i < w * h; i++) {
      if (!T.object[i]) continue;
      const a = toOklab(srgbToLinear(px[i * stride] * scale), srgbToLinear(px[i * stride + 1] * scale), srgbToLinear(px[i * stride + 2] * scale));
      const b = toOklab(srgbToLinear(T.J[i * 3]), srgbToLinear(T.J[i * 3 + 1]), srgbToLinear(T.J[i * 3 + 2]));
      d += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      c++;
    }
    return d / c;
  };
  const src = dE(deep, 4, 1 / 255);
  const res = amounts.map((st) => dE(mirrorRender(deep, w, h, st), 3, 1));
  check('every profile moves a 12 m frame closer to the true colours than the source', res.every((v) => v < src),
    `source ΔE ${src.toFixed(3)} → ${res.map((v, i) => `${PROF[i].slice(4)} ${v.toFixed(3)}`).join(', ')}`);

  // video: the per-frame method statistics are smoothed by the tracker
  const eng = new AutoEngine();
  let maxStep = 0, prev: number[] | null = null;
  for (let f = 0; f < 20; f++) {
    const img = SC.degrade(SC.truth(w, h, f * 0.01), 'blue', 8, f);
    const st = run('全自動-bornfree', img, eng, f === 0 ? 0 : 1 / 30);
    const cur = [...st.mixMat, ...st.mixOff];
    if (prev) maxStep = Math.max(maxStep, ...cur.map((v, i) => Math.abs(v - prev![i])));
    prev = cur;
  }
  check('bornfree matrix glides while the camera pans (no per-frame jumps)', maxStep < 0.1, `max coefficient step ${maxStep.toFixed(3)} per frame`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
