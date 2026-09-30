/**
 * Reverse-engineer a colour-restoration app from its before/after pairs.
 *
 *   node scripts/analyze-transfer.mjs <dir>            # *-before.* / *-after.* pairs
 *   node scripts/analyze-transfer.mjs <dir> --selftest # prove it recovers a known map
 *
 * What it recovers, and what it cannot
 * ------------------------------------
 * If the transform is per-pixel (which most colour correction is) and the two
 * images are pixel-registered, the transfer function is not a guess — it is a
 * measurable object. Collecting (in_R, out_R) over every pixel gives the red
 * tone curve exactly. Solving for out = M·in + off over many colours gives the
 * 3x3 matrix exactly. Whatever residual is left over after that is the part
 * that is not per-pixel, and the shape of that residual says what it is.
 *
 * It does NOT recover model weights. Proving no parametric form fits only
 * proves the pipeline is not classical; a network stays a black box whose
 * behaviour you can measure but whose internals you cannot read.
 *
 * Practical notes: feed ORIGINALS, not screenshots — JPEG artefacts corrupt
 * the curve at the 1-2 level — and the images must be the same dimensions.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/* ------------------------------------------------------- linear algebra */
function solve(A, b) {
  const n = b.length;
  // forward elimination with partial pivoting
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n - 1; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    const t = M[col]; M[col] = M[piv]; M[piv] = t;
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  if (Math.abs(M[n - 1][n - 1]) < 1e-12) return null;
  // back substitution
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s2 = M[r][n];
    for (let k = r + 1; k < n; k++) s2 -= M[r][k] * x[k];
    x[r] = s2 / M[r][r];
  }
  return x;
}

/** Least squares fit of out = A·x + d, returns coefficients + residual stats. */
function fit(A, out) {
  // The model has k+1 unknowns (k weights plus an offset), so the design
  // matrix is augmented with a constant column and the normal equations are
  // (k+1)x(k+1). Slicing the offset row/column off instead fits a k-parameter
  // model to k+1 parameters, which returns garbage coefficients with no error.
  const k = A[0].length;
  const m = k + 1;
  const M = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (let i = 0; i < A.length; i++) {
    for (let a = 0; a < m; a++) {
      const xa = a < k ? A[i][a] : 1;
      for (let b = 0; b < m; b++) {
        M[a][b] += xa * (b < k ? A[i][b] : 1);
      }
      M[a][m] += xa * out[i];
    }
  }
  const co = solve(
    M.map((r) => r.slice(0, m)),
    M.map((r) => r[m]),
  );
  if (!co) return null;
  let se = 0;
  for (let i = 0; i < A.length; i++) {
    let v = co[k];
    for (let a = 0; a < k; a++) v += co[a] * A[i][a];
    se += (out[i] - v) ** 2;
  }
  let mean = 0;
  for (let i = 0; i < out.length; i++) mean += out[i];
  mean /= out.length;
  let st = 0;
  for (let i = 0; i < out.length; i++) st += (out[i] - mean) ** 2;
  return { co, rmse: Math.sqrt(se / A.length), r2: st > 0 ? 1 - se / st : 0 };
}

/* ------------------------------------------------ decode in the browser */
const PAGE = `<!doctype html><meta charset=utf8><body></body>`;

async function makePage(browser) {
  const page = await browser.newPage();
  await page.setContent(PAGE);
  await page.addScriptTag({
    content: `
window.__decode = async (b64) => {
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([u]), { colorSpaceConversion: 'none' });
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  g.drawImage(bmp, 0, 0);
  return { w: c.width, h: c.height, px: Array.from(g.getImageData(0,0,c.width,c.height).data) };
};
window.__synth = (w, h, seed) => {
  // deterministic pseudo-random image with wide colour coverage
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const img = new ImageData(w, h);
  for (let i = 0; i < w*h; i++) {
    const k = (i*4)|0;
    img.data[k]   = (rnd()*256)|0;
    img.data[k+1] = (rnd()*256)|0;
    img.data[k+2] = (rnd()*256)|0;
    img.data[k+3] = 255;
  }
  return img;
};`,
  });
  return page;
}

const b64 = (p) => readFileSync(p).toString('base64');

/* --------------------------------------------------------- the analysis */
/** Everything we can learn from one before/after pair. */
function analyzePair(before, after) {
  const { w, h, px: A } = before;
  const B = after.px;
  if (after.w !== w || after.h !== h) return { error: `size mismatch ${w}x${h} vs ${after.w}x${after.h}` };

  // 256-bin per-channel curves
  const curve = [0, 1, 2].map((_, c) => {
    const s = new Float64Array(256), n = new Float64Array(256);
    for (let i = 0; i < A.length; i += 4) {
      if (A[i + 3] === 0) continue;
      s[A[i + c]] += B[i + c];
      n[A[i + c]]++;
    }
    const out = new Float64Array(256);
    for (let i = 0; i < 256; i++) out[i] = n[i] ? s[i] / n[i] : NaN;
    return out;
  });

  // Fit every output channel against all three input channels. If the red
  // output depends on green/blue there is a 3x3 matrix in the pipeline, and we
  // can solve for it exactly rather than guess at it.
  const Xf = [], Yr = [], Yg = [], Yb = [];
  for (let i = 0; i < A.length; i += 4) {
    if (A[i + 3] === 0) continue;
    const r = A[i] / 255, g = A[i + 1] / 255, b = A[i + 2] / 255;
    Xf.push([r, g, b]);
    Yr.push(B[i] / 255); Yg.push(B[i + 1] / 255); Yb.push(B[i + 2] / 255);
  }
  const fits = [fit(Xf, Yr), fit(Xf, Yg), fit(Xf, Yb)];
  const diagFits = [fit(Xf.map((x) => [x[0]]), Yr), fit(Xf.map((x) => [x[1]]), Yg), fit(Xf.map((x) => [x[2]]), Yb)];

  // Sampled in/out pairs, kept for the human-readable gain table.
  const gains = [0, 1, 2].map((c) => {
    const out = [];
    for (let v = 8; v < 248; v += 8) {
      if (!Number.isNaN(curve[c][v])) out.push([v, curve[c][v]]);
    }
    return out;
  });

  // Cast, plus a horizontal-band breakdown (depth awareness shows up here)
  const castOf = (px, i) => px[i + 2] - (px[i] + px[i + 1]) / 2;
  let ci = 0, co = 0, cn = 0;
  for (let i = 0; i < A.length; i += 4) {
    if (A[i + 3] === 0) continue;
    ci += castOf(A, i); co += castOf(B, i); cn++;
  }
  ci /= cn; co /= cn;
  const bands = [];
  const NB = 8;
  for (let b = 0; b < NB; b++) {
    const y0 = Math.floor((b * h) / NB), y1 = Math.floor(((b + 1) * h) / NB);
    let si = 0, so = 0, k = 0;
    for (let y = y0; y < y1; y += 2)
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        if (A[i + 3] === 0) continue;
        si += castOf(A, i); so += castOf(B, i); k++;
      }
    if (k) bands.push({ band: b, inCast: si / k, outCast: so / k, fix: si / k - so / k });
  }

  // Hallucination / shadow behaviour: what comes out where the input is black
  let blackIn = 0, blackOut = 0, blackN = 0, lift = 0;
  for (let i = 0; i < A.length; i += 4) {
    if (A[i + 3] === 0) continue;
    if (A[i] < 4 && A[i + 1] < 4 && A[i + 2] < 4) {
      blackIn += (A[i] + A[i + 1] + A[i + 2]) / 3;
      blackOut += (B[i] + B[i + 1] + B[i + 2]) / 3;
      lift += (B[i] + B[i + 1] + B[i + 2]) / 3;
      blackN++;
    }
  }
  // clipping
  let clipHi = 0, clipLo = 0;
  for (let i = 0; i < B.length; i += 4) if (B[i] >= 254 || B[i + 1] >= 254 || B[i + 2] >= 254) clipHi++;
  const pxN = A.length / 4;
  for (let i = 0; i < B.length; i += 4) if (B[i] <= 1 && B[i + 1] <= 1 && B[i + 2] <= 1) clipLo++;
  void blackIn;

  // Spatial residual: after the global 3x3 fit, is the error structured?
  let spatialVar = 0, spatialMean = 0;
  const rowRes = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0, k = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (A[i + 3] === 0) continue;
      const c0 = fits[0].co;
      const p = c0[0] + c0[1] * (A[i] / 255) + c0[2] * (A[i + 1] / 255) + c0[3] * (A[i + 2] / 255);
      s += B[i] / 255 - p; k++;
    }
    rowRes[y] = k ? s / k : 0;
    spatialMean += rowRes[y];
    spatialVar += rowRes[y] ** 2;
  }
  spatialMean /= h;

  return {
    w, h,
    curve: curve.map((c) => Array.from(c)),
    gains,
    diag: diagFits[0] ? { co: diagFits[0].co, rmse: diagFits[0].rmse, r2: diagFits[0].r2 } : null,
    full: fits[0] ? { co: fits[0].co, rmse: fits[0].rmse, r2: fits[0].r2 } : null,
    M: fits.every((x) => x) ? fits.map((x) => x.co) : null,
    castIn: ci, castOut: co, castFix: ci - co,
    bands,
    blackLift: blackN ? lift / blackN : 0,
    blackFrac: blackN / pxN,
    clipHi: clipHi / pxN, clipLo: clipLo / pxN,
    rowResidualSpread: Math.sqrt(spatialVar / h - spatialMean ** 2),
  };
}

/* ------------------------------------------------------------- reporting */
const f = (x, n = 2) => (x === null || x === undefined || Number.isNaN(x) ? '  —  ' : Number(x).toFixed(n));

function report(r, name) {
  const L = [];
  L.push(`\n━━ ${name}  (${r.w}×${r.h})`);
  L.push(`  cast: in ${f(r.castIn, 1)} → out ${f(r.castOut, 1)}   (fix ${f(r.castFix, 1)})`);
  const gainAt = (c, v) => {
    const g = r.gains[c];
    let best = null, bd = 1e9;
    for (const [iv, ov] of g) { const d = Math.abs(iv - v); if (d < bd) { bd = d; best = [iv, ov]; } }
    return best;
  };
  L.push('  per-channel gain  (out/in at in=64 / 128 / 192)');
  for (const [c, nm] of [[0, 'R'], [1, 'G'], [2, 'B']]) {
    const cells = [64, 128, 192].map((v) => {
      const b = gainAt(c, v);
      return b ? `${b[0]}→${f(b[1], 0)}` : '—';
    });
    L.push(`    ${nm}  ${cells.join('   ')}`);
  }
  L.push(`  red fit  diagonal R² ${f(r.diag?.r2, 4)}  rmse ${f(r.diag?.rmse, 4)}`);
  L.push(`  red fit  full 3×3  R² ${f(r.full?.r2, 4)}  rmse ${f(r.full?.rmse, 4)}`);
  if (r.M) {
    L.push('          recovered 3x3 (rows = out channel):');
    const nm = ['R', 'G', 'B'];
    for (let row = 0; row < 3; row++) {
      const c = r.M[row];
      L.push(`            ${nm[row]}  [${c.slice(0, 3).map((v) => f(v, 4)).join(', ')}]  offset ${f(c[3], 4)}`);
    }
  }
  const dGain = r.diag && r.full ? r.full.r2 - r.diag.r2 : 0;
  L.push(`  cross-channel value: ΔR² ${f(dGain, 4)}  ${dGain > 0.002 ? '→ there IS a 3×3 matrix' : '→ red output looks independent of G/B'}`);
  L.push(`  shadow lift (in<4 → out): ${f(r.blackLift, 2)} over ${(r.blackFrac * 100).toFixed(1)}% of pixels`);
  L.push(`  clipping: hi ${(r.clipHi * 100).toFixed(2)}%  lo ${(r.clipLo * 100).toFixed(2)}%`);
  L.push(`  row-residual spread ${f(r.rowResidualSpread, 4)}  (large ⇒ spatially varying ⇒ depth/local info used)`);
  L.push('  band  in-cast  out-cast   fixed');
  for (const b of r.bands) L.push(`   ${b.band}   ${f(b.inCast, 1).padStart(7)}  ${f(b.outCast, 1).padStart(7)}  ${f(b.fix, 1).padStart(6)}`);
  return L.join('\n');
}

/* ------------------------------------------------------------- self test */
async function selftest(page) {
  // Ground truth. The input range is kept low enough that the map never
  // clips: if it does, 50% of the samples are pinned at 255 and the fit is
  // fit to clamped data, which silently makes every recovery look wrong.
  const M_T = [
    [1.35, 0.05, -0.12],
    [-0.08, 1.15, 0.02],
    [-0.10, -0.06, 1.30],
  ];
  const OFF = 4;
  const W = 480, H = 320;
  const before = await page.evaluate(([w, h]) => {
    let s = 12345;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const img = new ImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const k = i * 4;
      img.data[k] = (rnd() * 170) | 0;
      img.data[k + 1] = (rnd() * 170) | 0;
      img.data[k + 2] = (rnd() * 170) | 0;
      img.data[k + 3] = 255;
    }
    return { w, h, px: Array.from(img.data) };
  }, [W, H]);

  const runMap = (post) => {
    const out = new Array(before.px.length);
    for (let i = 0; i < before.px.length; i += 4) {
      const inp = [before.px[i], before.px[i + 1], before.px[i + 2]];
      let v = M_T.map((row) => row[0] * inp[0] + row[1] * inp[1] + row[2] * inp[2] + OFF);
      if (post) v = post(v);
      for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, v[c]));
      out[i + 3] = 255;
    }
    return { w: W, h: H, px: out };
  };

  const rLin = analyzePair(before, runMap(null));
  console.log('GROUND TRUTH  M =');
  M_T.forEach((row, i) => console.log('   ', ['R','G','B'][i], row.map((v) => v.toFixed(3)).join(', ')));
  console.log(report(rLin, 'recovered'));

  const want = M_T.flat();
  let worst = 0;
  for (let row = 0; row < 3; row++) {
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(rLin.M[row][c] - want[row * 3 + c]));
  }
  const exact = worst < 0.02;
  const crossOk = rLin.full.r2 - rLin.diag.r2 > 0.002;
  const noClip = rLin.clipHi < 0.01;
  console.log(`\n${exact ? 'PASS' : 'FAIL'} full 3x3 recovered to ${worst.toFixed(6)} absolute (out-in units)`);
  console.log(`${crossOk ? 'PASS' : 'FAIL'} cross-channel term detected  ΔR² ${(rLin.full.r2 - rLin.diag.r2).toFixed(4)}`);
  console.log(`${noClip ? 'PASS' : 'FAIL'} no clipping in ground truth  ${(rLin.clipHi * 100).toFixed(2)}%`);

  // A gamma after the matrix must show up as residual the linear fit cannot absorb.
  const GAMMA = 0.85;
  const rGam = analyzePair(before, runMap((v) => v.map((x) => 255 * Math.pow(Math.max(0, x) / 255, GAMMA))));
  const nonlin = rGam.full.rmse > rLin.full.rmse * 3;
  console.log(`${nonlin ? 'PASS' : 'FAIL'} non-linearity detected  rmse ${rLin.full.rmse.toExponential(2)} (linear) -> ${rGam.full.rmse.toExponential(2)} (gamma ${GAMMA})`);

  return exact && crossOk && nonlin && noClip;
}

/* ------------------------------------------------------------------ main */
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const DIR = args[0];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await makePage(browser);

try {
  if (flags.includes('--selftest')) {
    const ok = await selftest(page);
    process.exit(ok ? 0 : 1);
  }
  if (!DIR) {
    console.error('usage: node scripts/analyze-transfer.mjs <dir> [--selftest]');
    console.error('  expects  NAME-before.jpg  NAME-after.jpg  pairs in <dir>');
    process.exit(2);
  }
  const files = readdirSync(DIR);
  const pairs = [];
  for (const f of files) {
    if (!EXT.has(extname(f).toLowerCase()) || !f.includes('-before')) continue;
    const after = f.replace('-before', '-after');
    if (files.includes(after)) pairs.push([f, after]);
  }
  if (!pairs.length) {
    console.error(`no *-before.* / *-after.* pairs found in ${DIR}`);
    console.error('found:', files.filter((f) => EXT.has(extname(f).toLowerCase())).slice(0, 20));
    process.exit(2);
  }
  const results = [];
  for (const [bf, af] of pairs) {
    const b = await page.evaluate((d) => window.__decode(d), b64(join(DIR, bf)));
    const a = await page.evaluate((d) => window.__decode(d), b64(join(DIR, af)));
    const r = analyzePair(b, a);
    if (r.error) { console.error(`${bf}: ${r.error}`); continue; }
    r.name = basename(bf, extname(bf));
    results.push(r);
    console.log(report(r, r.name));
  }
  if (results.length) {
    const mean = (k) => results.reduce((a, r) => a + r[k], 0) / results.length;
    console.log(`\n━━ across ${results.length} pair(s)`);
    console.log(`  mean cast fix ${f(mean('castFix'), 1)}   mean cross-channel ΔR² ${f(results.reduce((a,r)=>a+(r.full.r2-r.diag.r2),0)/results.length, 4)}`);
    console.log(`  mean shadow lift ${f(mean('blackLift'), 2)}   mean row-residual spread ${f(mean('rowResidualSpread'), 4)}`);
  }
  mkdirSync(join(HERE, '..', 'verify-output'), { recursive: true });
  writeFileSync(join(HERE, '..', 'verify-output', 'transfer-analysis.json'), JSON.stringify(results, null, 2));
  console.log('\nwrote verify-output/transfer-analysis.json');
} finally {
  await browser.close();
}
void existsSync;
