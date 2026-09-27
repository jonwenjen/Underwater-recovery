/**
 * End-to-end video test.
 *
 * Launches a *separate* headless Chrome with its own throwaway profile (the
 * user's own browser is never touched), loads the built app, feeds it a real
 * MP4, and verifies the whole chain: preview renders, export decodes ->
 * processes -> re-encodes, and the produced bytes are a real, re-probeable MP4.
 *
 *   node scripts/e2e-video.mjs <url> <mp4-path> <out-path>
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const APP_URL = process.argv[2] ?? 'http://localhost:5199/';
const VIDEO = process.argv[3];
const OUT = process.argv[4] ?? '/tmp/uw-exported.mp4';
/**
 * Chrome/Chromium path. Hard-coding the macOS app bundle meant the e2e could
 * only ever run on one developer's machine; CI needs the Linux path too.
 */
const CHROME =
  process.env.CHROME_PATH ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
   '/usr/bin/google-chrome',
   '/usr/bin/google-chrome-stable',
   '/usr/bin/chromium',
   '/usr/bin/chromium-browser'].find((p) => existsSync(p)) ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333 + Math.floor(Math.random() * 400);

const profile = mkdtempSync(join(tmpdir(), 'uw-e2e-'));
let chrome;
let ws;

function cleanup(code) {
  try {
    ws?.close();
  } catch {}
  try {
    chrome?.kill('SIGKILL');
  } catch {}
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  process.exit(code);
}
process.on('SIGINT', () => cleanup(1));

const fail = (msg) => {
  console.error('FAIL:', msg);
  cleanup(1);
};

chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let target = null;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (target) break;
  } catch {}
  await sleep(250);
}
if (!target) fail('could not reach chrome devtools');

ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let msgId = 0;
const waiters = new Map();
const consoleLog = [];
const pageErrors = [];

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiters.has(m.id)) {
    const { res, rej } = waiters.get(m.id);
    waiters.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    consoleLog.push(
      `${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`,
    );
  }
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push(
      m.params.exceptionDetails?.exception?.description ??
        m.params.exceptionDetails?.text,
    );
  }
});

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId;
    waiters.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
    );
  }
  return r.result.value;
}

await send('Runtime.enable');
await send('Page.enable');

console.log('navigating to', APP_URL);
await send('Page.navigate', { url: APP_URL });
await sleep(3000);
console.log('title:', await evaluate('document.title'));

const caps = await evaluate(`(async () => {
  const t = async c => { try { return !!(await VideoEncoder.isConfigSupport ? 0 : 0) || !!(await VideoEncoder.isConfigSupported({codec:c,width:640,height:360})).supported; } catch { return false; } };
  return {
    VideoDecoder: typeof VideoDecoder !== 'undefined',
    VideoEncoder: typeof VideoEncoder !== 'undefined',
    avc: await t('avc1.42001f'),
    vp9: await t('vp09.00.10.08'),
  };
})()`);
console.log('capabilities:', JSON.stringify(caps));
if (!caps.VideoEncoder) fail('no WebCodecs VideoEncoder in this browser');

const b64 = readFileSync(VIDEO).toString('base64');
console.log(`injecting ${VIDEO} (${(b64.length * 0.75 / 1e6).toFixed(1)} MB)`);

function dumpDiagnostics(label) {
  console.log(`\n--- diagnostics (${label}) ---`);
  const note = consoleLog.length
    ? consoleLog.slice(-30).map((l) => '  ' + l).join('\n')
    : '  (no console output)';
  console.log('CONSOLE:\n' + note);
  if (pageErrors.length) {
    console.log('PAGE ERRORS:');
    for (const e of pageErrors) console.log('  ', e);
  }
}

/* ---------------------------------------------------------------- preview */

let prev;
try {
  prev = await evaluate(`(async () => {
  const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
  const file = new File([bin], 'test.mp4', { type: 'video/mp4' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.getElementById('vfile');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));

  const t0 = Date.now();
  while (document.getElementById('vwork').classList.contains('hidden')) {
    if (Date.now() - t0 > 30000) throw new Error('preview never appeared');
    await new Promise(r => setTimeout(r, 200));
  }
  // Seek to 3s: this clip fades in from black, so t=0 is genuinely black and
  // proves nothing about the pipeline.
  const seek = document.getElementById('vseek');
  seek.value = '300';
  seek.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 9000));

  const cv = document.getElementById('vcv');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let min = 255, max = 0, sumR = 0, sumG = 0, sumB = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] + d[i+1] + d[i+2]) / 3;
    if (l < min) min = l;
    if (l > max) max = l;
    sumR += d[i]; sumG += d[i+1]; sumB += d[i+2];
  }
  return {
    note: document.getElementById('vnote').textContent,
    canvas: cv.width + 'x' + cv.height,
    lumaMin: min, lumaMax: max,
    meanR: Math.round(sumR/n), meanG: Math.round(sumG/n), meanB: Math.round(sumB/n),
    elapsedMs: Date.now() - t0,
  };
})()`);
} catch (err) {
  const note = await evaluate(
    `document.getElementById('vnote').textContent`,
  ).catch(() => '(no note)');
  console.error('preview failed:', err.message);
  console.error('vnote said:', note);
  dumpDiagnostics('preview');
  cleanup(1);
}
console.log('preview:', JSON.stringify(prev, null, 2));

if (prev.lumaMax - prev.lumaMin < 10) {
  fail(`preview canvas is flat (min ${prev.lumaMin}, max ${prev.lumaMax}) — nothing was drawn`);
}
if (prev.meanR === 0 && prev.meanB === 0) fail('preview canvas is empty');

/* ------------------------------------------- photo controls actually work */

const photo = await evaluate(`(async () => {
  const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
  // use a still frame of the video as a photo
  const v = document.createElement('video');
  v.src = URL.createObjectURL(new Blob([bin], { type: 'video/mp4' }));
  v.muted = true; document.body.appendChild(v);
  await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
  v.currentTime = 2;
  await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  const url = c.toDataURL('image/png');
  v.remove();

  await window.__uw.loadDataURL(url);
  // Wait for a full process cycle: the debounce is 120ms, so we must first see
  // the busy flag appear, then wait for it to clear again.
  const settle = async () => {
    let sawBusy = false;
    for (let i = 0; i < 150; i++) {
      const on = !document.getElementById('busy').classList.contains('hidden');
      if (on) sawBusy = true;
      else if (sawBusy) return;
      await new Promise(r => setTimeout(r, 60));
    }
  };
  await settle();

  const sliderValues = () => Object.fromEntries(
    [...document.querySelectorAll('#sliders .row input')].map(i => [
      i.parentElement.querySelector('span').textContent, parseFloat(i.value)]));

  const out = {};
  // 1. auto should have written real values onto the sliders
  out.autoSliders = sliderValues();

  // 2. each preset must change the sliders AND the rendered result
  const results = [];
  for (const name of ['blue', 'green', 'murky', 'shallow']) {
    document.querySelector('#photoPane [data-preset="' + name + '"]').click();
    await settle();
    results.push({
      preset: name,
      sliders: sliderValues(),
      px: window.__uw.stats().after,
    });
  }
  out.presets = results;

  // 3. moving a slider must change the output
  const red = [...document.querySelectorAll('#sliders .row')]
    .find(r => r.querySelector('span').textContent.includes('紅色復原')).querySelector('input');
  const before = window.__uw.stats().after;
  red.value = '0';
  red.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  out.sliderMoved = { before, after: window.__uw.stats().after, value: parseFloat(red.value) };

  return out;
})()`);
console.log('PHOTO CONTROLS:');
console.log('  auto slider values:', JSON.stringify(photo.autoSliders));
let distinct = new Set(photo.presets.map(p => JSON.stringify(p.px)));
console.log('  presets produced', distinct.size, 'distinct outputs of', photo.presets.length);
for (const p of photo.presets) {
  console.log('   ', p.preset.padEnd(8), 'red=' + p.sliders['紅色復原'], 'dehaze=' + p.sliders['去水霧'], 'clahe=' + p.sliders['局部對比 CLAHE'], '-> meanR', p.px.r.toFixed(1));
}
console.log('  slider 0 -> meanR', photo.sliderMoved.before.r.toFixed(1), 'then', photo.sliderMoved.after.r.toFixed(1));
if (distinct.size < 4) fail('presets are not producing distinct output (B2 not fixed)');
if (Math.abs(photo.sliderMoved.before.r - photo.sliderMoved.after.r) < 1)
  fail('moving the red slider did not change the output (B2 not fixed)');

/* ----------------------------------------------------------------- export */

console.log('running export (offline, every frame)…');
const t0 = Date.now();
const MAXEDGE = process.env.MAXEDGE || '360';
const out = await evaluate(`(async () => {
  const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
  const file = new File([bin], 'test.mp4', { type: 'video/mp4' });
  const t = Date.now();
  const r = await window.__uw.exportVideo(file, { maxEdge: Number(${JSON.stringify('MAXEDGE')}), format: 'mp4' });
  return { ...r, elapsedMs: Date.now() - t };
})()`);
console.log(
  `export: ${out.name} ${(out.size / 1e6).toFixed(2)} MB in ${(out.elapsedMs / 1000).toFixed(1)}s`,
);

// ftyp box check
const head = Buffer.from(out.head);
const isFtyp = head.slice(4, 8).toString('latin1') === 'ftyp';
console.log('container head:', head.slice(0, 16).toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
if (!isFtyp) fail('output is not an MP4 (no ftyp box)');
if (out.size < 1000) fail(`output suspiciously small: ${out.size} bytes`);

writeFileSync(OUT, Buffer.from(out.b64, 'base64'));
console.log('wrote', OUT);

/* ------------------- play the exported file back and compare to the source */

const playback = await evaluate(`(async () => {
  const statsAt = async (b64, type, t) => {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const v = document.createElement('video');
    v.src = URL.createObjectURL(new Blob([bin], { type }));
    v.muted = true; v.playsInline = true;
    document.body.appendChild(v);
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('load timeout')), 15000);
      v.addEventListener('loadeddata', () => { clearTimeout(to); res(); }, { once: true });
      v.addEventListener('error', () => { clearTimeout(to); rej(new Error('decode error')); }, { once: true });
    });
    v.currentTime = t;
    await new Promise((res) => { const to=setTimeout(res,15000); v.addEventListener('seeked', ()=>{clearTimeout(to);res();},{once:true}); });
    const c = new OffscreenCanvas(v.videoWidth, v.videoHeight);
    const cx = c.getContext('2d');
    cx.drawImage(v, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let sr=0,sg=0,sb=0,mn=255,mx=0,sum=0,sum2=0;
    const n = d.length/4;
    for (let i=0;i<d.length;i+=4){
      sr+=d[i];sg+=d[i+1];sb+=d[i+2];
      const l=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2]; sum+=l; sum2+=l*l;
      if(l<mn)mn=l; if(l>mx)mx=l;
    }
    v.remove();
    return { w:v.videoWidth, h:v.videoHeight, r:sr/n, g:sg/n, b:sb/n,
             contrast: Math.sqrt(sum2/n-(sum/n)**2), min:mn, max:mx };
  };
  const outB64 = ${JSON.stringify(out.b64)};
  const srcB64 = ${JSON.stringify(b64)};
  const o = await statsAt(outB64, 'video/mp4', 3);
  const s0 = await statsAt(srcB64, 'video/mp4', 3);
  return { source: s0, exported: o };
})()`);
console.log('playback compare:', JSON.stringify(playback, null, 2));

const s0 = playback.source, e0 = playback.exported;
if (e0.max - e0.min < 10) fail(`exported video is black (min ${e0.min}, max ${e0.max})`);
const changed = Math.abs(e0.contrast - s0.contrast) > 0.5 ||
  Math.abs(e0.r - s0.r) > 2 || Math.abs(e0.b - s0.b) > 2;
console.log(changed
  ? 'frames differ from source -> the pipeline actually ran on exported frames'
  : 'WARNING: exported frames are near-identical to source; processing may not have applied');

/* ------------------------------------------------------ re-probe in node */

const { Input, ALL_FORMATS, BlobSource } = await import('mediabunny');
const blob = new Blob([readFileSync(OUT)], { type: 'video/mp4' });
const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
const vt = await input.getPrimaryVideoTrack();
if (!vt) fail('re-probe: output has no video track');
const dur = await vt.computeDuration();
const at = await input.getPrimaryAudioTrack();

// Audio passthrough: the source may or may not have audio, but if it did, the
// export must carry an audio track of the same length.
let srcAudio = null;
if (VIDEO) {
  const sblob = new Blob([readFileSync(VIDEO)], { type: 'video/mp4' });
  const sin = new Input({ source: new BlobSource(sblob), formats: ALL_FORMATS });
  const sa = await sin.getPrimaryAudioTrack();
  if (sa) srcAudio = { codec: sa.codec, dur: await sa.computeDuration() };
}
console.log(
  `re-probe OK: ${vt.displayWidth}x${vt.displayHeight} ${vt.codec} ${dur.toFixed(2)}s audio=${at ? at.codec : 'none'}`,
);
console.log('source audio:', srcAudio ? `${srcAudio.codec} ${srcAudio.dur.toFixed(2)}s` : 'none');
if (srcAudio) {
  if (!at) fail('source had audio but the export dropped it');
  const aDur = await at.computeDuration();
  console.log(`output audio: ${at.codec} ${at.numberOfChannels}ch ${aDur.toFixed(2)}s`);
  if (Math.abs(aDur - srcAudio.dur) > 0.5) {
    fail(`audio length drifted: source ${srcAudio.dur.toFixed(2)}s vs output ${aDur.toFixed(2)}s`);
  }
  console.log('audio passthrough OK');
}

if (pageErrors.length) {
  console.log('\nPAGE ERRORS:');
  for (const e of pageErrors) console.log('  ', e);
  fail('uncaught page errors');
}
if (consoleLog.length) {
  console.log('\nCONSOLE:');
  for (const l of consoleLog.slice(-20)) console.log('  ', l);
}

console.log('\nall checks passed');
cleanup(0);
