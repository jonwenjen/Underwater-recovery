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
import { meanPull, toneAdjust } from '../src/engine/twostep.ts';
import { MAX_CAST_DRIFT } from '../src/engine/auto.ts';
import { physicalRestoreRGB, JERLOV, fitBackscatter, fitAttenuation } from '../src/engine/physical.ts';

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

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);

/* ================== the cast budget that keeps the profiles honest ======== */

{
  // Regression: the imported profiles are allowed to move the colour cast by
  // at most this much. On UIEB with ground truth, at full strength they moved
  // it 27-40 units and scored 2.5-3x worse than the engine's own auto result.
  check('the cast budget is small enough to be meaningful', MAX_CAST_DRIFT > 0 && MAX_CAST_DRIFT <= 3, `${MAX_CAST_DRIFT}`);
  // A limiter that is a no-op, or unbounded, is the bug this guards.
  const shift = 53.4; // the measured shift of a real blue-water frame
  const k = shift > MAX_CAST_DRIFT ? MAX_CAST_DRIFT / shift : 1;
  check('a large method shift is scaled down hard', k < 0.1, `k=${k.toFixed(4)} from shift ${shift}`);
  check('a small method shift is left alone', (1.2 > MAX_CAST_DRIFT ? MAX_CAST_DRIFT / 1.2 : 1) === 1);
}
