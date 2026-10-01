import './app.css';
import { AI_REFRESH_S, blendGuide, type AiGuide } from './engine/ai.ts';
import type { FrameState } from './engine/auto.ts';
import type { Vec3 } from './engine/color.ts';
import {
  AI_STYLE,
  AUTO_KEYS,
  DEFAULT_PARAMS,
  GROUPS,
  POSITION_KEYS,
  PRESETS,
  isAutoKey,
  type AutoKey,
  type NumKey,
  type Params,
  type SliderDef,
} from './engine/params.ts';
import { cloneLook, identityLook, type Look } from './engine/look.ts';
import { NO_ORIENT, orientedSize, Processor, type Orient, type View } from './engine/renderer.ts';
import { curveEditor } from './ui/curves.ts';
import { hslPanel } from './ui/hsl.ts';
import { movableBlocks } from './ui/blocks.ts';
import { lightPoints, type PointId } from './ui/lightPoints.ts';

import { Funie } from './engine/funie.ts';

type ExportMod = typeof import('./engine/export.ts');
let exportMod: Promise<ExportMod> | null = null;
const loadExport = () => (exportMod ??= import('./engine/export.ts'));

/* ------------------------------------------------------------------ state */

interface ImageItem {
  kind: 'image';
  name: string;
  file: File;
  bitmap: ImageBitmap;
  w: number;
  h: number;
}
interface VideoItem {
  kind: 'video';
  name: string;
  file: File;
  video: HTMLVideoElement;
  w: number;
  h: number;
  duration: number;
}
type Item = ImageItem | VideoItem;

const items: Item[] = [];
let current = -1;
let params: Params = { ...DEFAULT_PARAMS };
const locked = new Set<AutoKey>();
const view: View = { mode: 1, split: 0.5, clip: false };
let previewCap = 1920;
let orient: Orient = { ...NO_ORIENT };
let look: Look = identityLook();
let lastState: FrameState | null = null;
let activePreset = 'auto';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('view');
const viewer = $('viewer');
const note = $('note');

let proc: Processor;
try {
  proc = new Processor(canvas);
} catch (err) {
  $('empty').innerHTML = `<p class="big">無法啟動 GPU 運算</p><p class="small">${(err as Error).message}</p>`;
  throw err;
}

/* -------------------------------------------------------------- rendering */

let needUpload = false;
let dirty = false;
let raf = 0;
let playing = false;
let lastMediaTime = -1;
let framesSinceTick = 0;
let msAccum = 0;
let lastUi = 0;
let cutUntil = 0;

function requestRender(upload = false) {
  if (upload) needUpload = true;
  dirty = true;
  if (!raf) raf = requestAnimationFrame(renderNow);
}

function sizeFor(it: Item) {
  const [ow, oh] = orientedSize(it.w, it.h, orient);
  const max = Math.max(ow, oh);
  const cap = Math.min(previewCap > 0 ? previewCap : max, proc.renderer.maxTexture);
  const s = Math.min(1, cap / max);
  proc.renderer.resize(Math.max(2, Math.round(ow * s)), Math.max(2, Math.round(oh * s)));
}

/** Render the current still (photo, or paused video) with the current settings. */
function renderNow() {
  raf = 0;
  if (!dirty) return;
  dirty = false;
  const it = items[current];
  if (!it || (it.kind === 'video' && playing)) return;
  sizeFor(it);
  const src = it.kind === 'image' ? it.bitmap : it.video;
  const upload = needUpload || !proc.state;
  needUpload = false;
  const st = proc.frame(upload ? src : null, it.w, it.h, { params, locked, dt: 0, snap: true, ai: aiGuide }, view);
  afterFrame(st);
}

/** Live playback: every decoded frame goes through analysis → tracker → GPU. */
function onVideoFrame(_now: number, meta: VideoFrameCallbackMetadata) {
  const it = items[current];
  if (!playing || !it || it.kind !== 'video') return;
  const dt = lastMediaTime < 0 ? 0 : meta.mediaTime - lastMediaTime;
  const snap = lastMediaTime < 0 || dt < 0 || dt > 1;
  lastMediaTime = meta.mediaTime;
  sizeFor(it);
  const st = proc.frame(it.video, it.w, it.h, { params, locked, dt: snap ? 0 : dt, snap, ai: aiGuide }, view);
  afterFrame(st);
  updateTime(it);
  it.video.requestVideoFrameCallback(onVideoFrame);
}

function afterFrame(st: FrameState) {
  lastState = st;
  framesSinceTick++;
  msAccum += proc.lastFrameMs;
  if (st.stats.sceneCut) cutUntil = performance.now() + 900;
  refreshAi(st.stats.sceneCut);
  const now = performance.now();
  if (now - lastUi > 120 || !playing) {
    const span = now - lastUi;
    const avg = msAccum / Math.max(1, framesSinceTick);
    $('perf').textContent =
      `${proc.renderer.pw}×${proc.renderer.ph} · ${avg.toFixed(1)} ms/幀` +
      (playing ? ` · ${((framesSinceTick * 1000) / span).toFixed(0)} fps` : '');
    lastUi = now;
    framesSinceTick = 0;
    msAccum = 0;
    refreshControls(st);
    renderAnalysis(st);
  }
  $('cutFlash').classList.toggle('hidden', now > cutUntil);
}

/* --------------------------------------------------------------- analysis */

const histo = $<HTMLCanvasElement>('histo');
const hctx = histo.getContext('2d')!;
const rgbCss = (v: Vec3) => {
  const m = Math.max(v[0], v[1], v[2], 1e-4);
  const c = (x: number) => Math.round(255 * Math.pow(Math.max(0, x / m), 1 / 2.2));
  return `rgb(${c(v[0])},${c(v[1])},${c(v[2])})`;
};

function renderAnalysis(st: FrameState) {
  const s = st.stats;
  const pct = Math.round(s.underwater * 100);
  $('uwScore').textContent = `${pct}%`;
  $('uwLabel').textContent = pct > 60 ? '強烈水下特徵' : pct > 30 ? '輕度水下特徵' : '幾乎無水下特徵';
  $('fWater').textContent = s.water === 'blue' ? '藍水' : s.water === 'green' ? '綠水' : '中性';
  $('fHaze').textContent = `${Math.round(s.haze * 100)}%`;
  $('swA').style.background = rgbCss(s.waterLight);
  $('swI').style.background = rgbCss(s.illum);
  $('fGain').textContent = st.chromaGain > 1.001 || st.warmGain > 0.001 ? `×${st.chromaGain.toFixed(2)}` : '關';
  $('fNoise').textContent = s.noise > 0 ? `σ ${s.noise.toFixed(1)}` : '—';
  const light = [s.beamPresence > 0.3 ? '光束' : '', s.surfacePresence > 0.3 ? '水面' : ''].filter(Boolean).join('＋');
  $('fLight').textContent = light || '無';
  $('fUiqm').textContent = s.quality ? s.quality.uiqm.toFixed(2) : '—';
  $('fUciqe').textContent = s.quality ? s.quality.uciqe.toFixed(3) : '—';
  const px = proc.renderer.readScope(st);
  drawHistogram(px);
  curvesUi?.draw(px);
}

function drawHistogram(px: Uint8Array) {
  const bins = [new Uint32Array(64), new Uint32Array(64), new Uint32Array(64)];
  for (let i = 0; i < px.length; i += 4) {
    bins[0][px[i] >> 2]++;
    bins[1][px[i + 1] >> 2]++;
    bins[2][px[i + 2] >> 2]++;
  }
  let max = 1;
  for (const b of bins) for (let i = 1; i < 63; i++) max = Math.max(max, b[i]);
  const W = histo.width,
    H = histo.height;
  hctx.clearRect(0, 0, W, H);
  hctx.globalCompositeOperation = 'lighter';
  const colors = ['rgba(255,80,80,0.75)', 'rgba(80,255,120,0.75)', 'rgba(80,150,255,0.8)'];
  bins.forEach((b, c) => {
    hctx.fillStyle = colors[c];
    hctx.beginPath();
    hctx.moveTo(0, H);
    for (let i = 0; i < 64; i++) hctx.lineTo((i / 63) * W, H - Math.min(1, b[i] / max) * (H - 4));
    hctx.lineTo(W, H);
    hctx.fill();
  });
  hctx.globalCompositeOperation = 'source-over';
}

/* --------------------------------------------------------------- controls */

interface RowRefs {
  def: SliderDef;
  row: HTMLElement;
  input: HTMLInputElement;
  out: HTMLOutputElement;
  badge: HTMLButtonElement | null;
}
const rows = new Map<NumKey, RowRefs>();

const fmt = (d: SliderDef, v: number) =>
  d.key === 'exposure' ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}` : d.step >= 1 ? v.toFixed(0) : d.step < 0.01 ? v.toFixed(3) : v.toFixed(2);

function isFollowingAuto(k: NumKey): boolean {
  return params.auto && isAutoKey(k) && !locked.has(k);
}

function buildControls() {
  const host = $('groups');
  GROUPS.forEach((g, gi) => {
    const det = document.createElement('details');
    det.className = 'group';
    det.dataset.block = `group:${g.title}`;
    det.open = gi < 3;
    det.innerHTML = `<summary>${g.title}</summary>`;
    const box = document.createElement('div');
    box.className = 'sliders';
    for (const d of g.sliders) {
      const row = document.createElement('div');
      row.className = 'srow';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = d.label;
      name.title = `${d.hint}（雙擊恢復預設）`;
      const out = document.createElement('output');
      let badge: HTMLButtonElement | null = null;
      if (isAutoKey(d.key)) {
        badge = document.createElement('button');
        badge.className = 'abadge';
        badge.textContent = 'A';
        badge.title = '自動（點擊切換自動／手動）';
        badge.addEventListener('click', () => {
          const k = d.key as AutoKey;
          if (!params.auto) return;
          if (locked.has(k)) locked.delete(k);
          else {
            params[k] = lastState?.effective[k] ?? params[k];
            locked.add(k);
          }
          markPreset(null);
          refreshControls(lastState);
          requestRender();
        });
      } else {
        const sp = document.createElement('span');
        sp.className = 'nobadge';
        row.append(name, out, sp);
      }
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(d.min);
      input.max = String(d.max);
      input.step = String(d.step);
      input.setAttribute('aria-label', d.label);
      input.addEventListener('input', () => {
        params[d.key] = parseFloat(input.value);
        if (isAutoKey(d.key)) locked.add(d.key);
        markPreset(null);
        refreshControls(lastState);
        requestRender();
      });
      name.addEventListener('dblclick', () => {
        params[d.key] = DEFAULT_PARAMS[d.key];
        if (isAutoKey(d.key)) locked.delete(d.key);
        requestRender();
      });
      if (badge) row.append(name, out, badge);
      row.append(input);
      box.append(row);
      rows.set(d.key, { def: d, row, input, out, badge });
    }
    det.append(box);
    host.append(det);
  });
  // each slider group is its own movable panel block
  host.replaceWith(...host.children);
  refreshControls(null);
}

function refreshControls(st: FrameState | null) {
  syncVivid();
  syncFlow();
  syncAi();
  lp?.update();
  for (const [k, r] of rows) {
    const auto = isFollowingAuto(k);
    const v = auto && st ? st.effective[k as AutoKey] : params[k];
    if (document.activeElement !== r.input) r.input.value = String(v);
    r.out.textContent = fmt(r.def, v);
    r.row.classList.toggle('autoing', auto);
    if (r.badge) {
      r.badge.classList.toggle('hidden', !params.auto);
      r.badge.classList.toggle('on', auto);
      r.badge.classList.toggle('off', !auto);
      r.badge.title = auto ? '自動中 — 點擊鎖定為目前數值' : '手動 — 點擊交還自動';
    }
  }
}

function buildPresets() {
  const host = $('presets');
  for (const [key, pr] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.textContent = pr.label;
    b.title = pr.hint;
    b.dataset.preset = key;
    b.addEventListener('click', () => applyPreset(key));
    host.append(b);
  }
  markPreset('auto');
}

function applyPreset(key: string) {
  const pr = PRESETS[key];
  // presets choose the water model; rich colour, restoration and tracking
  // speed are the user's taste and survive a preset change — except 全自動,
  // which hands everything back to auto
  const prev = params;
  params = { ...DEFAULT_PARAMS, auto: true, response: prev.response };
  if (key !== 'auto') Object.assign(params, { vivid: prev.vivid, restore: prev.restore });
  const keep = key === 'auto' ? [] : (['vivid', 'restore'] as AutoKey[]).filter((k) => locked.has(k));
  locked.clear();
  for (const k of keep) locked.add(k);
  for (const [k, v] of Object.entries(pr.set) as [NumKey, number][]) {
    params[k] = v;
    if (isAutoKey(k)) locked.add(k);
  }
  if (pr.raw) {
    // 原始: the untouched picture, a clean starting point for manual work
    look = identityLook();
    lookChanged();
    hslUi.sync();
  }
  $<HTMLInputElement>('auto').checked = true;
  markPreset(key);
  refreshControls(lastState);
  requestRender();
}

function markPreset(key: string | null) {
  activePreset = key ?? '';
  document.querySelectorAll<HTMLButtonElement>('#presets button').forEach((b) =>
    b.classList.toggle('on', b.dataset.preset === activePreset),
  );
}

/* 豐富色彩: full auto already applies a mild dose (measured per frame); the
 * button locks a strong one, pressing again hands it back to auto. The
 * slider in 色彩 sets how strong. */
const VIVID_ON = 0.7;
let lastVivid = VIVID_ON;
const vividPressed = () => !isFollowingAuto('vivid') && params.vivid > 0;
function syncVivid() {
  $('vivid').setAttribute('aria-pressed', String(vividPressed()));
  $('vividNote').textContent = vividPressed()
    ? `強度 ${params.vivid.toFixed(2)} · 再按一下交還自動`
    : isFollowingAuto('vivid')
      ? `自動輕度套用中${lastState ? `（${lastState.effective.vivid.toFixed(2)}）` : ''} · 按一下加強`
      : '自動把光線與色彩算得更飽滿';
}
$('vivid').addEventListener('click', () => {
  if (vividPressed()) {
    lastVivid = params.vivid;
    if (params.auto) locked.delete('vivid');
    else params.vivid = 0;
  } else {
    params.vivid = lastVivid;
    if (params.auto) locked.add('vivid');
  }
  markPreset(null);
  refreshControls(lastState);
  requestRender();
});

/* 自動化流程: one tap each. 自動判斷流程 and 品質把關 are switches; the four
 * modules lock a measured-good strength (press again hands back to auto,
 * where 自動判斷流程 may still turn them on by need). */
const FLOW_LOCK: Partial<Record<NumKey, number>> = { fusion: 1, labCast: 0.5, seathru: 0.5, localWB: 0.5 };
const isSwitch = (k: NumKey) => k === 'autoPipeline' || k === 'qaGuard';
const flowPressed = (k: NumKey) => (isSwitch(k) ? params[k] >= 0.5 : !isFollowingAuto(k) && params[k] > 0);
const flowButtons = [...document.querySelectorAll<HTMLButtonElement>('#flow button[data-flow]')];
function syncFlow() {
  const st = lastState;
  const eff = (k: AutoKey) => (st ? st.effective[k] : params[k]);
  for (const b of flowButtons) {
    const k = b.dataset.flow as NumKey;
    const on = flowPressed(k);
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('engaged', !isSwitch(k) && eff(k as AutoKey) > 0.01);
    const note = b.querySelector<HTMLElement>('[data-note]')!;
    if (!st) continue;
    const q = st.stats.quality;
    switch (k) {
      case 'autoPipeline':
        note.textContent = on
          ? `Sea-thru ${eff('seathru').toFixed(2)} · 融合 ${eff('fusion').toFixed(2)} · Lab ${eff('labCast').toFixed(2)} · 補光 ${eff('localWB').toFixed(2)} · 強度 ×${st.stats.qaScale.toFixed(2)}`
          : '自然、不過度、不假色';
        break;
      case 'fusion':
        note.textContent = eff('fusion') > 0.01 ? `套用 ${eff('fusion').toFixed(2)}` : '平淡／混濁畫面';
        break;
      case 'labCast':
        note.textContent = `殘留 綠 ${st.stats.cast[0].toFixed(3)} · 藍 ${st.stats.cast[1].toFixed(3)}` + (eff('labCast') > 0.01 ? ` · 套用 ${eff('labCast').toFixed(2)}` : '');
        break;
      case 'seathru':
        note.textContent = eff('seathru') > 0.01 ? `套用 ${eff('seathru').toFixed(2)}（取代去霧）` : '遠近差大的場景';
        break;
      case 'localWB':
        note.textContent = `光源差異 ${st.stats.lightSpread.toFixed(3)}` + (eff('localWB') > 0.01 ? ` · 套用 ${eff('localWB').toFixed(2)}` : '');
        break;
      case 'qaGuard':
        note.textContent = q
          ? `溢出 ${(q.clip * 100).toFixed(1)}% · 雜訊 ×${q.noiseAmp.toFixed(1)} · 強度 ×${st.stats.qaScale.toFixed(2)}`
          : '避免過度處理';
        break;
    }
  }
}
for (const b of flowButtons)
  b.addEventListener('click', () => {
    const k = b.dataset.flow as NumKey;
    if (isSwitch(k)) params[k] = params[k] >= 0.5 ? 0 : 1;
    else if (flowPressed(k)) {
      if (params.auto) locked.delete(k as AutoKey);
      else params[k] = 0;
    } else {
      params[k] = FLOW_LOCK[k]!;
      if (params.auto) locked.add(k as AutoKey);
    }
    markPreset(null);
    refreshControls(lastState);
    requestRender();
  });

/* 🤖 AI 風格 (FUnIE-GAN, optional): the first press downloads the runtime and
 * the model; the network then runs on a small copy of each still (every
 * AI_REFRESH_S of video, and on cuts) and the GRADE pass applies its colour
 * and tone at full resolution. Pressing again returns to 全自動. */
declare const __ORT_VERSION__: string; // vite.config.ts
const MODEL_URL = `${import.meta.env.BASE_URL}models/funie-gan.fp16.onnx`;
const ORT_DIR = `${new URL(import.meta.env.BASE_URL, location.href).href}ort/${__ORT_VERSION__}/`;
let funie: Funie | null = null;
let funieLoad: Promise<Funie> | null = null;
let aiGuide: AiGuide | null = null;
let aiFor = '';
let aiBusy = false;
let aiMs = 0;
let aiMsg = '';
const aiKey = () => {
  const it = items[current];
  const t = it?.kind === 'video' ? Math.floor(it.video.currentTime / AI_REFRESH_S) : 0;
  return `${current}|${orient.rot}${orient.flip ? 'f' : ''}|${t}`;
};
function loadFunie(): Promise<Funie> {
  if (funieLoad) return funieLoad;
  aiMsg = '載入中…';
  syncAi();
  funieLoad = Funie.create(MODEL_URL, ORT_DIR, (got, total) => {
    aiMsg = `下載模型與執行環境 ${(got / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB…`;
    syncAi();
  }).then(
    (f) => {
      funie = f;
      aiMsg = '';
      return f;
    },
    (err) => {
      funieLoad = null;
      aiMsg = `載入失敗：${(err as Error).message} · 請確認網路後再按一次`;
      syncAi();
      throw err;
    },
  );
  return funieLoad;
}
/** Run the network on the frame now in the source texture. */
function aiInput(f: Funie): [Uint8Array, number, number] {
  const [nw, nh] = f.inputSize(proc.renderer.outW, proc.renderer.outH);
  return [proc.renderer.readAt(nw, nh), nw, nh];
}
/** After each frame: when AI 風格 is on and the guide is for another frame, refresh it (async). */
function refreshAi(cut: boolean) {
  if (params.aiStyle <= 0.001 || aiBusy || !items[current]) return;
  if (!funie) {
    if (!funieLoad) loadFunie().then(() => requestRender(), () => {});
    return;
  }
  const key = aiKey();
  if (key === aiFor && !cut) return;
  const blend = playing && !cut && aiFor.split('|')[0] === key.split('|')[0];
  aiFor = key;
  aiBusy = true;
  const [rgba, nw, nh] = aiInput(funie);
  const t0 = performance.now();
  funie.guide(rgba, nw, nh).then(
    (g) => {
      aiGuide = blendGuide(aiGuide, g, blend ? 0.5 : 1);
      aiMs = performance.now() - t0;
      aiBusy = false;
      syncAi();
      if (!playing) requestRender();
    },
    (err) => {
      aiBusy = false;
      aiMsg = `推論失敗：${(err as Error).message}`;
      syncAi();
    },
  );
}
const aiBtn = $<HTMLButtonElement>('aiStyle');
function syncAi() {
  const on = params.aiStyle > 0.001;
  aiBtn.setAttribute('aria-pressed', String(on && !!funie));
  aiBtn.classList.toggle('busy', !!funieLoad && !funie);
  const [nw, nh] = funie && proc.renderer.outW ? funie.inputSize(proc.renderer.outW, proc.renderer.outH) : [0, 0];
  $('aiNote').textContent =
    aiMsg ||
    (funie
      ? `${funie.backend === 'webgpu' ? 'WebGPU' : 'WASM'} · 推論 ${nw}×${nh}${aiMs ? ` · ${Math.round(aiMs)} ms` : ''}` +
        (on ? ` · 強度 ${params.aiStyle.toFixed(2)} · 再按一下回全自動` : '')
      : '選用 · 首次按下載入 14 MB 模型');
}
async function pressAi() {
  if (params.aiStyle > 0.001 && funie) {
    applyPreset('auto');
    syncAi();
    return;
  }
  if (!items[current] || !proc.state) return;
  aiBtn.disabled = true;
  try {
    const f = await loadFunie();
    // the guide first, so the first AI frame is already the network's
    const [rgba, nw, nh] = aiInput(f);
    const t0 = performance.now();
    aiGuide = await f.guide(rgba, nw, nh);
    aiMs = performance.now() - t0;
    aiFor = aiKey();
  } catch {
    return;
  } finally {
    aiBtn.disabled = false;
  }
  // the network's colour and tone alone (see AI_STYLE); restoration and speed stay
  const prev = params;
  params = { ...DEFAULT_PARAMS, auto: true, response: prev.response, restore: prev.restore };
  const keepRestore = locked.has('restore');
  locked.clear();
  if (keepRestore) locked.add('restore');
  for (const [k, v] of Object.entries(AI_STYLE) as [NumKey, number][]) {
    params[k] = v;
    if (isAutoKey(k)) locked.add(k);
  }
  $<HTMLInputElement>('auto').checked = true;
  markPreset(null);
  refreshControls(lastState);
  syncAi();
  requestRender();
}
aiBtn.addEventListener('click', () => void pressAi());

$<HTMLInputElement>('auto').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked;
  if (!on && lastState) for (const k of AUTO_KEYS) params[k] = lastState.effective[k];
  params.auto = on;
  locked.clear();
  markPreset(on ? 'auto' : null);
  requestRender();
});

/* ------------------------------------------------------------------ view */

document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    view.mode = Number(b.dataset.mode) as View['mode'];
    document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    updateLabels();
    redraw();
  }),
);
function updateLabels() {
  const has = current >= 0;
  $('lblLeft').classList.toggle('hidden', !has || view.mode !== 1);
  $('lblRight').classList.toggle('hidden', !has || view.mode !== 1);
  viewer.classList.toggle('splitting', view.mode === 1 && !picking);
}
function redraw() {
  if (!proc.state) return;
  proc.redraw(view);
}
function togglePressed(id: string, on: boolean) {
  $(id).setAttribute('aria-pressed', String(on));
}
$('clip').addEventListener('click', () => {
  view.clip = !view.clip;
  togglePressed('clip', view.clip);
  redraw();
});

let picking = false;
$('dropper').addEventListener('click', () => {
  picking = !picking;
  togglePressed('dropper', picking);
  viewer.classList.toggle('picking', picking);
  updateLabels();
  note.textContent = picking ? '點選畫面中應為白色／灰色的物體（沙地、氣瓶、白板）' : '';
});
$('clearPick').addEventListener('click', () => {
  proc.engine.pick = null;
  $('clearPick').classList.add('hidden');
  requestRender();
});
$<HTMLSelectElement>('previewRes').addEventListener('change', (e) => {
  previewCap = parseInt((e.target as HTMLSelectElement).value, 10);
  requestRender();
});

function uvFromEvent(e: PointerEvent): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
}
canvas.addEventListener('pointerdown', (e) => {
  if (current < 0) return;
  const [u, v] = uvFromEvent(e);
  if (picking) {
    proc.engine.pickAt(u, v);
    picking = false;
    togglePressed('dropper', false);
    viewer.classList.remove('picking');
    $('clearPick').classList.remove('hidden');
    note.textContent = '已設定白點；「清除白點」回到自動估計光源';
    updateLabels();
    requestRender();
    return;
  }
  if (view.mode !== 1) return;
  canvas.setPointerCapture(e.pointerId);
  view.split = u;
  redraw();
  const move = (ev: PointerEvent) => {
    view.split = uvFromEvent(ev)[0];
    redraw();
  };
  const up = () => {
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
  };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
});
viewer.addEventListener('keydown', (e) => {
  if (view.mode !== 1 || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  view.split = Math.min(1, Math.max(0, view.split + (e.key === 'ArrowLeft' ? -0.02 : 0.02)));
  e.preventDefault();
  redraw();
});

/* ---------------------------------------------------------------- intake */

async function loadImage(f: File): Promise<ImageItem> {
  const bitmap = await createImageBitmap(f, { imageOrientation: 'from-image' });
  return { kind: 'image', name: f.name, file: f, bitmap, w: bitmap.width, h: bitmap.height };
}

async function loadVideo(f: File): Promise<VideoItem> {
  const video = document.createElement('video');
  video.src = URL.createObjectURL(f);
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  await new Promise<void>((res, rej) => {
    const ok = () => (video.readyState >= 2 && video.videoWidth ? res() : undefined);
    video.addEventListener('loadeddata', ok);
    video.addEventListener('canplay', ok);
    video.addEventListener('error', () => rej(new Error('瀏覽器無法解碼這個影片（試試 MP4 H.264 或 WebM）')), { once: true });
  });
  return { kind: 'video', name: f.name, file: f, video, w: video.videoWidth, h: video.videoHeight, duration: video.duration };
}

async function addFiles(list: FileList | File[]) {
  const files = Array.from(list);
  let first = -1;
  for (const f of files) {
    try {
      const it = f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name) ? await loadVideo(f) : await loadImage(f);
      items.push(it);
      if (first < 0) first = items.length - 1;
    } catch (err) {
      note.textContent = `無法讀取 ${f.name}：${(err as Error).message}`;
    }
  }
  if (first >= 0) await select(first);
  renderStrip();
}

async function select(i: number) {
  stopPlayback();
  current = i;
  const it = items[i];
  $('empty').classList.add('hidden');
  $('transport').classList.toggle('hidden', it.kind !== 'video');
  $('photoExport').classList.toggle('hidden', it.kind !== 'image');
  $('videoExport').classList.toggle('hidden', it.kind !== 'video');
  proc.engine.reset();
  proc.engine.pick = null;
  $('clearPick').classList.add('hidden');
  if (it.kind === 'video') {
    it.video.playbackRate = parseFloat($<HTMLSelectElement>('playRate').value);
    $<HTMLInputElement>('seek').value = String(Math.round((it.video.currentTime / (it.duration || 1)) * 1000));
    updateTime(it);
  }
  updateLabels();
  renderStrip();
  lp.show($('lightPts').getAttribute('aria-pressed') === 'true');
  requestRender(true);
}

function renderStrip() {
  const strip = $('strip');
  strip.classList.toggle('hidden', items.length < 2);
  strip.innerHTML = '';
  items.forEach((it, i) => {
    const b = document.createElement('button');
    b.className = 'thumb' + (i === current ? ' on' : '');
    b.title = it.name;
    const c = document.createElement('canvas');
    c.height = 58;
    c.width = Math.max(1, Math.round((58 * it.w) / it.h));
    c.getContext('2d')!.drawImage(it.kind === 'image' ? it.bitmap : it.video, 0, 0, c.width, c.height);
    const k = document.createElement('span');
    k.className = 'kind';
    k.textContent = it.kind === 'image' ? '照片' : '影片';
    b.append(c, k);
    b.addEventListener('click', () => void select(i));
    strip.append(b);
  });
}

$('open').addEventListener('click', () => $<HTMLInputElement>('file').click());
$('empty').addEventListener('click', () => $<HTMLInputElement>('file').click());
$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files;
  if (f?.length) void addFiles(f);
});
for (const ev of ['dragenter', 'dragover'])
  viewer.addEventListener(ev, (e) => {
    e.preventDefault();
    viewer.classList.add('over');
  });
for (const ev of ['dragleave', 'drop'])
  viewer.addEventListener(ev, (e) => {
    e.preventDefault();
    viewer.classList.remove('over');
  });
viewer.addEventListener('drop', (e) => {
  const f = (e as DragEvent).dataTransfer?.files;
  if (f?.length) void addFiles(f);
});
window.addEventListener('paste', (e) => {
  const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
  if (files.length) void addFiles(files);
});

/* ----------------------------------------------------------------- video */

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function updateTime(it: VideoItem) {
  $('time').textContent = `${clock(it.video.currentTime)} / ${clock(it.duration)}`;
  if (document.activeElement !== $('seek'))
    $<HTMLInputElement>('seek').value = String(Math.round((it.video.currentTime / (it.duration || 1)) * 1000));
}

function stopPlayback() {
  const it = items[current];
  if (it?.kind === 'video') it.video.pause();
  playing = false;
  $('play').textContent = '▶ 播放';
}

$('play').addEventListener('click', async () => {
  const it = items[current];
  if (!it || it.kind !== 'video') return;
  if (playing) {
    stopPlayback();
    requestRender(true);
    return;
  }
  if (it.video.ended) it.video.currentTime = 0;
  playing = true;
  lastMediaTime = -1;
  $('play').textContent = '⏸ 暫停';
  it.video.requestVideoFrameCallback(onVideoFrame);
  try {
    await it.video.play();
  } catch {
    stopPlayback();
  }
});

$<HTMLInputElement>('seek').addEventListener('input', (e) => {
  const it = items[current];
  if (!it || it.kind !== 'video') return;
  it.video.currentTime = (parseInt((e.target as HTMLInputElement).value, 10) / 1000) * it.duration;
  lastMediaTime = -1;
});

document.addEventListener(
  'seeked',
  (e) => {
    const it = items[current];
    if (it?.kind === 'video' && e.target === it.video) {
      updateTime(it);
      if (!playing) requestRender(true);
    }
  },
  true,
);
document.addEventListener(
  'ended',
  (e) => {
    const it = items[current];
    if (it?.kind === 'video' && e.target === it.video) stopPlayback();
  },
  true,
);

/* ---------------------------------------------------------------- export */

const grade = () => ({
  params: { ...params },
  locked: new Set(locked),
  pick: proc.engine.pick,
  orient: { ...orient },
  look: cloneLook(look),
  ai: params.aiStyle > 0.001 ? aiGuide : null,
  aiModel: funie ?? undefined,
});
const baseName = (n: string) => n.replace(/\.[^.]+$/, '');
/** Inside the Android app (Capacitor): saving goes through native.ts. */
const isNativeApp = () => (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true;
/** Save a result; returns where it went (app) or '' (browser download). */
async function download(blob: Blob, name: string): Promise<string> {
  if (isNativeApp()) return (await import('./native.ts')).saveNative(blob, name);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return '';
}

async function savePhoto(it: ImageItem) {
  const mod = await loadExport();
  const type = $<HTMLSelectElement>('photoFormat').value as 'image/jpeg' | 'image/png' | 'image/webp';
  const blob = await mod.exportPhoto(it.bitmap, grade(), type, 0.95);
  const where = await download(blob, `${baseName(it.name)}-recovered.${type.split('/')[1].replace('jpeg', 'jpg')}`);
  return { blob, where };
}

$('savePhoto').addEventListener('click', async () => {
  const it = items[current];
  if (it?.kind !== 'image') return;
  note.textContent = `輸出 ${it.w}×${it.h}…`;
  try {
    const { blob, where } = await savePhoto(it);
    note.textContent = `已輸出 ${it.w}×${it.h}（${(blob.size / 1e6).toFixed(1)} MB）${where ? ` · ${where}` : ''}`;
  } catch (err) {
    note.textContent = `輸出失敗：${(err as Error).message}`;
  }
});
$('saveAll').addEventListener('click', async () => {
  const imgs = items.filter((x): x is ImageItem => x.kind === 'image');
  for (let i = 0; i < imgs.length; i++) {
    note.textContent = `輸出 ${i + 1} / ${imgs.length}…`;
    await savePhoto(imgs[i]);
    await new Promise((r) => setTimeout(r, 250));
  }
  note.textContent = `已輸出 ${imgs.length} 張`;
});

let cancelExport: (() => void) | null = null;
if (!('showSaveFilePicker' in window)) $('diskRow').classList.add('hidden');

$('vexport').addEventListener('click', async () => {
  const it = items[current];
  if (it?.kind !== 'video') return;
  stopPlayback();
  const format = $<HTMLSelectElement>('vformat').value as 'mp4' | 'webm';
  let writable: FileSystemWritableFileStream | undefined;
  if ($<HTMLInputElement>('toDisk').checked && 'showSaveFilePicker' in window) {
    try {
      const handle = await (
        window as unknown as { showSaveFilePicker: (o: object) => Promise<FileSystemFileHandle> }
      ).showSaveFilePicker({ suggestedName: `${baseName(it.name)}-recovered.${format}` });
      writable = await handle.createWritable();
    } catch {
      return;
    }
  }
  const btn = $<HTMLButtonElement>('vexport');
  btn.disabled = true;
  $('vcancel').classList.remove('hidden');
  $('vprogress').classList.remove('hidden');
  const t0 = performance.now();
  try {
    const mod = await loadExport();
    const res = await mod.exportVideo(it.file, {
      ...grade(),
      maxEdge: parseInt($<HTMLSelectElement>('vres').value, 10),
      format,
      writable,
      speed: parseFloat($<HTMLSelectElement>('vspeed').value),
      onCancelable: (c) => (cancelExport = c),
      onProgress: (p, frames) => {
        const el = (performance.now() - t0) / 1000;
        const eta = p > 0.02 ? (el / p) * (1 - p) : NaN;
        $('vbar').style.width = `${(p * 100).toFixed(1)}%`;
        $('vstat').textContent = `${Math.round(p * 100)}% · ${frames} 幀` + (isFinite(eta) ? ` · 剩 ${clock(eta)}` : '');
      },
    });
    if (res.canceled) note.textContent = '已取消';
    else {
      const where = res.blob ? await download(res.blob, `${baseName(it.name)}-recovered.${format}`) : '';
      note.textContent = `完成：${res.frames} 幀 · ${res.width}×${res.height} · ${res.codec.toUpperCase()} · ${clock((performance.now() - t0) / 1000)}${where ? ` · ${where}` : ''}`;
    }
  } catch (err) {
    note.textContent = `匯出失敗：${(err as Error).message}`;
  } finally {
    btn.disabled = false;
    cancelExport = null;
    $('vcancel').classList.add('hidden');
  }
});
$('vcancel').addEventListener('click', () => {
  cancelExport?.();
  note.textContent = '取消中…';
});

/* ------------------------------------------------------- look: curves + HSL */

function lookChanged() {
  proc.setLook(look);
  if (proc.state) {
    proc.redraw(view); // the look lives in the final pass: no re-grade needed
    if (lastState) {
      const px = proc.renderer.readScope(lastState);
      drawHistogram(px);
      curvesUi?.draw(px);
    }
  }
  markPreset(null);
}
const curvesUi = curveEditor($('curves'), () => look.curves, lookChanged);
const hslUi = hslPanel($('hsl'), () => look.hsl, lookChanged);

/* --------------------------------------------------------- rotate / flip */

function setOrient(next: Orient) {
  orient = { rot: next.rot, flip: next.flip };
  proc.setOrient(orient);
  $('flipH').setAttribute('aria-pressed', String(orient.flip));
  // the frame changed shape: re-analyse from scratch, a white point no longer
  // sits where it was picked
  proc.engine.reset();
  proc.engine.pick = null;
  $('clearPick').classList.add('hidden');
  requestRender(true);
}
$('rotL').addEventListener('click', () => setOrient({ ...orient, rot: ((orient.rot + 3) % 4) as Orient['rot'] }));
$('rotR').addEventListener('click', () => setOrient({ ...orient, rot: ((orient.rot + 1) % 4) as Orient['rot'] }));
$('flipH').addEventListener('click', () => setOrient({ ...orient, flip: !orient.flip }));

/* ------------------------------------------------------------------ speed */

$<HTMLSelectElement>('playRate').addEventListener('change', (e) => {
  const it = items[current];
  if (it?.kind === 'video') it.video.playbackRate = parseFloat((e.target as HTMLSelectElement).value);
});
$<HTMLSelectElement>('vspeed').addEventListener('change', (e) => {
  $('speedNote').classList.toggle('hidden', (e.target as HTMLSelectElement).value === '1');
});

/* --------------------------------------------- light control points */

const BEAM_KEYS = ['beamX', 'beamY'] as const;
const SURF_KEYS = ['surfAx', 'surfAy', 'surfBx', 'surfBy'] as const;
const eff = (k: AutoKey) => (isFollowingAuto(k) && lastState ? lastState.effective[k] : params[k]);
const lp = lightPoints(
  viewer,
  canvas,
  {
    points: () => ({
      beam: [eff('beamX'), eff('beamY')],
      surfA: [eff('surfAx'), eff('surfAy')],
      surfB: [eff('surfBx'), eff('surfBy')],
      beamAuto: BEAM_KEYS.every((k) => isFollowingAuto(k)),
      surfAuto: SURF_KEYS.every((k) => isFollowingAuto(k)),
      beamActive: Math.abs(eff('beams')) > 0.02,
      surfActive: eff('surfaceHL') > 0.02 || params.surfaceTone !== 0 || params.surfaceWarm !== 0,
    }),
    move: (id: PointId, u: number, v: number) => movePoint(id, u, v),
    release: (group) => releasePoints(group === 'beam' ? BEAM_KEYS : SURF_KEYS),
  },
  () => releasePoints(POSITION_KEYS),
);
function movePoint(id: PointId, u: number, v: number) {
  // the whole group becomes manual, starting from what auto had
  const group = id === 'beam' ? BEAM_KEYS : SURF_KEYS;
  for (const k of group) if (isFollowingAuto(k)) params[k] = eff(k);
  const [kx, ky] = id === 'beam' ? BEAM_KEYS : id === 'surfA' ? (['surfAx', 'surfAy'] as const) : (['surfBx', 'surfBy'] as const);
  params[kx] = u;
  params[ky] = v;
  for (const k of group) if (isAutoKey(k)) locked.add(k);
  // moving a point of an effect that is off turns it on, so the drag shows
  if (id === 'beam' && Math.abs(eff('beams')) < 0.05) {
    params.beams = 0.4;
    locked.add('beams');
  }
  if (id !== 'beam' && eff('surfaceHL') < 0.05 && params.surfaceTone === 0 && params.surfaceWarm === 0) {
    params.surfaceHL = 0.6;
    locked.add('surfaceHL');
  }
  markPreset(null);
  refreshControls(lastState);
  requestRender();
}
function releasePoints(keys: readonly AutoKey[]) {
  for (const k of keys) locked.delete(k);
  refreshControls(lastState);
  requestRender();
}
function showLightPoints(on: boolean) {
  togglePressed('lightPts', on);
  lp.show(on && current >= 0);
  if (on) {
    const g = [...document.querySelectorAll<HTMLDetailsElement>('#panel details.group')].find((d) => d.textContent?.includes('光束'));
    if (g) g.open = true;
  }
}
$('lightPts').addEventListener('click', () => showLightPoints($('lightPts').getAttribute('aria-pressed') !== 'true'));

/* ------------------------------------------------------------------ init */

buildControls();
buildPresets();
updateLabels();
const blockUi = movableBlocks($('panel'), $('resetBlocks'));

/* --------------------------------------------------- automation test hook */

let lastExport: Blob | null = null;

function outputStats(px: Uint8Array) {
  let r = 0, g = 0, b = 0, l = 0, l2 = 0;
  const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) {
    r += px[i]; g += px[i + 1]; b += px[i + 2];
    const y = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    l += y; l2 += y * y;
  }
  return { r: r / n, g: g / n, b: b / n, contrast: Math.sqrt(Math.max(0, l2 / n - (l / n) ** 2)) };
}

Object.assign(window as unknown as Record<string, unknown>, {
  __uw: {
    addFiles: (files: File[]) => addFiles(files),
    /** Render synchronously now and report output + source statistics. */
    render() {
      dirty = true;
      renderNow();
      const st = proc.state!;
      return {
        out: outputStats(proc.renderer.readScope(st)),
        src: outputStats(proc.renderer.readSmall()),
        stats: st.stats,
        effective: st.effective,
        profile: { mix: st.mixAmt, pull: st.pullAmt, phys: st.physAmt },
        flow: { fusion: st.fusion, lab: st.lab.amount, seathru: st.seathru.amount, localWB: st.lwb.amount, qaScale: st.stats.qaScale, quality: st.stats.quality },
        ms: proc.lastFrameMs,
        size: [proc.renderer.pw, proc.renderer.ph],
      };
    },
    setParam(k: NumKey, v: number) {
      params[k] = v;
      if (isAutoKey(k)) locked.add(k);
      refreshControls(lastState);
    },
    unlock(k: AutoKey) {
      locked.delete(k);
    },
    /** Show the light control-point overlay; returns handle centres (client px). */
    showLightPoints(on: boolean) {
      showLightPoints(on);
      return on ? { beam: lp.handleCenter('beam'), surfA: lp.handleCenter('surfA'), surfB: lp.handleCenter('surfB') } : null;
    },
    lightPoints: () => ({
      beam: [eff('beamX'), eff('beamY')],
      surfA: [eff('surfAx'), eff('surfAy')],
      surfB: [eff('surfBx'), eff('surfBy')],
      locked: POSITION_KEYS.filter((k) => locked.has(k)),
    }),
    vividState: () => ({ pressed: vividPressed(), locked: locked.has('vivid'), value: params.vivid }),
    preset: (k: string) => applyPreset(k),
    setView(v: Partial<View>) {
      Object.assign(view, v);
      document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) =>
        b.classList.toggle('on', Number(b.dataset.mode) === view.mode),
      );
      togglePressed('clip', view.clip);
      updateLabels();
      redraw();
    },
    setOrient: (o: Orient) => setOrient(o),
    /** Replace curves / HSL (test hook); omitted parts stay. */
    setLook(l: Partial<Look>) {
      look = { curves: l.curves ?? look.curves, hsl: l.hsl ?? look.hsl };
      lookChanged();
      hslUi.sync();
    },
    resetLook() {
      look = identityLook();
      lookChanged();
      hslUi.sync();
    },
    outputSize: () => [proc.renderer.pw, proc.renderer.ph],
    /** Source pixels at analysis resolution, oriented like the output. */
    sourcePixels() {
      return { w: proc.renderer.sw, h: proc.renderer.sh, px: Array.from(proc.renderer.readSmall()) };
    },
    videoRate() {
      const it = items[current];
      return it?.kind === 'video' ? it.video.playbackRate : null;
    },
    setPreview(cap: number) {
      previewCap = cap;
    },
    pickAt: (u: number, v: number) => proc.engine.pickAt(u, v),
    /** Benchmark: N forced full renders (upload + analysis + all GPU passes). */
    bench(n: number) {
      const it = items[current];
      const src = it.kind === 'image' ? it.bitmap : it.video;
      const t0 = performance.now();
      let last = 0;
      for (let i = 0; i < n; i++) {
        proc.frame(src, it.w, it.h, { params, locked, dt: 1 / 30, ai: aiGuide }, view);
        last = proc.renderer.readScope(proc.state!)[0]; // forces GPU completion
      }
      return { msPerFrame: (performance.now() - t0) / n, size: [proc.renderer.pw, proc.renderer.ph], last };
    },
    /** Play the current video to the end, sampling the tracker as it goes. */
    async playThrough(maxMs = 60000, rate = 1) {
      const it = items[current];
      if (it?.kind !== 'video') throw new Error('no video');
      it.video.playbackRate = rate;
      it.video.currentTime = 0;
      await new Promise((r) => it.video.addEventListener('seeked', r, { once: true }));
      const trace: { t: number; exposure: number; redComp: number; blueComp: number; illumR: number; water: string; cut: boolean; ms: number }[] = [];
      let frames = 0;
      const sample = () => {
        const st = proc.state!;
        trace.push({
          t: it.video.currentTime,
          exposure: st.effective.exposure,
          redComp: st.effective.redComp,
          blueComp: st.effective.blueComp,
          illumR: st.stats.illum[0],
          water: st.stats.water,
          cut: st.stats.sceneCut,
          ms: proc.lastFrameMs,
        });
      };
      $('play').click();
      const t0 = performance.now();
      while (!it.video.ended && performance.now() - t0 < maxMs) {
        await new Promise((r) => setTimeout(r, 40));
        if (proc.state && playing) {
          frames++;
          sample();
        }
      }
      stopPlayback();
      return { trace, polled: frames, wall: performance.now() - t0 };
    },
    async exportVideo(opts: { maxEdge: number; format: 'mp4' | 'webm'; speed?: number }) {
      const it = items[current];
      if (it?.kind !== 'video') throw new Error('no video');
      const mod = await loadExport();
      const t0 = performance.now();
      const res = await mod.exportVideo(it.file, { ...grade(), ...opts });
      const probe = res.blob ? await mod.countFrames(res.blob) : null;
      lastExport = res.blob;
      return { ...res, blob: undefined, size: res.blob?.size ?? 0, ms: performance.now() - t0, probe };
    },
    /** Mean colour of a frame of the last exported video, and of the source. */
    async exportedFrameStats(t: number) {
      const it = items[current];
      const mod = await loadExport();
      return {
        out: lastExport ? await mod.frameStats(lastExport, t) : null,
        src: it?.kind === 'video' ? await mod.frameStats(it.file, t) : null,
      };
    },
    loadExport,
    /** Output pixels at analysis resolution (RGBA), plus that resolution. */
    outputPixels() {
      const px = proc.renderer.readScope(proc.state!);
      return { w: proc.renderer.sw, h: proc.renderer.sh, px: Array.from(px) };
    },
    async exportPhoto(type: 'image/jpeg' | 'image/png') {
      const it = items[current];
      if (it?.kind !== 'image') throw new Error('no image');
      const mod = await loadExport();
      const blob = await mod.exportPhoto(it.bitmap, grade(), type, 0.95);
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const cx = c.getContext('2d')!;
      cx.drawImage(bmp, 0, 0);
      const s = Math.max(1, Math.floor(bmp.width / 256));
      const d = cx.getImageData(0, 0, bmp.width, bmp.height).data;
      const px: number[] = [];
      for (let y = 0; y < bmp.height; y += s) for (let x = 0; x < bmp.width; x += s) {
        const i = (y * bmp.width + x) * 4;
        px.push(d[i], d[i + 1], d[i + 2], 255);
      }
      return { size: blob.size, type: blob.type, w: bmp.width, h: bmp.height, step: s, px, stats: outputStats(new Uint8Array(px)) };
    },
    state: () => ({ params: { ...params }, locked: [...locked], preset: activePreset, view: { ...view } }),
    /** Panel block order (keys), and moving one (test hooks). */
    blocks: () => blockUi.order(),
    moveBlock: (key: string, to: number) => blockUi.move(key, to),
    /** 🤖 AI 風格: press the button (awaits model load + first guide). */
    pressAi: () => pressAi(),
    aiState: () => ({
      loaded: !!funie,
      backend: funie?.backend ?? null,
      guide: aiGuide ? [aiGuide.gx, aiGuide.gy] : null,
      ms: aiMs,
      busy: aiBusy,
      msg: aiMsg,
      pressed: aiBtn.getAttribute('aria-pressed') === 'true',
    }),
    /** Network output vs the grid approximation, both at network size (test hook). */
    async aiFidelity() {
      if (!funie || !aiGuide) return null;
      const [rgba, nw, nh] = aiInput(funie);
      const net = await funie.enhance(rgba, nw, nh);
      return { w: nw, h: nh, src: Array.from(rgba), net: Array.from(net), guide: { gx: aiGuide.gx, gy: aiGuide.gy, m: Array.from(aiGuide.m) } };
    },
  },
});
