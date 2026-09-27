/**
 * Curve editor: RGB master + R / G / B, Lightroom-style.
 * Tap the curve area to add a point, drag to move, double-tap a point to
 * delete it (end points only move). Pointer events, so it works on touch.
 */
import { curveFn, type CurveChannel, type Curves, type Pt } from '../engine/look.ts';

const COLORS: Record<CurveChannel, string> = { rgb: '#e6f3fb', r: '#ff6b6b', g: '#5be37d', b: '#5aa2ff' };
const LABELS: Record<CurveChannel, string> = { rgb: 'RGB', r: 'R', g: 'G', b: 'B' };
const HIT = 0.05;

export interface CurveEditor {
  /** Redraw; pass the current output pixels (RGBA) to show the histogram. */
  draw(px?: Uint8Array): void;
  readonly channel: CurveChannel;
}

export function curveEditor(host: HTMLElement, curves: () => Curves, onChange: () => void): CurveEditor {
  let ch: CurveChannel = 'rgb';
  let lastPx: Uint8Array | undefined;
  host.innerHTML = `
    <div class="ctabs" role="tablist">${(Object.keys(LABELS) as CurveChannel[])
      .map((k) => `<button data-ch="${k}" role="tab" style="--c:${COLORS[k]}">${LABELS[k]}</button>`)
      .join('')}
      <button class="creset" title="重設這條曲線（雙擊：全部重設）">重設</button>
    </div>
    <canvas class="curvecv" width="512" height="512" aria-label="曲線編輯：點一下新增控制點、拖曳移動、雙擊控制點刪除"></canvas>
    <p class="chint">點一下新增點 · 拖曳調整 · 雙擊刪除</p>`;
  const cv = host.querySelector('canvas')!;
  const cx = cv.getContext('2d')!;
  const tabs = host.querySelectorAll<HTMLButtonElement>('[data-ch]');
  const selectTab = (k: CurveChannel) => {
    ch = k;
    tabs.forEach((b) => b.classList.toggle('on', b.dataset.ch === k));
    draw(lastPx);
  };
  tabs.forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.ch as CurveChannel)));
  const resetBtn = host.querySelector<HTMLButtonElement>('.creset')!;
  resetBtn.addEventListener('click', () => {
    curves()[ch] = [
      [0, 0],
      [1, 1],
    ];
    onChange();
    draw(lastPx);
  });
  resetBtn.addEventListener('dblclick', () => {
    const c = curves();
    for (const k of Object.keys(LABELS) as CurveChannel[])
      c[k] = [
        [0, 0],
        [1, 1],
      ];
    onChange();
    draw(lastPx);
  });

  function draw(px?: Uint8Array) {
    if (px) lastPx = px;
    const W = cv.width,
      H = cv.height;
    cx.clearRect(0, 0, W, H);
    cx.fillStyle = 'rgba(0,0,0,0.35)';
    cx.fillRect(0, 0, W, H);
    // histogram of the active channel (or luminance for RGB)
    if (lastPx) {
      const bins = new Uint32Array(64);
      for (let i = 0; i < lastPx.length; i += 4) {
        const v =
          ch === 'rgb'
            ? 0.2126 * lastPx[i] + 0.7152 * lastPx[i + 1] + 0.0722 * lastPx[i + 2]
            : lastPx[i + (ch === 'r' ? 0 : ch === 'g' ? 1 : 2)];
        bins[Math.min(63, v >> 2)]++;
      }
      let max = 1;
      for (let i = 1; i < 63; i++) max = Math.max(max, bins[i]);
      cx.fillStyle = ch === 'rgb' ? 'rgba(230,243,251,0.12)' : COLORS[ch] + '26';
      for (let i = 0; i < 64; i++) {
        const h = Math.min(1, bins[i] / max) * H * 0.9;
        cx.fillRect((i / 64) * W, H - h, W / 64 + 1, h);
      }
    }
    // grid + identity
    cx.strokeStyle = 'rgba(140,200,235,0.14)';
    cx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      cx.beginPath();
      cx.moveTo((i / 4) * W, 0);
      cx.lineTo((i / 4) * W, H);
      cx.moveTo(0, (i / 4) * H);
      cx.lineTo(W, (i / 4) * H);
      cx.stroke();
    }
    cx.setLineDash([6, 6]);
    cx.beginPath();
    cx.moveTo(0, H);
    cx.lineTo(W, 0);
    cx.stroke();
    cx.setLineDash([]);
    const c = curves();
    // the other channels, faint
    for (const k of Object.keys(LABELS) as CurveChannel[]) {
      if (k === ch) continue;
      plot(c[k], COLORS[k], 0.25, 2);
    }
    plot(c[ch], COLORS[ch], 1, 4);
    for (const [x, y] of c[ch]) {
      cx.beginPath();
      cx.arc(x * W, (1 - y) * H, 11, 0, Math.PI * 2);
      cx.fillStyle = '#06121f';
      cx.fill();
      cx.lineWidth = 4;
      cx.strokeStyle = COLORS[ch];
      cx.stroke();
    }
  }

  function plot(pts: Pt[], color: string, alpha: number, width: number) {
    const f = curveFn(pts);
    const W = cv.width,
      H = cv.height;
    cx.globalAlpha = alpha;
    cx.strokeStyle = color;
    cx.lineWidth = width;
    cx.beginPath();
    for (let i = 0; i <= 128; i++) {
      const x = i / 128;
      const X = x * W,
        Y = (1 - f(x)) * H;
      if (i === 0) cx.moveTo(X, Y);
      else cx.lineTo(X, Y);
    }
    cx.stroke();
    cx.globalAlpha = 1;
  }

  const toUnit = (e: PointerEvent): Pt => {
    const r = cv.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  };
  const nearest = (p: Pt) => {
    const pts = curves()[ch];
    let best = -1,
      bd = HIT;
    pts.forEach(([x, y], i) => {
      const d = Math.hypot(x - p[0], y - p[1]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };

  let lastTap = { i: -1, t: 0 };
  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const p = toUnit(e);
    const c = curves();
    let pts = c[ch];
    let i = nearest(p);
    const now = performance.now();
    if (i >= 0 && lastTap.i === i && now - lastTap.t < 350 && i > 0 && i < pts.length - 1) {
      // double-tap on an inner point: delete it
      pts.splice(i, 1);
      lastTap = { i: -1, t: 0 };
      onChange();
      draw();
      return;
    }
    if (i < 0) {
      // add a point where tapped, keeping x-order
      pts.push([p[0], p[1]]);
      pts.sort((a, b) => a[0] - b[0]);
      c[ch] = pts = pts;
      i = pts.findIndex((q) => q[0] === p[0] && q[1] === p[1]);
      onChange();
    }
    lastTap = { i, t: now };
    cv.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const q = toUnit(ev);
      const arr = curves()[ch];
      const lo = i > 0 ? arr[i - 1][0] + 0.01 : 0;
      const hi = i < arr.length - 1 ? arr[i + 1][0] - 0.01 : 1;
      // end points keep their side; inner points stay between neighbours
      arr[i] = [i === 0 ? Math.min(q[0], hi) : i === arr.length - 1 ? Math.max(q[0], lo) : Math.min(hi, Math.max(lo, q[0])), q[1]];
      onChange();
      draw();
    };
    const up = () => {
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
    };
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    draw();
  });

  selectTab('rgb');
  return {
    draw,
    get channel() {
      return ch;
    },
  };
}
