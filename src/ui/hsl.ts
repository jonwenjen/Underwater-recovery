/**
 * HSL mixer: 色相 / 飽和度 / 明亮度 tabs, one slider per colour band
 * (紅 橙 黃 綠 青 藍 紫 洋紅). Double-click a label to reset that band.
 */
import { HSL_BANDS, type Hsl } from '../engine/look.ts';

type Mode = 'h' | 's' | 'l';
const MODES: [Mode, string][] = [
  ['h', '色相'],
  ['s', '飽和度'],
  ['l', '明亮度'],
];

export interface HslPanel {
  sync(): void;
}

export function hslPanel(host: HTMLElement, hsl: () => Hsl, onChange: () => void): HslPanel {
  let mode: Mode = 's';
  host.innerHTML = `
    <div class="ctabs" role="tablist">${MODES.map(([k, l]) => `<button data-mode="${k}" role="tab">${l}</button>`).join('')}
      <button class="creset" title="重設這一頁（雙擊：HSL 全部重設）">重設</button>
    </div>
    <div class="hslrows"></div>`;
  const rowsHost = host.querySelector<HTMLElement>('.hslrows')!;
  const inputs: HTMLInputElement[] = [];
  const outs: HTMLOutputElement[] = [];
  HSL_BANDS.forEach((b, i) => {
    const row = document.createElement('div');
    row.className = 'srow hslrow';
    const css = `rgb(${b.rgb.map((v) => Math.round(v * 255)).join(',')})`;
    row.innerHTML = `<span class="name" title="雙擊恢復 0"><i class="dot" style="background:${css}"></i>${b.label}</span><output></output><span class="nobadge"></span>`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '-100';
    input.max = '100';
    input.step = '1';
    input.setAttribute('aria-label', `${b.label}`);
    input.addEventListener('input', () => {
      hsl()[mode][i] = parseFloat(input.value);
      outs[i].textContent = fmt(hsl()[mode][i]);
      onChange();
    });
    row.querySelector('.name')!.addEventListener('dblclick', () => {
      hsl()[mode][i] = 0;
      sync();
      onChange();
    });
    row.append(input);
    rowsHost.append(row);
    inputs.push(input);
    outs.push(row.querySelector('output')!);
  });
  const fmt = (v: number) => (v > 0 ? `+${v}` : `${v}`);
  const tabs = host.querySelectorAll<HTMLButtonElement>('[data-mode]');
  tabs.forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.mode as Mode;
      sync();
    }),
  );
  const reset = host.querySelector<HTMLButtonElement>('.creset')!;
  reset.addEventListener('click', () => {
    hsl()[mode].fill(0);
    sync();
    onChange();
  });
  reset.addEventListener('dblclick', () => {
    const x = hsl();
    x.h.fill(0);
    x.s.fill(0);
    x.l.fill(0);
    sync();
    onChange();
  });
  function sync() {
    tabs.forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    const v = hsl()[mode];
    inputs.forEach((inp, i) => {
      inp.value = String(v[i]);
      outs[i].textContent = fmt(v[i]);
    });
  }
  sync();
  return { sync };
}
