/**
 * Every adjustable value, its range, and whether the auto engine drives it.
 *
 * Model: a key listed in AUTO_KEYS follows the engine's per-frame estimate
 * (smoothed over time) until the user moves its slider, which *locks* it to
 * the manual value. Unlocking hands it back to auto. With the master `auto`
 * switch off, every key uses its manual value — but the engine still measures
 * the scene (water light, illuminant, haze map, CLAHE tiles), since those are
 * properties of the frame, not preferences.
 */

export interface Params {
  auto: boolean;
  // water
  redComp: number;
  blueComp: number;
  dehaze: number;
  depthColor: number;
  waterTint: number;
  // white balance
  wbStrength: number;
  temp: number;
  tint: number;
  // tone
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  blacks: number;
  whites: number;
  // local contrast & detail
  clahe: number;
  claheTiles: number;
  clarity: number;
  sharpen: number;
  sharpenRadius: number;
  threshold: number;
  denoise: number;
  // colour
  vibrance: number;
  saturation: number;
  deCast: number;
  // tracking
  response: number;
}

export type NumKey = Exclude<keyof Params, 'auto'>;

export const AUTO_KEYS = [
  'redComp',
  'blueComp',
  'dehaze',
  'depthColor',
  'wbStrength',
  'exposure',
  'shadows',
  'blacks',
  'whites',
  'clahe',
  'vibrance',
  'deCast',
] as const satisfies readonly NumKey[];
export type AutoKey = (typeof AUTO_KEYS)[number];
export const isAutoKey = (k: string): k is AutoKey => (AUTO_KEYS as readonly string[]).includes(k);

export const DEFAULT_PARAMS: Params = {
  auto: true,
  redComp: 1,
  blueComp: 0,
  dehaze: 0.8,
  depthColor: 0.2,
  waterTint: 0.5,
  wbStrength: 0.9,
  temp: 0,
  tint: 0,
  exposure: 0,
  contrast: 0.1,
  highlights: -0.2,
  shadows: 0.15,
  blacks: 0.02,
  whites: 0.98,
  clahe: 0.25,
  claheTiles: 8,
  clarity: 0.1,
  sharpen: 0.3,
  sharpenRadius: 1.2,
  threshold: 0.03,
  denoise: 0.35,
  vibrance: 0.2,
  saturation: 1,
  deCast: 0.4,
  response: 1.2,
};

export interface SliderDef {
  key: NumKey;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}
export interface Group {
  title: string;
  sliders: SliderDef[];
}

export const GROUPS: Group[] = [
  {
    title: '水體校正',
    sliders: [
      { key: 'redComp', label: '紅色補償', min: 0, max: 2, step: 0.01, hint: '用綠色頻道重建被水吸收的紅色（Ancuti 補償）' },
      { key: 'blueComp', label: '藍色補償', min: 0, max: 1, step: 0.01, hint: '綠水／湖泊：補回被藻類吸收的藍色' },
      { key: 'dehaze', label: '去水霧', min: 0, max: 1, step: 0.01, hint: '水下暗通道去霧強度，無霧畫面自動減弱' },
      { key: 'depthColor', label: '距離色衰補償', min: 0, max: 1, step: 0.01, hint: '依透射率分波長補償：越遠的物體紅色補越多' },
      { key: 'waterTint', label: '水色保留', min: 0, max: 1, step: 0.01, hint: '去霧後開放水域保留多少原本的藍綠色：0 灰、1 原色' },
    ],
  },
  {
    title: '白平衡',
    sliders: [
      { key: 'wbStrength', label: '白平衡強度', min: 0, max: 1, step: 0.01, hint: '把估計的水下光源校正成中性白' },
      { key: 'temp', label: '色溫', min: -1, max: 1, step: 0.01, hint: '＋ 偏暖、－ 偏冷' },
      { key: 'tint', label: '色調', min: -1, max: 1, step: 0.01, hint: '＋ 偏洋紅（去綠）、－ 偏綠' },
    ],
  },
  {
    title: '影調',
    sliders: [
      { key: 'exposure', label: '曝光 EV', min: -2, max: 2, step: 0.01, hint: '自動模式會依場景亮度自動測光' },
      { key: 'contrast', label: '對比', min: -1, max: 1, step: 0.01, hint: '保留端點的 S 曲線' },
      { key: 'highlights', label: '亮部', min: -1, max: 1, step: 0.01, hint: '壓回水面與閃燈高光' },
      { key: 'shadows', label: '暗部', min: -1, max: 1, step: 0.01, hint: '提亮岩縫與遠處暗部' },
      { key: 'blacks', label: '黑點', min: 0, max: 0.25, step: 0.001, hint: '自動模式取 0.3% 分位數' },
      { key: 'whites', label: '白點', min: 0.7, max: 1, step: 0.001, hint: '自動模式取 99.7% 分位數' },
    ],
  },
  {
    title: '局部對比與細節',
    sliders: [
      { key: 'clahe', label: '局部對比 CLAHE', min: 0, max: 1, step: 0.01, hint: '分區直方圖均衡，只作用在亮度' },
      { key: 'claheTiles', label: 'CLAHE 網格', min: 2, max: 16, step: 1, hint: '越多格越局部' },
      { key: 'clarity', label: '清晰度', min: -1, max: 1, step: 0.01, hint: '中頻對比，讓主體浮出水體' },
      { key: 'sharpen', label: '銳化', min: 0, max: 2, step: 0.01, hint: '只銳化超過門檻的邊緣' },
      { key: 'sharpenRadius', label: '銳化半徑 px', min: 0.5, max: 3, step: 0.05, hint: '細節尺度' },
      { key: 'threshold', label: '銳化門檻', min: 0, max: 0.1, step: 0.001, hint: '低於門檻視為雜訊，不銳化' },
      { key: 'denoise', label: '降噪（懸浮粒子）', min: 0, max: 1, step: 0.01, hint: '平坦水域的亮度雜訊壓平' },
    ],
  },
  {
    title: '色彩',
    sliders: [
      { key: 'vibrance', label: '自然飽和度', min: -1, max: 1, step: 0.01, hint: '優先提升低飽和色，不讓珊瑚爆色' },
      { key: 'saturation', label: '飽和度', min: 0, max: 2, step: 0.01, hint: '整體飽和度' },
      { key: 'deCast', label: '中間調去色偏', min: 0, max: 1, step: 0.01, hint: '修掉殘留的整體色罩（常見為洋紅／青）' },
    ],
  },
  {
    title: '自動追蹤',
    sliders: [
      { key: 'response', label: '反應時間 秒', min: 0.1, max: 5, step: 0.05, hint: '影片中自動參數跟隨畫面變化的平滑時間；場景切換時立即重算' },
    ],
  },
];

export const SLIDERS: SliderDef[] = GROUPS.flatMap((g) => g.sliders);

export interface Preset {
  label: string;
  /** Values applied and locked. Keys not listed return to auto (or default). */
  set: Partial<Record<NumKey, number>>;
}

export const PRESETS: Record<string, Preset> = {
  auto: { label: '全自動', set: {} },
  blue: { label: '深藍海水', set: { redComp: 1.4, depthColor: 0.45, dehaze: 0.85, vibrance: 0.35 } },
  green: { label: '綠水／湖', set: { blueComp: 0.8, redComp: 1.1, tint: 0.25, dehaze: 0.8 } },
  murky: { label: '混濁近攝', set: { dehaze: 0.95, clahe: 0.6, denoise: 0.55, sharpen: 0.35, clarity: 0.3 } },
  strobe: { label: '閃燈／淺水', set: { redComp: 0.3, depthColor: 0, dehaze: 0.35, wbStrength: 0.55, clahe: 0.25 } },
};
