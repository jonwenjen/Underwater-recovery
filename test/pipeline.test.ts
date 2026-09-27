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

// Node has no ImageData; the pipeline only needs {width,height,data}.
class NodeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(a: number | Uint8ClampedArray, b?: number, c?: number) {
    if (typeof a === 'number') {
      this.width = a;
      this.height = b!;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    } else {
      this.data = a;
      this.width = b!;
      this.height = c!;
    }
  }
}
// @ts-expect-error test shim
globalThis.ImageData = NodeImageData;
type ImageData = NodeImageData;

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
const a = analyse(src);
const out = runPipeline(src, autoParams({ ...DEFAULT_PARAMS }, a), a).image;

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
const ga = analyse(grey);
const gOut = runPipeline(grey, { ...DEFAULT_PARAMS, auto: false }, ga).image;
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

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);