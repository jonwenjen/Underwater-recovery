/**
 * Compare two same-size images and report how the recovery changed
 * already-warm / saturated regions (yellow fish) versus the blue water.
 *
 *   node scripts/compare-warm.mjs <before.png> <after.png> <origin>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const A = process.argv[2];
const B = process.argv[3];
const ORIGIN = process.argv[4] ?? 'http://localhost:5301';
const PORT = 9700 + Math.floor(Math.random() * 200);
const profile = mkdtempSync(join(tmpdir(), 'uw-cmp-'));
const chrome = spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
   '--no-first-run', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore' },
);
const done = (c) => { try{ws?.close();}catch{} try{chrome.kill('SIGKILL');}catch{} try{rmSync(profile,{recursive:true,force:true});}catch{} process.exit(c); };

let target = null;
for (let i = 0; i < 80; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); target = l.find(t=>t.type==='page'); if (target) break; } catch {}
  await sleep(250);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const w = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { const {r,j}=w.get(m.id); w.delete(m.id); m.error?j(m.error):r(m.result);} });
const send = (method, params={}) => new Promise((r,j)=>{const i=++id; w.set(i,{r,j}); ws.send(JSON.stringify({id:i,method,params}));});
const evaluate = async (expr) => { const r = await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };

await send('Page.enable');
await send('Page.navigate', { url: `${ORIGIN}/bench/host.html` });
await sleep(1200);

const a = readFileSync(A).toString('base64');
const b = readFileSync(B).toString('base64');

const res = await evaluate(`(async () => {
  const W = 320, H = 180;   // compare at a common size: the export is downscaled
  const load = async (b64) => {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin]));
    const c = new OffscreenCanvas(W, H);
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(bmp, 0, 0, W, H);
    return cx.getImageData(0, 0, W, H).data;
  };
  const [A, B] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})]);

  // Bucket pixels by how warm they already are in the SOURCE, then compare
  // mean saturation in each bucket before vs after.
  const buckets = [
    { name: 'blue water', test: (r,g,b) => b > r + 12 },
    { name: 'neutral',     test: (r,g,b) => Math.abs(b - r) <= 12 && Math.max(r,g,b) - Math.min(r,g,b) < 25 },
    { name: 'warm/yellow', test: (r,g,b) => r > b + 20 && g > b },
  ];
  const sat = (r,g,b) => { const mx = Math.max(r,g,b), mn = Math.min(r,g,b); return mx ? (mx-mn)/mx : 0; };
  const out = {};
  for (const bk of buckets) {
    let n = 0, sa = 0, sb = 0, ra=0, ga=0, ba=0, rb=0, gb=0, bb=0, clipped=0;
    for (let i = 0; i < A.length; i += 4) {
      if (!bk.test(A[i], A[i+1], A[i+2])) continue;
      n++;
      sa += sat(A[i],A[i+1],A[i+2]); ra+=A[i]; ga+=A[i+1]; ba+=A[i+2];
      sb += sat(B[i],B[i+1],B[i+2]); rb+=B[i]; gb+=B[i+1]; bb+=B[i+2];
      if (B[i] >= 250 || B[i+1] >= 250) clipped++;
    }
    out[bk.name] = n ? {
      pixels: n,
      pctOfFrame: +(100*n/(A.length/4)).toFixed(1),
      satBefore: +(sa/n).toFixed(3), satAfter: +(sb/n).toFixed(3),
      meanBefore: [Math.round(ra/n), Math.round(ga/n), Math.round(ba/n)],
      meanAfter: [Math.round(rb/n), Math.round(gb/n), Math.round(bb/n)],
      clippedPct: +(100*clipped/n).toFixed(2),
    } : { pixels: 0 };
  }
  return out;
})()`);

console.log(JSON.stringify(res, null, 2));
done(0);
