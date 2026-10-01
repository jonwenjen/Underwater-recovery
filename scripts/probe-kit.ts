/**
 * Probe kit: run another underwater app (e.g. Diverout) on exactly the probe
 * materials of scripts/probes.ts, then score its outputs with the same
 * metrics, side by side with ours.
 *
 *   node --experimental-strip-types scripts/probe-kit.ts export <kitDir>
 *       PNG stills (4× size) + H.264 MP4 clips (needs ffmpeg: FFMPEG=… or in PATH)
 *   node --experimental-strip-types scripts/probe-kit.ts compare <kitDir> <outputsDir>
 *       <outputsDir> holds the app's results under the SAME base names
 *       (1-chart.jpg, 5-clip-black.mp4, …; any of png/jpg/jpeg/webp/mp4/mov)
 *
 * Images are decoded in Chromium (Playwright) and area-averaged back to the
 * probe size; clips are decoded with ffmpeg. Save the app's results at full
 * quality (JPEG "Most Compatible", not HEIC; no screenshots).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { PROBES, type Probe } from './probe-materials.ts';
import { chartMetrics, depthMetrics, impulseMetrics, oodMetrics, rampMetrics, runAll } from './probes.ts';

type Img = { px: Uint8ClampedArray; w: number; h: number };
const SCALE = 4;

/* ---------------------------------------------------------------- PNG */
function png(im: Img): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(im.w, 0);
  ihdr.writeUInt32BE(im.h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = Buffer.alloc((im.w * 4 + 1) * im.h);
  for (let y = 0; y < im.h; y++) {
    raw[y * (im.w * 4 + 1)] = 0;
    Buffer.from(im.px.buffer, im.px.byteOffset + y * im.w * 4, im.w * 4).copy(raw, y * (im.w * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const up = (im: Img, k: number): Img => {
  const w = im.w * k, h = im.h * k, px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(im.px.subarray(((y / k | 0) * im.w + (x / k | 0)) * 4, ((y / k | 0) * im.w + (x / k | 0)) * 4 + 4), (y * w + x) * 4);
  return { px, w, h };
};
/** Area-average down to w × h (the app may return any size). */
const down = (im: Img, w: number, h: number): Img => {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * im.w) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * im.w) / w));
      const y0 = Math.floor((y * im.h) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * im.h) / h));
      const s = [0, 0, 0];
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) for (let c = 0; c < 3; c++) s[c] += im.px[(yy * im.w + xx) * 4 + c];
      const n = (x1 - x0) * (y1 - y0);
      px.set([s[0] / n, s[1] / n, s[2] / n, 255], (y * w + x) * 4);
    }
  return { px, w, h };
};
const flip = (im: Img, axis: 'v' | 'h'): Img => {
  const px = new Uint8ClampedArray(im.px.length);
  for (let y = 0; y < im.h; y++)
    for (let x = 0; x < im.w; x++) {
      const j = axis === 'v' ? ((im.h - 1 - y) * im.w + x) * 4 : (y * im.w + (im.w - 1 - x)) * 4;
      px.set(im.px.subarray((y * im.w + x) * 4, (y * im.w + x) * 4 + 4), j);
    }
  return { px, w: im.w, h: im.h };
};

const ffmpeg = () => {
  for (const c of [process.env.FFMPEG, 'ffmpeg'].filter(Boolean) as string[]) {
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* next */
    }
  }
  return null;
};

/** The kit's files: name → image (stills) or frames (clips). */
function kit() {
  const P = Object.fromEntries(PROBES().map((p) => [p.name, p])) as Record<string, Probe>;
  const stills: Record<string, Img> = {};
  for (const n of ['1-chart', '1-ramps', '2-depth-ramp', '3-grey-wedge', '3-land', '6-scene', '6-scene-surface']) stills[n] = up(P[n].img, SCALE);
  for (const n of ['6-scene', '6-scene-surface']) {
    stills[`${n}-vflip`] = up(flip(P[n].img, 'v'), SCALE);
    stills[`${n}-hflip`] = up(flip(P[n].img, 'h'), SCALE);
  }
  // the impulse stays a true 3 × 3 dot, on a 768² canvas
  const imp = { w: 768, h: 768, px: new Uint8ClampedArray(768 * 768 * 4) };
  for (let i = 0; i < 768 * 768; i++) imp.px.set([0, 128, 128, 255], i * 4);
  for (let y = 383; y <= 385; y++) for (let x = 383; x <= 385; x++) imp.px.set([255, 255, 255, 255], (y * 768 + x) * 4);
  stills['4-impulse'] = imp;
  const bg = { w: 768, h: 768, px: imp.px.slice() };
  for (let y = 383; y <= 385; y++) for (let x = 383; x <= 385; x++) bg.px.set([0, 128, 128, 255], (y * 768 + x) * 4);
  stills['4-impulse-bg'] = bg;
  const frames = P['5-clip'].frames!;
  const black = { ...frames[15], px: new Uint8ClampedArray(frames[15].px.length).map((_, i) => (i % 4 === 3 ? 255 : 0)) };
  const clips: Record<string, Img[]> = {
    '5-clip': frames.map((f) => up(f, SCALE)),
    '5-clip-black': frames.map((f, i) => up(i === 15 ? black : f, SCALE)),
    '5-clip-land': frames.map((f, i) => up(i === 15 ? P['5-land-frame'].img : f, SCALE)),
  };
  return { P, stills, clips };
}

/* -------------------------------------------------------------- export */
function exportKit(dir: string) {
  mkdirSync(dir, { recursive: true });
  const { P, stills, clips } = kit();
  for (const [n, im] of Object.entries(stills)) writeFileSync(join(dir, `${n}.png`), png(im));
  const ff = ffmpeg();
  for (const [n, fr] of Object.entries(clips)) {
    if (!ff) {
      mkdirSync(join(dir, n), { recursive: true });
      fr.forEach((f, i) => writeFileSync(join(dir, n, `${String(i).padStart(3, '0')}.png`), png(f)));
      continue;
    }
    const raw = Buffer.concat(fr.map((f) => Buffer.from(f.px.buffer, f.px.byteOffset, f.px.byteLength)));
    execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${fr[0].w}x${fr[0].h}`, '-r', '30', '-i', '-',
      '-c:v', 'libx264', '-crf', '12', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(dir, `${n}.mp4`)], { input: raw });
  }
  const lines = [
    'Underwater probe kit — 用另一個 App 處理這些檔案，存成同名（副檔名可不同）的檔案放到一個資料夾，再執行：',
    '  node --experimental-strip-types scripts/probe-kit.ts compare <這個資料夾> <App 輸出資料夾>',
    '用最高畫質存檔（JPEG／「最相容」，不要 HEIC，不要截圖）；強度用 App 預設值，全部同一設定。',
    '',
    ...Object.keys(stills).map((n) => `${n}.png  ${(P[n.replace(/-(vflip|hflip|bg)$/, '')] ?? P[n])?.purpose ?? ''}${n.endsWith('flip') ? '（翻轉版）' : n.endsWith('-bg') ? '（無白點的背景，對照用）' : ''}`),
    `5-clip.mp4 / 5-clip-black.mp4 / 5-clip-land.mp4  ${P['5-clip'].purpose}`,
  ];
  writeFileSync(join(dir, 'README.txt'), lines.join('\n') + '\n');
  console.log(`kit → ${dir}: ${Object.keys(stills).length} images, ${Object.keys(clips).length} clips${ff ? ' (MP4)' : ' (PNG frame folders: no ffmpeg)'}`);
}

/* ------------------------------------------------------------- compare */
async function decodeStills(files: string[]): Promise<Record<string, Img>> {
  const { chromium } = await import('playwright');
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const p = await b.newPage();
  const out: Record<string, Img> = {};
  for (const f of files) {
    const r = await p.evaluate(async (b64: string) => {
      const bin = atob(b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([u]), { colorSpaceConversion: 'none' });
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      return { w: bmp.width, h: bmp.height, px: Array.from(g.getImageData(0, 0, bmp.width, bmp.height).data) };
    }, readFileSync(f).toString('base64'));
    out[f] = { px: Uint8ClampedArray.from(r.px), w: r.w, h: r.h };
  }
  await b.close();
  return out;
}
function decodeClip(file: string, w: number, h: number): Img[] {
  const ff = ffmpeg();
  if (!ff) throw new Error('ffmpeg is needed to read clips (FFMPEG=… or in PATH)');
  const buf = execFileSync(ff, ['-loglevel', 'error', '-i', file, '-vf', `scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 30 });
  const n = Math.floor(buf.length / (w * h * 4));
  return Array.from({ length: n }, (_, i) => ({ px: new Uint8ClampedArray(buf.buffer, buf.byteOffset + i * w * h * 4, w * h * 4), w, h }));
}
const meanAbs = (a: Img, b: Img) => {
  let s = 0;
  for (let i = 0; i < a.px.length; i += 4) for (let c = 0; c < 3; c++) s += Math.abs(a.px[i + c] - b.px[i + c]);
  return s / ((a.px.length / 4) * 3);
};
const flipDiff = (a: Img, b: Img, axis: 'v' | 'h') => meanAbs(a, flip(b, axis));

async function compare(kitDir: string, appDir: string) {
  // the kit is regenerated from the same seeds; this only catches a wrong argument order
  if (!existsSync(join(kitDir, 'README.txt'))) console.warn(`warning: ${kitDir} does not look like a probe kit (no README.txt)`);
  const { P } = kit();
  const find = (n: string, exts: string[]) => {
    for (const f of readdirSync(appDir)) if (f.replace(/\.[^.]+$/, '') === n && exts.includes(f.split('.').pop()!.toLowerCase())) return join(appDir, f);
    return null;
  };
  const IMG = ['png', 'jpg', 'jpeg', 'webp'], VID = ['mp4', 'mov', 'm4v'];
  const names = ['1-chart', '1-ramps', '2-depth-ramp', '3-grey-wedge', '3-land', '4-impulse', '4-impulse-bg', '6-scene', '6-scene-vflip', '6-scene-hflip', '6-scene-surface', '6-scene-surface-vflip', '6-scene-surface-hflip'];
  const files = Object.fromEntries(names.map((n) => [n, find(n, IMG)]).filter(([, f]) => f)) as Record<string, string>;
  const dec = await decodeStills(Object.values(files));
  const get = (n: string) => (files[n] ? dec[files[n]] : null);
  const at = (n: string) => {
    const im = get(n);
    const ref = P[n.replace(/-(vflip|hflip)$/, '')]?.img;
    return im && ref ? down(im, ref.w, ref.h) : null;
  };
  const ours = runAll() as any;
  const row = (label: string, theirs: string, our: string) => console.log(`${label.padEnd(34)} ${theirs.padEnd(28)} ${our}`);
  console.log(`${''.padEnd(34)} ${'app'.padEnd(28)} ours (全自動)`);
  const f3 = (x: number) => x.toFixed(3);
  if (at('1-chart')) {
    const c = chartMetrics(P['1-chart'], at('1-chart')!, P['1-chart'].img);
    row('1 chart ΔE (raw → out)', `${f3(c.chartDeltaE.raw)} → ${f3(c.chartDeltaE.out)}`, `${f3(ours.chart.chartDeltaE.raw)} → ${f3(ours.chart.chartDeltaE.out)}`);
    row('  grey patches chroma', c.greyChroma.toFixed(4), ours.chart.greyChroma.toFixed(4));
  }
  if (at('1-ramps')) {
    const r = rampMetrics(P['1-ramps'], at('1-ramps')!);
    row('  ramps: row spread / max extra step', `${r.rampRowSpreadLevels.toFixed(1)} / ${r.rampMaxExtraJumpLevels.toFixed(1)}`, `${ours.chart.rampRowSpreadLevels.toFixed(1)} / ${ours.chart.rampMaxExtraJumpLevels.toFixed(1)}`);
  }
  if (at('2-depth-ramp')) {
    const d = depthMetrics(P['2-depth-ramp'], at('2-depth-ramp')!, P['2-depth-ramp'].img);
    d.forEach((o, i) => row(`2 depth ${o.d} m ΔE (raw → out)`, `${f3(o.rawDeltaE)} → ${f3(o.outDeltaE)}`, `${f3(ours.depth[i].rawDeltaE)} → ${f3(ours.depth[i].outDeltaE)}`));
  }
  if (at('3-grey-wedge')) {
    const w = oodMetrics(P['3-grey-wedge'], at('3-grey-wedge')!, P['3-grey-wedge'].img);
    row('3 grey wedge: max chroma / change', `${w.maxChroma.toFixed(4)} / ${f3(w.meanChangeDeltaE)}`, `${ours.greyWedge.maxChroma.toFixed(4)} / ${f3(ours.greyWedge.meanChangeDeltaE)}`);
  }
  if (at('3-land')) row('  land photo change ΔE', f3(oodMetrics(P['3-land'], at('3-land')!, P['3-land'].img).meanChangeDeltaE), f3(ours.land.meanChangeDeltaE));
  if (get('4-impulse') && get('4-impulse-bg')) {
    const a = get('4-impulse')!, b = get('4-impulse-bg')!;
    const i = impulseMetrics({ meta: { cx: Math.round((a.w * 384) / 768), cy: Math.round((a.h * 384) / 768) } } as Probe, a, b.w === a.w ? b : down(b, a.w, a.h));
    row('4 impulse spread radius (px of 768)', ((i.spreadRadiusPx * 768) / a.w).toFixed(1), `${((ours.impulse.spreadRadiusPx * 768) / 192).toFixed(1)} (scaled from 192)`);
  }
  for (const s of ['6-scene', '6-scene-surface']) {
    const o = at(s), v = at(`${s}-vflip`), h = at(`${s}-hflip`);
    if (o && v && h) row(`6 flip ${s} v / h (levels)`, `${flipDiff(o, v, 'v').toFixed(2)} / ${flipDiff(o, h, 'h').toFixed(2)}`, `${ours[`flip_${s}`].vertical.toFixed(2)} / ${ours[`flip_${s}`].horizontal.toFixed(2)}`);
  }
  const clip = (n: string) => {
    const f = find(n, VID);
    return f ? decodeClip(f, 256, 144) : null;
  };
  const ref = clip('5-clip');
  if (ref) {
    for (const k of ['black', 'land']) {
      const c = clip(`5-clip-${k}`);
      if (!c) continue;
      const d = c.slice(16, 24).map((fr, i) => (ref[16 + i] ? meanAbs(fr, ref[16 + i]) : NaN));
      row(`5 ${k} frame: frames 16–23 vs clean clip`, d.map((x) => x.toFixed(1)).join(' '), `${ours[`temporal_${k}`].diffs.slice(0, 8).map((x: number) => x.toFixed(1)).join(' ')}`);
    }
    console.log('  (0 from frame 16 on ⇒ frames graded independently or the tracker snaps on cuts; a slowly decaying difference ⇒ temporal memory)');
  }
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'export' && a) exportKit(a);
else if (cmd === 'compare' && a && b) await compare(a, b);
else console.log('usage: probe-kit.ts export <kitDir> | compare <kitDir> <appOutputsDir>');
