import './style.css';
import { analyse, DEFAULT_PARAMS } from './pipeline';
import type { Analysis, Params } from './pipeline';
import { buildControls, PRESETS } from './controls';
import RecoveryWorker from './worker?worker';

// Video support pulls in mediabunny (~150 kB gzip). Load it on demand so
// someone who only touches photos never downloads it.
import type { VideoMeta } from './video';

type VideoModule = typeof import('./video');
let videoMod: VideoModule | null = null;
async function loadVideoModule(): Promise<VideoModule> {
  if (!videoMod) videoMod = await import('./video');
  return videoMod;
}

/* ------------------------------------------------------------- app state */

interface Item {
  name: string;
  bitmap: ImageBitmap;
  original: ImageData;
  result: ImageData | null;
  analysis: Analysis;
  w: number;
  h: number;
}

const MAX_EDGE = 1600; // processing cap; keeps the worker responsive

const items: Item[] = [];
let current = 0;
let split = 0.5;

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const drop = $('drop');
const fileInput = $<HTMLInputElement>('file');
const work = $('work');
const queueEl = $('queue');
const cv = $<HTMLCanvasElement>('cv');
const ctx = cv.getContext('2d')!;
const handle = $('handle');
const busy = $('busy');
const diag = $('diag');

/* ------------------------------------------------- shared photo controls */

// Preset buttons live inside the photo panel now; the video panel has its own
// set, so scope the query to this pane.
const photoPane = $('photoPane');
const photoControls = buildControls(
  $('sliders'),
  photoPane.querySelector('.presets') as HTMLElement,
  $<HTMLInputElement>('auto'),
  () => schedule(),
);
const params = () => photoControls.params;

/* ---------------------------------------------------------------- worker */

const worker = new RecoveryWorker();
let seq = 0;
const pending = new Map<number, (r: ImageData) => void>();
let timer: number | undefined;
let inflight = false;
const dirty = new Set<number>();

worker.onmessage = (ev: MessageEvent) => {
  const { id, buffer, width, height } = ev.data as {
    id: number;
    buffer: ArrayBuffer;
    width: number;
    height: number;
  };
  const cb = pending.get(id);
  pending.delete(id);
  cb?.(new ImageData(new Uint8ClampedArray(buffer), width, height));
};

function schedule() {
  dirty.add(current);
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 120) as unknown as number;
}

function flush() {
  if (inflight || dirty.size === 0) return;
  const idx = dirty.values().next().value as number;
  dirty.delete(idx);
  const it = items[idx];
  if (!it) return;
  inflight = true;
  busy.classList.remove('hidden');
  const id = ++seq;
  const copy = it.original.data.slice().buffer;
  pending.set(id, (res) => {
    it.result = res;
    inflight = false;
    busy.classList.add('hidden');
    if (idx === current) draw();
    else renderQueue();
    if (dirty.size) flush();
  });
  worker.postMessage(
    { id, width: it.w, height: it.h, buffer: copy, params: { ...params() } },
    [copy],
  );
}

/* --------------------------------------------------------------- drawing */

function draw() {
  const it = items[current];
  if (!it) return;
  const res = it.result ?? it.original;
  const x = Math.round(cv.width * split);
  ctx.clearRect(0, 0, cv.width, cv.height);
  drawHalf(it.original, 0, x);
  // putImageData ignores its destination rect, so halves go through temp canvases
  drawHalf(res, x, cv.width - x);
  handle.style.left = `${(split * 100).toFixed(2)}%`;
  renderDiag();
  renderQueue();
}

function drawHalf(src: ImageData, from: number, width: number) {
  if (width <= 0) return;
  const half = cropped(src, from, width);
  const tmp = document.createElement('canvas');
  tmp.width = width;
  tmp.height = src.height;
  tmp.getContext('2d')!.putImageData(half, 0, 0);
  ctx.drawImage(tmp, from, 0);
}

/** Extract a [from, from+width) column band from an ImageData. */
function cropped(src: ImageData, from: number, width: number): ImageData {
  const out = new ImageData(width, src.height);
  for (let y = 0; y < src.height; y++) {
    const s = (y * src.width + from) * 4;
    out.data.set(src.data.subarray(s, s + width * 4), y * width * 4);
  }
  return out;
}

function renderDiag() {
  const a = items[current]?.analysis;
  if (!a) return;
  const pct = Math.round(a.isUnderwater * 100);
  const verdict =
    pct > 65 ? '強烈水下偏色' : pct > 35 ? '輕度水下偏色' : '幾乎沒有水下特徵';
  diag.innerHTML = `
    <div class="score ${pct > 35 ? 'hit' : ''}">
      <b>${pct}%</b><span>${verdict}</span>
    </div>
    <dl>
      <div><dt>藍綠偏移</dt><dd>${a.blueDominance.toFixed(0)}</dd></div>
      <div><dt>色度 a / b</dt><dd>${a.meanA.toFixed(0)} / ${a.meanB.toFixed(0)}</dd></div>
      <div><dt>對比度</dt><dd>${a.contrast.toFixed(3)}</dd></div>
      <div><dt>平均亮度</dt><dd>${a.meanLuma.toFixed(0)}</dd></div>
    </dl>`;
}

function renderQueue() {
  queueEl.innerHTML = '';
  items.forEach((it, i) => {
    const b = document.createElement('button');
    b.className = 'thumb' + (i === current ? ' on' : '');
    b.title = it.name;
    const c = document.createElement('canvas');
    const scale = 64 / Math.max(it.w, it.h);
    c.width = Math.max(1, Math.round(it.w * scale));
    c.height = Math.max(1, Math.round(it.h * scale));
    c.getContext('2d')!.drawImage(it.bitmap, 0, 0, c.width, c.height);
    b.appendChild(c);
    b.addEventListener('click', () => select(i));
    const x = document.createElement('i');
    x.className = 'x';
    x.textContent = '×';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      items.splice(i, 1);
      if (!items.length) {
        work.classList.add('hidden');
        queueEl.classList.add('hidden');
        return;
      }
      if (current >= items.length) current = items.length - 1;
      select(current);
    });
    b.appendChild(x);
    queueEl.appendChild(b);
  });
  queueEl.classList.toggle('hidden', items.length === 0);
  $<HTMLButtonElement>('downloadAll').textContent = `下載全部 (${items.filter((i) => i.result).length})`;
}

function select(i: number) {
  current = i;
  work.classList.remove('hidden');
  cv.width = items[i].w;
  cv.height = items[i].h;
  draw();
  flush();
}

/* ---------------------------------------------------------------- intake */

async function loadFile(f: File): Promise<Item> {
  const bmp = await createImageBitmap(f);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  let bitmap = bmp;
  if (scale < 1) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
    bitmap = await createImageBitmap(c);
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cx = c.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(bitmap, 0, 0);
  const original = cx.getImageData(0, 0, w, h);
  return { name: f.name, bitmap, original, result: null, analysis: analyse(original), w, h };
}

async function addFiles(files: FileList | File[]) {
  let firstNew: Item | null = null;
  for (const f of Array.from(files)) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const it = await loadFile(f);
      items.push(it);
      firstNew = firstNew ?? it;
    } catch (err) {
      console.error('failed to load', f.name, err);
    }
  }
  if (firstNew) select(items.indexOf(firstNew));
}

function toBlob(): Promise<Blob | null> {
  return new Promise((res) => cv.toBlob(res, 'image/png'));
}

function triggerDownload(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const suffixed = (name: string) => name.replace(/\.[^.]+$/, '') + '-recovered.png';

async function downloadCurrent() {
  if (!items[current]?.result) return;
  const blob = await toBlob();
  if (blob) triggerDownload(blob, suffixed(items[current].name));
}

async function downloadAll() {
  const c = document.createElement('canvas');
  const cx = c.getContext('2d')!;
  for (const it of items) {
    if (!it.result) continue;
    c.width = it.w;
    c.height = it.h;
    cx.putImageData(it.result, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    if (blob) triggerDownload(blob, suffixed(it.name));
    await new Promise((r) => setTimeout(r, 300));
  }
}

/* ----------------------------------------------------------------- wiring */

drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) addFiles(fileInput.files);
});
for (const ev of ['dragenter', 'dragover'])
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
for (const ev of ['dragleave', 'drop'])
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove('over');
  });
drop.addEventListener('drop', (e) => {
  const dt = (e as DragEvent).dataTransfer;
  if (dt?.files.length) addFiles(dt.files);
});
window.addEventListener('paste', (e) => {
  const list = (e as ClipboardEvent).clipboardData?.items;
  if (!list) return;
  const files: File[] = [];
  for (const it of list)
    if (it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  if (files.length) addFiles(files);
});

handle.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const move = (ev: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    split = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    draw();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

$('reset').addEventListener('click', () => {
  photoPane.querySelectorAll('[data-preset]').forEach((x, i) =>
    x.classList.toggle('on', i === 0),
  );
  photoControls.set({ ...DEFAULT_PARAMS });
  schedule();
});

$('download').addEventListener('click', downloadCurrent);
$('downloadAll').addEventListener('click', downloadAll);

/* ------------------------------------------------- test / automation hook */

function channelStats(d: Uint8ClampedArray) {
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
    contrast: Math.sqrt(Math.max(0, l2 / n - (l / n) ** 2)),
  };
}

Object.assign(window as unknown as Record<string, unknown>, {
  __uw: {
    async loadDataURL(url: string) {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const x = c.getContext('2d', { willReadFrequently: true })!;
      x.drawImage(img, 0, 0);
      const original = x.getImageData(0, 0, c.width, c.height);
      const bitmap = await createImageBitmap(c);
      const item: Item = {
        name: 'test.png',
        bitmap,
        original,
        result: null,
        analysis: analyse(original),
        w: c.width,
        h: c.height,
      };
      items.push(item);
      select(items.length - 1);
      await new Promise<void>((res) => {
        const iv = setInterval(() => {
          if (item.result) {
            clearInterval(iv);
            res();
          }
        }, 50);
      });
      return { analysis: item.analysis, params: params() };
    },
    stats() {
      const it = items[0];
      if (!it?.result) return null;
      return { before: channelStats(it.original.data), after: channelStats(it.result.data) };
    },
    setParams(p: Partial<Params>) {
      photoControls.set({ ...params(), ...p });
      return flushAndWait();
    },
    reset() {
      items.length = 0;
      current = 0;
    },
    /** Test hook: run the real video export and describe the output bytes. */
    async exportVideo(file: File, opts: { maxEdge: number; format: 'mp4' | 'webm' }) {
      const mod = await loadVideoModule();
      const { blob, name } = await mod.exportVideo(file, {
        params: videoParams(),
        maxEdge: opts.maxEdge,
        format: opts.format,
      });
      const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
      return {
        name,
        size: blob.size,
        type: blob.type,
        head: Array.from(head),
        // hand the bytes back so the harness can re-probe them
        b64: await new Promise<string>((res) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result).split(',')[1]);
          fr.readAsDataURL(blob);
        }),
      };
    },
  },
});

function flushAndWait(): Promise<void> {
  schedule();
  return new Promise((res) => {
    const iv = setInterval(() => {
      if (!inflight && dirty.size === 0 && items[0]?.result) {
        clearInterval(iv);
        res();
      }
    }, 50);
  });
}

export { PRESETS };

/* ------------------------------------------------------------------ tabs */

$('tabPhotos').addEventListener('click', () => switchTab('photo'));
$('tabVideo').addEventListener('click', () => switchTab('video'));

function switchTab(which: 'photo' | 'video') {
  const isPhoto = which === 'photo';
  $('tabPhotos').classList.toggle('on', isPhoto);
  $('tabVideo').classList.toggle('on', !isPhoto);
  $('tabPhotos').setAttribute('aria-selected', String(isPhoto));
  $('tabVideo').setAttribute('aria-selected', String(!isPhoto));
  $('photoPane').classList.toggle('hidden', !isPhoto);
  $('videoPane').classList.toggle('hidden', isPhoto);
  if (!isPhoto) {
    preview?.pause();
    void loadVideoModule();
  }
}

/* ----------------------------------------------------------------- video */

const vdrop = $('vdrop');
const vfile = $<HTMLInputElement>('vfile');
const vwork = $('vwork');
const vcv = $<HTMLCanvasElement>('vcv');
const vbusy = $('vbusy');
const vseek = $<HTMLInputElement>('vseek');
const vtime = $('vtime');
const vnote = $('vnote');
const vprogress = $('vprogress');
const vbar = $('vbar');
const vstat = $('vstat');
const vexportBtn = $<HTMLButtonElement>('vexport');
const vdiag = $('vdiag');
const vres = $<HTMLSelectElement>('vres');
const vformat = $<HTMLSelectElement>('vformat');
const videoPane = $('videoPane');

const videoControls = buildControls(
  $('vsliders'),
  videoPane.querySelector('.presets') as HTMLElement,
  $<HTMLInputElement>('vauto'),
  () => void refreshPreviewFrame(),
);

let videoFile: File | null = null;
let videoMeta: VideoMeta | null = null;
type Preview = import('./video').VideoPreview;
let preview: Preview | null = null;
let exporting = false;
const cancelFlag = { cancelled: false };

const videoParams = () => videoControls.params;

const clock = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

vdrop.addEventListener('click', () => vfile.click());
vfile.addEventListener('change', () => {
  const f = vfile.files?.[0];
  if (f) void loadVideo(f);
});
for (const ev of ['dragenter', 'dragover'])
  vdrop.addEventListener(ev, (e) => {
    e.preventDefault();
    vdrop.classList.add('over');
  });
for (const ev of ['dragleave', 'drop'])
  vdrop.addEventListener(ev, (e) => {
    e.preventDefault();
    vdrop.classList.remove('over');
  });
vdrop.addEventListener('drop', (e) => {
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f) void loadVideo(f);
});

async function loadVideo(f: File) {
  vdrop.classList.add('hidden');
  vbusy.classList.remove('hidden');
  vnote.textContent = '讀取中…';
  try {
    const mod = await loadVideoModule();
    const meta = await mod.probeVideo(f);
    videoFile = f;
    videoMeta = meta;
    mod.resetVideoAnalysis();
    preview?.dispose();
    preview = new mod.VideoPreview(f, vcv);
    await preview.ready();
    vwork.classList.remove('hidden');
    vnote.textContent =
      `${meta.width}×${meta.height} · ${clock(meta.duration)}` +
      (meta.hasAudio ? ' · 含音軌（匯出時原樣保留）' : ' · 無音軌');
    vseek.max = '1000';
    $('vcodec').textContent = '預覽為降解析度近似畫面；匯出才是完整品質的離線逐幀結果。';
    await refreshPreviewFrame();
  } catch (err) {
    vnote.textContent = `無法讀取：${(err as Error).message}`;
    vdrop.classList.remove('hidden');
  } finally {
    vbusy.classList.add('hidden');
  }
}

let seekTimer: number | undefined;
vseek.addEventListener('input', () => {
  if (!preview || !videoMeta || !videoMeta.duration) return;
  if (seekTimer) clearTimeout(seekTimer);
  const t = (parseInt(vseek.value, 10) / 1000) * videoMeta.duration;
  vtime.textContent = clock(t);
  seekTimer = setTimeout(() => void grabAt(t), 180) as unknown as number;
});

async function grabAt(t: number) {
  if (!preview) return;
  vbusy.classList.remove('hidden');
  try {
    await preview.grab(t, videoParams());
    if (videoMeta) renderVideoDiag(videoMeta);
  } finally {
    vbusy.classList.add('hidden');
  }
}

function renderVideoDiag(meta: VideoMeta) {
  vdiag.innerHTML = `
    <div class="score">
      <b>${meta.width}×${meta.height}</b><span>${clock(meta.duration)}</span>
    </div>
    <dl>
      <div><dt>音軌</dt><dd>${meta.hasAudio ? '有（保留）' : '無'}</dd></div>
      <div><dt>預覽解析度</dt><dd>≤ 480p</dd></div>
    </dl>`;
}

async function refreshPreviewFrame() {
  if (!preview) return;
  await grabAt(Math.max(preview.currentTime, 0));
}

$('vplay').addEventListener('click', async () => {
  if (!preview) return;
  const btn = $('vplay');
  if (btn.dataset.playing === '1') {
    preview.pause();
    btn.dataset.playing = '0';
    btn.textContent = '▶ 播放預覽';
    return;
  }
  btn.dataset.playing = '1';
  btn.textContent = '⏸ 暫停';
  await preview.play(videoParams(), (t: number) => {
    vtime.textContent = clock(t);
    if (videoMeta?.duration) {
      vseek.value = String(Math.round((t / videoMeta.duration) * 1000));
    }
  });
  btn.dataset.playing = '0';
  btn.textContent = '▶ 播放預覽';
});

$('vreset').addEventListener('click', () => {
  videoPane.querySelectorAll('[data-preset]').forEach((x, i) =>
    x.classList.toggle('on', i === 0),
  );
  videoControls.set({ ...DEFAULT_PARAMS });
  void refreshPreviewFrame();
});

$('vexport').addEventListener('click', async () => {
  if (!videoFile || exporting) return;
  exporting = true;
  cancelFlag.cancelled = false;
  const btn = vexportBtn;
  btn.disabled = true;
  $('vcancel').classList.remove('hidden');
  vprogress.classList.remove('hidden');
  vbar.style.width = '0%';
  vstat.textContent = '0%';
  try {
    const mod = await loadVideoModule();
    const { blob, name } = await mod.exportVideo(videoFile, {
      params: videoParams(),
      maxEdge: parseInt(vres.value, 10),
      format: vformat.value as 'mp4' | 'webm',
      signal: cancelFlag,
      onProgress: (p: number, note: string) => {
        vbar.style.width = `${(p * 100).toFixed(1)}%`;
        vstat.textContent = `${Math.round(p * 100)}%`;
        if (note) vnote.textContent = note;
      },
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
    vnote.textContent = `完成：${name}`;
  } catch (err) {
    vnote.textContent = `匯出失敗：${(err as Error).message}`;
  } finally {
    exporting = false;
    btn.disabled = false;
    $('vcancel').classList.add('hidden');
  }
});

$('vcancel').addEventListener('click', () => {
  cancelFlag.cancelled = true;
  vnote.textContent = '取消中…';
});
