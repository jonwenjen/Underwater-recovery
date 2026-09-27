/**
 * Node-side pipeline test. Runs the real pipeline.ts over a synthetic
 * "underwater" image and asserts the four recovery goals numerically.
 *   node --experimental-strip-types test/pipeline.test.ts
 */
import {
  analyse,
  process as runPipeline,
  DEFAULT_PARAMS,
  autoParams,
} from '../src/pipeline.ts';

// Node has no ImageData; the pipeline only needs {width, height, data}.
import {
  NodeImageData as ImageData,
  installImageDataShim,
  asImg,
} from './shim.ts';
installImageDataShim();

const W = 240,
  H = 160;

function makeUnderwater(): ImageData {
  const img = new ImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // base scene: warm-ish subject (red coral) fading into blue-green haze
      // with depth = y, and low contrast texture to represent water fog.
      const depth = y / H;
      const texture = 18 * Math.sin(x / 7) * Math.cos(y / 11);
      const redSubject = x < W * 0.35 ? 150 : 20;
      let r = (redSubject + texture) * (1 - depth * 0.75);
      let g = (90 + texture) * (1 - depth * 0.4);
      let b = (70 + texture) * (1 + depth * 0.55);
      // backscatter haze: adds a uniform bluish veil
      r += 18 + depth * 22;
      g += 55 + depth * 40;
      b += 85 + depth * 55;
      d[i] = Math.max(0, Math.min(255, r));
      d[i + 1] = Math.max(0, Math.min(255, g));
      d[i + 2] = Math.max(0, Math.min(255, b));
      d[i + 3] = 255;
    }
  }
  return img;
}

const stats = (img: ImageData) => {
  const d = img.data;
  let r = 0,
    g = 0,
    b = 0,
    l = 0,
    l2 = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
    const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    l += y;
    l2 += y * y;
  }
  return {
    r: r / n,
    g: g / n,
    b: b / n,
    blueDominance: b / n - (r / n + g / n) / 2,
    contrast: Math.sqrt(Math.max(0, l2 / n - (l / n) ** 2)),
  };
};

const src = makeUnderwater();
const a = analyse(asImg(src));
const out = runPipeline(
  asImg(src),
  autoParams({ ...DEFAULT_PARAMS }, a),
  a,
).image;

const before = stats(src);
const after = stats(out);

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures++;
};

console.log('analysis:', {
  isUnderwater: a.isUnderwater.toFixed(2),
  blueDominance: a.blueDominance.toFixed(1),
  contrast: a.contrast.toFixed(3),
});
console.log('before:', {
  r: before.r.toFixed(1),
  g: before.g.toFixed(1),
  b: before.b.toFixed(1),
  blueDom: before.blueDominance.toFixed(1),
  contrast: before.contrast.toFixed(1),
});
console.log('after: ', {
  r: after.r.toFixed(1),
  g: after.g.toFixed(1),
  b: after.b.toFixed(1),
  blueDom: after.blueDominance.toFixed(1),
  contrast: after.contrast.toFixed(1),
});

check(
  'underwater detector fires',
  a.isUnderwater > 0.5,
  `isUnderwater=${a.isUnderwater.toFixed(2)}`,
);
check(
  'blue cast reduced',
  after.blueDominance < before.blueDominance - 15,
  `${before.blueDominance.toFixed(1)} -> ${after.blueDominance.toFixed(1)}`,
);
check(
  'red channel recovered',
  after.r > before.r * 1.15,
  `${before.r.toFixed(1)} -> ${after.r.toFixed(1)}`,
);
check(
  'contrast increased (haze removed)',
  after.contrast > before.contrast * 1.05,
  `${before.contrast.toFixed(1)} -> ${after.contrast.toFixed(1)}`,
);
check(
  'output in range',
  out.data.every((v) => v >= 0 && v <= 255),
  'all bytes valid',
);

// A neutral grey image must survive essentially unchanged (no false positives).
const grey = new ImageData(W, H);
for (let i = 0; i < grey.data.length; i += 4) {
  const v = 128 + 20 * Math.sin(i / 500);
  grey.data[i] = grey.data[i + 1] = grey.data[i + 2] = v;
  grey.data[i + 3] = 255;
}
const ga = analyse(asImg(grey));
const gOut = runPipeline(asImg(grey), { ...DEFAULT_PARAMS, auto: false }, ga).image;
check(
  'grey image not flagged underwater',
  ga.isUnderwater < 0.35,
  `isUnderwater=${ga.isUnderwater.toFixed(2)}`,
);
const gs = stats(gOut);
check(
  'grey stays grey',
  Math.abs(gs.r - gs.b) < 12 && Math.abs(gs.g - gs.b) < 12,
  `r=${gs.r.toFixed(1)} g=${gs.g.toFixed(1)} b=${gs.b.toFixed(1)}`,
);

// A no-op configuration must not structurally change the image. The pipeline
// dithers the final 8-bit write by up to half an LSB, so exact equality no
// longer holds; anything beyond 1 LSB, or a mean shift, is a real regression.
{
  const src = makeUnderwater();
  const noop = {
    ...DEFAULT_PARAMS,
    auto: false,
    redStrength: 0,
    dehazeStrength: 0,
    gamma: 1,
    claheClip: 0,
    sharpenAmount: 0,
    saturation: 1,
    wbStrength: 0,
    warm: 0,
    greenBias: 0,
    // the tone curve is on by default (0.02/0.98); a true no-op opens it up
    blackPoint: 0,
    whitePoint: 1,
  };
  const { image } = runPipeline(asImg(src), noop, analyse(asImg(src)));
  let maxDelta = 0;
  let sumDelta = 0;
  let n = 0;
  for (let i = 0; i < src.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(image.data[i + c] - src.data[i + c]);
      if (d > maxDelta) maxDelta = d;
      sumDelta += d;
      n++;
    }
  }
  const meanDelta = sumDelta / n;
  check(
    'no-op is byte-exact except dither',
    maxDelta <= 1,
    `maxDelta=${maxDelta} LSB`,
  );
  check(
    'no-op has no mean shift',
    meanDelta < 0.5,
    `meanDelta=${meanDelta.toFixed(3)} LSB`,
  );
}

// Smooth underwater gradients are where banding shows. Feed a wide, very gradual
// blue ramp and count the distinct output levels across one row: a float path
// fills the gaps between 8-bit steps, a quantised one leaves them empty.
{
  const gw = 512;
  const gh = 32;
  const grad = new ImageData(gw, gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = (y * gw + x) * 4;
      const t = x / (gw - 1);
      grad.data[i] = 20 + 40 * t;
      grad.data[i + 1] = 60 + 50 * t;
      grad.data[i + 2] = 90 + 60 * t;
      grad.data[i + 3] = 255;
    }
  }
  const { image } = runPipeline(asImg(grad), { ...DEFAULT_PARAMS, auto: false });
  const levels = new Set<number>();
  const row = (gh >> 1) * gw;
  let lo = 255, hi = 0;
  for (let x = 0; x < gw; x++) {
    const v = image.data[(row + x) * 4 + 2];
    levels.add(v);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // A float path fills the gaps between 8-bit steps, so nearly every level in
  // the output range is actually hit. A quantised path plateaus and shows far
  // fewer distinct values across the same 512 samples.
  const span = hi - lo + 1;
  check(
    'no banding in smooth gradient',
    levels.size >= span * 0.75,
    `${levels.size}/${span} distinct levels over 512 samples`,
  );
}

// Regression guard for a real bug: table interpolation at exactly 1.0 read one
// entry past the end, produced NaN, and Uint8ClampedArray stored 0 — so every
// fully clipped channel came out black. Pure white and hard-clipped highlights
// must survive the pipeline.
{
  const sw = 32, sh = 32;
  const swatch = new ImageData(sw, sh);
  for (let i = 0; i < swatch.data.length; i += 4) {
    swatch.data[i] = 255;
    swatch.data[i + 1] = 255;
    swatch.data[i + 2] = 255;
    swatch.data[i + 3] = 255;
  }
  const white = runPipeline(asImg(swatch), { ...DEFAULT_PARAMS, auto: false }).image;
  check(
    'pure white survives',
    white.data[0] > 250 && white.data[1] > 250 && white.data[2] > 250,
    `rgb=${white.data[0]},${white.data[1]},${white.data[2]}`,
  );

  // A single hot pixel surrounded by dim ones: the saturated blue channel must
  // not be driven to zero.
  const spot = new ImageData(sw, sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      const hot = x === 16 && y === 16;
      spot.data[i] = hot ? 255 : 20;
      spot.data[i + 1] = hot ? 255 : 30;
      spot.data[i + 2] = hot ? 255 : 40;
      spot.data[i + 3] = 255;
    }
  }
  const sp = runPipeline(asImg(spot), { ...DEFAULT_PARAMS, auto: false }).image;
  const si = (16 * sw + 16) * 4;
  check(
    'clipped highlight does not go black',
    sp.data[si + 2] > 200,
    `hot pixel blue=${sp.data[si + 2]} (was 255)`,
  );
}

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);