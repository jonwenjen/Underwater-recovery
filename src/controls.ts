import { DEFAULT_PARAMS } from './pipeline';
import type { Params } from './pipeline';

/** Shared control definitions and the slider/preset wiring used by both modes. */

export const PRESETS: Record<string, Partial<Params>> = {
  auto: {},
  blue: {
    redStrength: 0.9,
    warm: 12,
    greenBias: -6,
    dehazeStrength: 0.9,
    claheClip: 2.2,
    sharpenAmount: 0.7,
    gamma: 1.16,
    saturation: 1.22,
  },
  green: {
    redStrength: 0.7,
    warm: 4,
    greenBias: -22,
    dehazeStrength: 0.8,
    claheClip: 2.4,
    sharpenAmount: 0.6,
    gamma: 1.12,
    saturation: 1.1,
  },
  murky: {
    redStrength: 0.5,
    warm: 6,
    greenBias: 4,
    dehazeStrength: 1,
    claheClip: 3,
    sharpenAmount: 0.9,
    gamma: 1.22,
    saturation: 0.95,
  },
  shallow: {
    redStrength: 0.25,
    warm: 0,
    greenBias: 0,
    dehazeStrength: 0.35,
    claheClip: 1.4,
    sharpenAmount: 0.4,
    gamma: 1.02,
    saturation: 1.08,
  },
};

export const SLIDERS: {
  key: keyof Params;
  label: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: 'redStrength', label: '紅色復原', min: 0, max: 1, step: 0.01 },
  { key: 'warm', label: '暖色（去藍）', min: -50, max: 50, step: 1 },
  { key: 'greenBias', label: '洋紅（去綠）', min: -50, max: 50, step: 1 },
  { key: 'dehazeStrength', label: '去水霧', min: 0, max: 1, step: 0.01 },
  { key: 'claheClip', label: '局部對比 CLAHE', min: 0, max: 5, step: 0.1 },
  { key: 'sharpenAmount', label: '細節銳化', min: 0, max: 1.5, step: 0.01 },
  { key: 'gamma', label: 'Gamma', min: 0.7, max: 1.6, step: 0.01 },
  { key: 'saturation', label: '飽和度', min: 0, max: 1.6, step: 0.01 },
  { key: 'wbStrength', label: '白平衡強度', min: 0, max: 1, step: 0.01 },
];

const fmt = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2));

export interface Controls {
  params: Params;
  /** Re-render the panel to match `params`. */
  sync(): void;
  /** Replace the params wholesale (preset or reset). */
  set(next: Params): void;
  /** Push the auto checkbox state into params. */
  setAuto(on: boolean): void;
}

export function buildControls(
  sliderHost: HTMLElement,
  presetHost: HTMLElement,
  autoBox: HTMLInputElement,
  onChange: () => void,
): Controls {
  let params: Params = { ...DEFAULT_PARAMS };

  const build = () => {
    sliderHost.innerHTML = '';
    for (const s of SLIDERS) {
      const row = document.createElement('label');
      row.className = 'row';
      row.innerHTML = `<span>${s.label}</span><output></output>`;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(s.min);
      input.max = String(s.max);
      input.step = String(s.step);
      input.value = String(params[s.key]);
      const out = row.querySelector('output')!;
      input.addEventListener('input', () => {
        (params[s.key] as number) = parseFloat(input.value);
        out.textContent = fmt(params[s.key] as number);
        onChange();
      });
      row.appendChild(input);
      sliderHost.appendChild(row);
    }
    sync();
  };

  const sync = () => {
    const rows = sliderHost.querySelectorAll('.row');
    SLIDERS.forEach((s, i) => {
      const el = rows[i]?.querySelector('input') as HTMLInputElement | undefined;
      if (!el) return;
      el.value = String(params[s.key]);
      el.parentElement!.querySelector('output')!.textContent = fmt(
        params[s.key] as number,
      );
    });
  };

  presetHost.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => {
    b.addEventListener('click', () => {
      presetHost.querySelectorAll('[data-preset]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      const key = b.dataset.preset!;
      params = {
        ...DEFAULT_PARAMS,
        ...PRESETS[key],
        auto: key === 'auto' ? true : autoBox.checked,
      };
      autoBox.checked = params.auto;
      sync();
      onChange();
    });
  });

  autoBox.addEventListener('change', () => {
    params = { ...params, auto: autoBox.checked };
    onChange();
  });

  build();

  return {
    get params() {
      return params;
    },
    sync,
    set(next: Params) {
      params = next;
      autoBox.checked = params.auto;
      sync();
    },
    setAuto(on: boolean) {
      params = { ...params, auto: on };
      autoBox.checked = on;
      sync();
    },
  };
}

export { fmt };
