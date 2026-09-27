/**
 * Dump a PNG frame from a video at a given timestamp (headless Chrome).
 *   node scripts/extract-frame.mjs <video> <out.png> <time> [origin]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const VID = process.argv[2];
const OUT = process.argv[3];
const T = process.argv[4] ?? '2';
const ORIGIN = process.argv[5] ?? 'http://localhost:5301';
const PORT = 9600 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), 'uw-fr-'));

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
await sleep(1200);

const b64 = readFileSync(VID).toString('base64');
const png = await evaluate(`(async () => {
  const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
  const v = document.createElement('video');
  v.src = URL.createObjectURL(new Blob([bin], { type: 'video/mp4' }));
  v.muted = true; v.playsInline = true;
  document.body.appendChild(v);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('load timeout')), 20000);
    v.addEventListener('loadeddata', () => { clearTimeout(t); res(); }, { once: true });
  });
  v.currentTime = ${T};
  await new Promise((res) => { const t=setTimeout(res,20000); v.addEventListener('seeked',()=>{clearTimeout(t);res();},{once:true}); });
  const c = new OffscreenCanvas(v.videoWidth, v.videoHeight);
  c.getContext('2d').drawImage(v, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i+CH));
  return btoa(s);
})()`);

writeFileSync(OUT, Buffer.from(png, 'base64'));
console.log('wrote', OUT);
done(0);
