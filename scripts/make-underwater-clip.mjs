/**
 * Build a short synthetic UNDERWATER clip from a real still, for testing the
 * video path on realistic content. Panning + zoom so consecutive frames differ.
 *
 * Encoding needs WebCodecs, so this runs in the headless browser harness and
 * imports mediabunny from node_modules over a local static server (no CDN).
 *
 *   node scripts/make-underwater-clip.mjs <image> <out.mp4> <origin>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const IMG = process.argv[2];
const OUT = process.argv[3] ?? '/tmp/underwater-clip.mp4';
const ORIGIN = process.argv[4] ?? 'http://localhost:5301';
const PORT = 9500 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), 'uw-mk-'));

const chrome = spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-gpu',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const done = (c) => {
  try { ws?.close(); } catch {}
  try { chrome.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(c);
};

let target = null;
for (let i = 0; i < 80; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = l.find((t) => t.type === 'page');
    if (target) break;
  } catch {}
  await sleep(250);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const w = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && w.has(m.id)) {
    const { r, j } = w.get(m.id);
    w.delete(m.id);
    m.error ? j(m.error) : r(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((r, j) => {
    const i = ++id;
    w.set(i, { r, j });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails)
    throw new Error(
      r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
    );
  return r.result.value;
};

await send('Page.enable');
await send('Page.navigate', { url: `${ORIGIN}/bench/host.html` });
await sleep(1500);

const b64 = readFileSync(IMG).toString('base64');
const res = await evaluate(`(async () => {
  const imgBin = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
  const img = await createImageBitmap(new Blob([imgBin], { type: 'image/jpeg' }));
  const W = 640, H = 360;
  const src = new OffscreenCanvas(W, H);
  const sctx = src.getContext('2d');
  sctx.drawImage(img, 0, 0, W, H);

  const mod = await import('${ORIGIN}/node_modules/mediabunny/dist/bundles/mediabunny.mjs');
  const output = new mod.Output({ format: new mod.Mp4OutputFormat(), target: new mod.BufferTarget() });
  const source = new mod.VideoSampleSource({ codec: 'avc', bitrate: 2500000 });
  output.addVideoTrack(source);

  // Real audio track (440 Hz tone) so audio passthrough is actually testable.
  const SR = 48000, NCH = 2, SECONDS = 4;
  const audio = new mod.AudioSampleSource({ codec: 'aac', bitrate: 128000 });
  output.addAudioTrack(audio);
  await output.start();

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const FPS = 30, TOTAL = 120;
  for (let i = 0; i < TOTAL; i++) {
    const t = i / TOTAL;
    const z = 1.05 + 0.08 * t;
    const w = W * z, h = H * z;
    const x = (W - w) * (0.5 + 0.4 * Math.sin(t * 3.1));
    const y = (H - h) * (0.5 + 0.3 * Math.cos(t * 2.3));
    ctx.drawImage(src, x, y, w, h, 0, 0, W, H);
    const sample = new mod.VideoSample(canvas, { timestamp: i / FPS, duration: 1 / FPS });
    await source.add(sample);
    sample.close();
  }
  await source.close();

  const total = SR * SECONDS;
  const data = new Float32Array(1024 * NCH);
  for (let off = 0; off < total; off += 1024) {
    const n = Math.min(1024, total - off);
    for (let i = 0; i < n; i++) {
      const t = (off + i) / SR;
      const v = Math.sin(2 * Math.PI * 440 * t) * 0.3;
      data[i * NCH] = v; data[i * NCH + 1] = v;
    }
    const as = new mod.AudioSample({
      format: 'f32-planar',
      sampleRate: SR,
      numberOfChannels: NCH,
      numberOfFrames: n,
      timestamp: off / SR,
      data,
    });
    await audio.add(as);
    as.close();
  }
  await audio.close();
  await output.finalize();
  const u8 = new Uint8Array(output.target.buffer);
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return { size: u8.length, b64: btoa(s) };
})()`);

writeFileSync(OUT, Buffer.from(res.b64, 'base64'));
console.log('wrote', OUT, (res.size / 1e6).toFixed(2), 'MB');
done(0);
