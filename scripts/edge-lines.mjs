/**
 * Measure the outermost rows/columns of a decoded video frame, to detect a
 * stray 1-2 px border introduced by the export path.
 *
 *   node scripts/edge-lines.mjs <video> <time> <origin>
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const VID = process.argv[2];
const T = process.argv[3] ?? '1';
const ORIGIN = process.argv[4] ?? 'http://localhost:5301';
const CHROME =
  process.env.CHROME_PATH ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
   '/usr/bin/google-chrome',
   '/usr/bin/google-chrome-stable',
   '/usr/bin/chromium'].find((p) => existsSync(p)) ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9950 + Math.floor(Math.random() * 40);
const profile = mkdtempSync(join(tmpdir(), 'uw-edge-'));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore' });
const done = (c) => { try { ws?.close(); } catch {} try { chrome.kill('SIGKILL'); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(c); };

let target = null;
for (let i = 0; i < 80; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); target = l.find((t) => t.type === 'page'); if (target) break; } catch {}
  await sleep(250);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const w = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { const { r, j } = w.get(m.id); w.delete(m.id); m.error ? j(m.error) : r(m.result); } });
const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; w.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };

await send('Page.enable');
await send('Page.navigate', { url: `${ORIGIN}/bench/host.html` });
await sleep(1200);

const b64 = readFileSync(VID).toString('base64');
const res = await evaluate(`(async () => {
  const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
  const v = document.createElement('video');
  v.src = URL.createObjectURL(new Blob([bin], { type: 'video/mp4' }));
  v.muted = true; v.playsInline = true; document.body.appendChild(v);
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('load')), 20000);
    v.addEventListener('loadeddata', () => { clearTimeout(t); res(); }, { once: true }); });
  v.currentTime = ${T};
  await new Promise((res) => { const t = setTimeout(res, 20000); v.addEventListener('seeked', () => { clearTimeout(t); res(); }, { once: true }); });
  const c = new OffscreenCanvas(v.videoWidth, v.videoHeight);
  const cx = c.getContext('2d');
  cx.drawImage(v, 0, 0);
  const d = cx.getImageData(0, 0, c.width, c.height).data;
  const W = c.width, H = c.height;
  const at = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i+1], d[i+2]]; };
  const meanOf = (pts) => {
    let r = 0, g = 0, b = 0;
    for (const [x, y] of pts) { const p = at(x, y); r += p[0]; g += p[1]; b += p[2]; }
    const n = pts.length;
    return [r / n, g / n, b / n].map((v) => Math.round(v * 10) / 10);
  };
  // sample the centre of each edge strip, away from corners
  const rowY = (k) => Array.from({ length: 21 }, (_, i) => [Math.round(W * (0.3 + 0.4 * i / 20)), k]);
  const colX = (k) => Array.from({ length: 21 }, (_, i) => [k, Math.round(H * (0.3 + 0.4 * i / 20))]);
  return {
    size: W + 'x' + H,
    'row 0   ': meanOf(rowY(0)),
    'row 1   ': meanOf(rowY(1)),
    'row 2   ': meanOf(rowY(2)),
    'row 3   ': meanOf(rowY(3)),
    'row mid ': meanOf(rowY(H >> 1)),
    'row H-3 ': meanOf(rowY(H - 3)),
    'row H-2 ': meanOf(rowY(H - 2)),
    'row H-1 ': meanOf(rowY(H - 1)),
    'col 0   ': meanOf(colX(0)),
    'col 1   ': meanOf(colX(1)),
    'col 2   ': meanOf(colX(2)),
    'col mid ': meanOf(colX(W >> 1)),
    'col W-3 ': meanOf(colX(W - 3)),
    'col W-2 ': meanOf(colX(W - 2)),
    'col W-1 ': meanOf(colX(W - 1)),
  };
})()`);

console.log(`${VID}  ${res.size}`);
for (const [k, v] of Object.entries(res)) {
  if (k === 'size') continue;
  console.log(`  ${k}  rgb(${v.join(', ')})`);
}
done(0);
