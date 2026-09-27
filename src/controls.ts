import { DEFAULT_PARAMS, autoParams } from './pipeline';
import type { Analysis, Params } from './pipeline';

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
  /**
   * Keys the user has taken ownership of, by moving a slider or picking a
   * preset. Auto leaves these alone.
   */
  manual: ReadonlySet<keyof Params>;
  /** Re-render the panel to match `params`. */
  sync(): void;
  /** Replace the params wholesale (preset or reset). */
  set(next: Params): void;
  /** Push the auto checkbox state into params. */
  setAuto(on: boolean): void;
  /**
   * Re-derive the auto-tuned keys from `analysis` and show the result on the
   * sliders, so the UI always displays what is actually being applied.
   */
  refreshAuto(analysis: Analysis | null): void;
  /** Forget user-owned keys, so auto governs everything again. */
  clearManual(): void;
}

export function buildControls(
  sliderHost: HTMLElement,
  presetHost: HTMLElement,
  autoBox: HTMLInputElement,
  onChange: () => void,
): Controls {
  let params: Params = { ...DEFAULT_PARAMS };
  // Sliders the user has deliberately set. Auto must not overwrite these —
  // that was the bug where 5 of 9 sliders looked live but did nothing.
  const manual = new Set<keyof Params>();

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
        manual.add(s.key);
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
      presetHost
        .querySelectorAll('[data-preset]')
        .forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      const key = b.dataset.preset!;
      if (key === 'auto') {
        // back to fully automatic: hand every key back to auto
        manual.clear();
        autoBox.checked = true;
        params = { ...DEFAULT_PARAMS, auto: true };
      } else {
        // A preset is a set of deliberate choices, so it *pins* those keys
        // rather than being overwritten by auto. Everything else still tracks
        // the image, which is what makes presets feel like a starting point.
        const preset = PRESETS[key];
        for (const [k, v] of Object.entries(preset)) {
          (params as unknown as Record<string, number>)[k] = v as number;
          manual.add(k as keyof Params);
        }
      }
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
    get manual() {
      return manual;
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
    refreshAuto(analysis: Analysis | null) {
      if (!analysis || !params.auto) return;
      params = autoParams(params, analysis, manual);
      sync();
    },
    clearManual() {
      manual.clear();
    },
  };
}

export { fmt };
