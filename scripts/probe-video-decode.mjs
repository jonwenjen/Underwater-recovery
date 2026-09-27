/** Isolate: can headless Chrome decode H.264 in a <video> element? */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const VIDEO = process.argv[2];
const PORT = 9800 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), 'uw-probe-'));
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
  if (m.id && w.has(m.id)) { const { r, j } = w.get(m.id); w.delete(m.id); m.error ? j(m.error) : r(m.result); }
});
const send = (method, params = {}) =>
  new Promise((r, j) => { const i = ++id; w.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send('Page.enable');
await send('Page.navigate', { url: 'about:blank' });
await sleep(800);

const b64 = readFileSync(VIDEO).toString('base64');
const res = await evaluate(`(async () => {
  const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bin], { type: 'video/mp4' }));
  const v = document.createElement('video');
  v.src = url; v.muted = true; v.playsInline = true;
  document.body.appendChild(v);
  const canPlay = { mp4_h264: v.canPlayType('video/mp4; codecs="avc1.42E01E"'), mp4: v.canPlayType('video/mp4') };
  const err = await new Promise(res => {
    const t = setTimeout(() => res('timeout'), 8000);
    v.addEventListener('loadeddata', () => { clearTimeout(t); res(null); }, { once: true });
    v.addEventListener('error', () => { clearTimeout(t); res(v.error ? v.error.code + ':' + v.error.message : 'error'); }, { once: true });
  });
  v.currentTime = 3;
  await new Promise(r => { const t=setTimeout(r,6000); v.addEventListener('seeked', ()=>{clearTimeout(t);r();},{once:true}); });
  let stats = null;
  if (v.videoWidth) {
    const c = new OffscreenCanvas(v.videoWidth, v.videoHeight);
    const cx = c.getContext('2d');
    cx.drawImage(v, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let mn = 255, mx = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) { const l = (d[i]+d[i+1]+d[i+2])/3; if (l<mn) mn=l; if (l>mx) mx=l; sum+=l; }
    stats = { w: v.videoWidth, h: v.videoHeight, min: mn, max: mx, mean: Math.round(sum/(d.length/4)) };
  }
  return { canPlay, err, readyState: v.readyState, at: v.currentTime, stats };
})()`);
console.log(JSON.stringify(res, null, 2));
done(0);
