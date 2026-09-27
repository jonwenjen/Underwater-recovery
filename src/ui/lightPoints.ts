/**
 * On-image control points for the light controls:
 *  - ☀ the light source the beams converge on (may sit outside the frame;
 *    it is then drawn at the viewer edge, dashed, and can be dragged beyond it)
 *  - A → B the surface-highlight gradient (full effect at A, none past B)
 *
 * Positions are in output uv (0..1 over the displayed frame). Dragging a point
 * hands it to the host, which locks those values against auto; double-click a
 * point (or 自動定位) gives it back.
 */
export type PointId = 'beam' | 'surfA' | 'surfB';

export interface LightPointsHost {
  points(): {
    beam: [number, number];
    surfA: [number, number];
    surfB: [number, number];
    beamAuto: boolean;
    surfAuto: boolean;
    beamActive: boolean;
    surfActive: boolean;
  };
  move(id: PointId, u: number, v: number): void;
  release(group: 'beam' | 'surface'): void;
}

const NS = 'http://www.w3.org/2000/svg';
const LIMITS: Record<PointId, [number, number, number, number]> = {
  beam: [-1.5, 2.5, -2, 0.5],
  surfA: [-0.5, 1.5, -0.5, 1.5],
  surfB: [-0.5, 1.5, -0.5, 1.5],
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function lightPoints(viewer: HTMLElement, canvas: HTMLCanvasElement, host: LightPointsHost, onAutoAll: () => void) {
  const root = document.createElement('div');
  root.className = 'lp hidden';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'lp-svg');
  const fan = document.createElementNS(NS, 'g');
  fan.setAttribute('class', 'lp-fan');
  const grad = document.createElementNS(NS, 'g');
  grad.setAttribute('class', 'lp-grad');
  svg.append(fan, grad);

  const handles = new Map<PointId, SVGGElement>();
  const mk = (id: PointId, label: string, title: string) => {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', `lp-h lp-${id}`);
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'slider');
    g.setAttribute('aria-label', title);
    g.dataset.id = id;
    const t = document.createElementNS(NS, 'title');
    t.textContent = `${title}（拖曳移動、方向鍵微調、雙擊交還自動）`;
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('r', '13');
    const tx = document.createElementNS(NS, 'text');
    tx.setAttribute('text-anchor', 'middle');
    tx.setAttribute('dy', '0.35em');
    tx.textContent = label;
    g.append(t, c, tx);
    svg.append(g);
    handles.set(id, g);
    return g;
  };
  mk('beam', '☀', '光束光源');
  mk('surfA', 'A', '水面高光 A（水面，全效果）');
  mk('surfB', 'B', '水面高光 B（漸層結束）');

  const bar = document.createElement('div');
  bar.className = 'lp-bar';
  const autoBtn = document.createElement('button');
  autoBtn.type = 'button';
  autoBtn.textContent = '自動定位';
  autoBtn.title = '光源與水面控制點交還自動偵測';
  autoBtn.addEventListener('click', onAutoAll);
  const hint = document.createElement('span');
  hint.textContent = '☀ 光源可拖到畫面外 · A→B 水面漸層';
  bar.append(autoBtn, hint);
  root.append(svg, bar);
  viewer.append(root);

  let geo = { ox: 0, oy: 0, cw: 1, ch: 1, vw: 1, vh: 1 };
  const measure = () => {
    const vr = viewer.getBoundingClientRect(),
      cr = canvas.getBoundingClientRect();
    geo = { ox: cr.left - vr.left, oy: cr.top - vr.top, cw: Math.max(1, cr.width), ch: Math.max(1, cr.height), vw: vr.width, vh: vr.height };
    svg.setAttribute('viewBox', `0 0 ${geo.vw} ${geo.vh}`);
    svg.setAttribute('width', String(geo.vw));
    svg.setAttribute('height', String(geo.vh));
  };
  const toPx = (u: number, v: number): [number, number] => [geo.ox + u * geo.cw, geo.oy + v * geo.ch];

  const line = (parent: SVGGElement, x1: number, y1: number, x2: number, y2: number, cls = '') => {
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('x1', x1.toFixed(1));
    l.setAttribute('y1', y1.toFixed(1));
    l.setAttribute('x2', x2.toFixed(1));
    l.setAttribute('y2', y2.toFixed(1));
    if (cls) l.setAttribute('class', cls);
    parent.append(l);
  };

  let shown = false;
  function update() {
    if (!shown) return;
    measure();
    const p = host.points();
    const pad = 14;
    const place = (id: PointId, uv: [number, number], auto: boolean, active: boolean) => {
      const [x, y] = toPx(uv[0], uv[1]);
      const cx = clamp(x, pad, geo.vw - pad),
        cy = clamp(y, pad, geo.vh - pad);
      const g = handles.get(id)!;
      g.setAttribute('transform', `translate(${cx.toFixed(1)},${cy.toFixed(1)})`);
      g.classList.toggle('off', cx !== x || cy !== y);
      g.classList.toggle('auto', auto);
      g.classList.toggle('idle', !active);
      g.setAttribute('aria-valuetext', `${uv[0].toFixed(2)}, ${uv[1].toFixed(2)}${auto ? '（自動）' : ''}`);
    };
    place('beam', p.beam, p.beamAuto, p.beamActive);
    place('surfA', p.surfA, p.surfAuto, p.surfActive);
    place('surfB', p.surfB, p.surfAuto, p.surfActive);

    // beam fan: rays from the (true, possibly off-frame) source across the frame
    fan.replaceChildren();
    fan.classList.toggle('idle', !p.beamActive);
    const [sx, sy] = toPx(p.beam[0], p.beam[1]);
    for (let i = 0; i <= 6; i++) {
      const [tx, ty] = toPx(-0.1 + (1.2 * i) / 6, 1);
      line(fan, sx, sy, tx, ty);
    }
    // gradient: A→B plus the start / end lines across the frame
    grad.replaceChildren();
    grad.classList.toggle('idle', !p.surfActive);
    const [ax, ay] = toPx(p.surfA[0], p.surfA[1]),
      [bx, by] = toPx(p.surfB[0], p.surfB[1]);
    let dx = bx - ax,
      dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const L = 4000;
    line(grad, ax - dy * L, ay + dx * L, ax + dy * L, ay - dx * L, 'full');
    line(grad, bx - dy * L, by + dx * L, bx + dy * L, by - dx * L, 'end');
    line(grad, ax, ay, bx, by, 'axis');
  }

  const uvAt = (e: PointerEvent, id: PointId): [number, number] => {
    const cr = canvas.getBoundingClientRect();
    const [x0, x1, y0, y1] = LIMITS[id];
    return [clamp((e.clientX - cr.left) / cr.width, x0, x1), clamp((e.clientY - cr.top) / cr.height, y0, y1)];
  };
  for (const [id, g] of handles) {
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      g.setPointerCapture(e.pointerId);
      g.classList.add('drag');
      const move = (ev: PointerEvent) => {
        const [u, v] = uvAt(ev, id);
        host.move(id, u, v);
        update();
      };
      const up = () => {
        g.classList.remove('drag');
        g.removeEventListener('pointermove', move);
        g.removeEventListener('pointerup', up);
        g.removeEventListener('pointercancel', up);
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
      g.addEventListener('pointercancel', up);
    });
    g.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      host.release(id === 'beam' ? 'beam' : 'surface');
      update();
    });
    g.addEventListener('keydown', (e) => {
      const d = e.shiftKey ? 0.1 : 0.01;
      const step: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] };
      const s = step[e.key];
      if (!s) return;
      e.preventDefault();
      e.stopPropagation();
      const p = host.points()[id];
      const [x0, x1, y0, y1] = LIMITS[id];
      host.move(id, clamp(p[0] + s[0], x0, x1), clamp(p[1] + s[1], y0, y1));
      update();
    });
  }

  new ResizeObserver(() => update()).observe(viewer);

  return {
    show(on: boolean) {
      shown = on;
      root.classList.toggle('hidden', !on);
      update();
    },
    get shown() {
      return shown;
    },
    update,
    /** Viewer-pixel centre of a handle (for tests). */
    handleCenter(id: PointId): [number, number] {
      const r = handles.get(id)!.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    },
  };
}
