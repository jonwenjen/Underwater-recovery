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
  restore: number;
  // colour
  vibrance: number;
  saturation: number;
  deCast: number;
  /** 豐富色彩 strength (0 = off). The amounts it drives are computed per frame. */
  vivid: number;
  // light: beams (光束) and surface highlights (水面高光); positions are uv
  beams: number;
  beamLength: number;
  beamWarm: number;
  beamX: number;
  beamY: number;
  surfaceHL: number;
  surfaceTone: number;
  surfaceWarm: number;
  /** 光線去洋紅: take the pink out of pale sunlight (auto from light presence). */
  lightNeutral: number;
  surfAx: number;
  surfAy: number;
  surfBx: number;
  surfBy: number;
  // tracking
  response: number;
  // --- borrowed-method profiles (docs/sources.md) ---------------------
  // All four default to 0, i.e. inert. Each preset turns on exactly one and
  // zeroes the rest, so switching profiles cannot stack two corrections.
  /** 全自動-bornfree / 全自動-nikolajbech: strength of the 3x3 sRGB matrix. */
  matrixMix: number;
  /** 0 = analyse the full frame (nikolajbech), 1 = a fixed 256x256 (bornfree). */
  matrixGrid: number;
  /** 全自動-T77701: strength of the Fu et al. Eq. 1/2 per-channel mean pull. */
  meanPull: number;
  /** 上限 for the hue-shift search, degrees (published limit is 121). */
  matrixHue: number;
  /** 全自動-warplab: strength of the depth-guided physical restoration. */
  physicalMix: number;
  /** How much of the physical gain is driven by the dark-channel pseudo-depth. */
  physicalDepth: number;
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
  'beams',
  'beamX',
  'beamY',
  'surfaceHL',
  'surfAx',
  'surfAy',
  'surfBx',
  'surfBy',
  'lightNeutral',
  'restore',
  'denoise',
  'threshold',
  'sharpen',
  'vivid',
] as const satisfies readonly NumKey[];
/** Auto keys that are control-point positions (dragged on the image, not sliders). */
export const POSITION_KEYS = ['beamX', 'beamY', 'surfAx', 'surfAy', 'surfBx', 'surfBy'] as const;
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
  restore: 0,
  vibrance: 0.2,
  saturation: 1,
  deCast: 0.4,
  vivid: 0,
  beams: 0,
  beamLength: 0.6,
  beamWarm: 0.1,
  beamX: 0.5,
  beamY: -0.5,
  surfaceHL: 0,
  surfaceTone: 0,
  surfaceWarm: 0,
  lightNeutral: 0,
  surfAx: 0.5,
  surfAy: 0,
  surfBx: 0.5,
  surfBy: 0.3,
  response: 1.2,
  matrixMix: 0,
  matrixGrid: 0,
  matrixHue: 121,
  meanPull: 0,
  physicalMix: 0,
  physicalDepth: 0.6,
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
    title: '外部演算法（全自動 profiles）',
    sliders: [
      { key: 'matrixMix', label: '直方圖間隙矩陣', min: 0, max: 1, step: 0.01, hint: 'bornfree / nikolajbech：以最寬直方圖空隙定黑點白點，再套 3×3 sRGB 色彩矩陣' },
      { key: 'matrixHue', label: '色相位移上限', min: 0, max: 121, step: 1, hint: '綠轉紅的上限（度）。原法為 121；調低可避免重度偏紅的畫面被推成洋紅' },
      { key: 'matrixGrid', label: '分析取樣', min: 0, max: 1, step: 1, hint: '0 ＝分析整張原圖（nikolajbech）；1 ＝固定 256×256 取樣（bornfree，門檻不隨解析度變動，影片較穩）' },
      { key: 'meanPull', label: '兩段式色調拉抬', min: 0, max: 1, step: 0.01, hint: 'Fu 等 ISPACS 2017 Eq.2：通道均值拉回 128；通道被壓到全黑時改平移、不拉伸，避免雜訊爆開' },
      { key: 'physicalMix', label: '深度導向物理還原', min: 0, max: 1, step: 0.01, hint: 'Akkaynak–Treibitz 成像模型：先扣後向散射再除以衰減，還原被水吸收的紅色' },
      { key: 'physicalDepth', label: '虛擬深度', min: 0, max: 1, step: 0.01, hint: '以暗通道推估每個像素的距離：0 全畫同距離、1 完全依距離（遠景補得多）' },
    ],
  },
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
      { key: 'restore', label: '🛠 畫質修復', min: 0, max: 1, step: 0.01, hint: '保邊雙邊濾波：去高感光雜訊、彩色斑點與壓縮色塊（低畫質／舊影片建議 0.4–0.8）' },
    ],
  },
  {
    title: '色彩',
    sliders: [
      { key: 'vibrance', label: '自然飽和度', min: -1, max: 1, step: 0.01, hint: '優先提升低飽和色，不讓珊瑚爆色' },
      { key: 'saturation', label: '飽和度', min: 0, max: 2, step: 0.01, hint: '整體飽和度' },
      { key: 'deCast', label: '中間調去色偏', min: 0, max: 1, step: 0.01, hint: '修掉殘留的整體色罩（常見為洋紅／青）' },
      { key: 'vivid', label: '✨ 色彩豐富度（自動）', min: 0, max: 1, step: 0.01, hint: '依畫面實測彩度自動補足：OKLab 保色相增艷、暖色（珊瑚／魚）加強、提亮、水色更藍；0 關閉' },
    ],
  },
  {
    title: '光線（光束／水面高光）',
    sliders: [
      { key: 'beams', label: '☀ 光束強度', min: -1, max: 1, step: 0.01, hint: '＋ 加強光束、－ 淡化光束；光源位置用畫面上的 ☀ 控制點拖曳' },
      { key: 'beamLength', label: '光束長度', min: 0.1, max: 1, step: 0.01, hint: '光束從光源延伸的距離' },
      { key: 'beamWarm', label: '光束色溫', min: -1, max: 1, step: 0.01, hint: '＋ 暖陽光、－ 冷藍光' },
      { key: 'surfaceHL', label: '水面高光壓制', min: 0, max: 1, step: 0.01, hint: '救回水面過曝；範圍用畫面上 A（水面）→ B（漸層結束）兩個控制點拖曳' },
      { key: 'surfaceTone', label: '水面亮度', min: -1, max: 1, step: 0.01, hint: '漸層範圍內整體亮度' },
      { key: 'surfaceWarm', label: '水面色溫', min: -1, max: 1, step: 0.01, hint: '漸層範圍內的冷暖' },
      { key: 'lightNeutral', label: '光線去洋紅', min: 0, max: 1, step: 0.01, hint: '紅色補償會讓淺色的陽光／光束偏粉紅：只把明亮、淡色的洋紅拉回白色，珊瑚等飽和粉紅不受影響' },
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
  hint: string;
  /** Values applied and locked. Keys not listed return to auto (or default). */
  set: Partial<Record<NumKey, number>>;
  /** Also clear 豐富色彩, 畫質修復, curves and HSL: a true starting point. */
  raw?: boolean;
}

/** Every stage neutral: with this the pipeline is an identity (see tests). */
const RAW: Partial<Record<NumKey, number>> = {
  redComp: 0, blueComp: 0, dehaze: 0, depthColor: 0, waterTint: 1,
  wbStrength: 0, temp: 0, tint: 0,
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, blacks: 0, whites: 1,
  clahe: 0, clarity: 0, sharpen: 0, denoise: 0, restore: 0,
  vibrance: 0, saturation: 1, deCast: 0, vivid: 0,
  beams: 0, surfaceHL: 0, surfaceTone: 0, surfaceWarm: 0, lightNeutral: 0,
};

/**
 * The four "全自動-<source>" profiles, imported from outside projects.
 *
 * Each one turns its own method on and zeroes the other three, then leaves
 * the rest of the engine on its normal auto values. They are not tuned to
 * look a certain way — they reproduce what the cited method does, and the
 * "raw" flag tells the UI not to apply the engine's finishing pass on top,
 * because stacking a look on top of a fixed 3x3 correction changes it.
 *
 * Provenance and licensing are recorded in docs/sources.md. In short: all four
 * upstream projects are copyleft or unlicensed, and this repository is MIT, so
 * none of their code was copied — each method is reimplemented from its
 * published description.
 */
const BORROWED_PROFILES = { matrixMix: 0, matrixGrid: 0, meanPull: 0, physicalMix: 0 } as const;

export const PRESETS: Record<string, Preset> = {
  '全自動-bornfree': {
    label: '全自動-bornfree',
    hint: '直方圖間隙色彩矩陣，固定 256×256 取樣（解析度無關、影片穩定）',
    set: {
      ...BORROWED_PROFILES,
      // A 全自動 profile differs from 全自動 *only* by the imported method.
      // Locking anything else just reproduces some other look and hides what
      // the method actually does. The one thing that must change is the
      // engine's own red restoration: the matrix does that job, and running
      // both double-counts it.
      matrixMix: 0.85, matrixGrid: 1, matrixHue: 60, redComp: 0,
    },
  },
  '全自動-nikolajbech': {
    label: '全自動-nikolajbech',
    hint: '同一套直方圖間隙矩陣，但依原版在「整張原圖」上統計（門檻隨解析度變動）',
    set: {
      ...BORROWED_PROFILES,
      matrixMix: 0.85, matrixGrid: 0, matrixHue: 60, redComp: 0,
    },
  },
  '全自動-T77701': {
    label: '全自動-T77701',
    hint: 'Fu 等 ISPACS 2017 兩段式：通道均值拉回 128，被壓毀的通道改平移不拉伸',
    set: {
      ...BORROWED_PROFILES,
      // Eq. 2 pulls every channel mean to 128; at full strength a frame whose
      // means sit well below that is stretched hard and ends up warm.
      meanPull: 0.7, redComp: 0,
    },
  },
  '全自動-warplab': {
    label: '全自動-warplab',
    hint: 'Akkaynak–Treibitz 物理模型：扣後向散射、再除以距離衰減，還原深水紅色',
    set: {
      ...BORROWED_PROFILES,
      // Depth scale 0.45, not 1: the differential red gain hits its 3×
      // ceiling well before the slider's maximum, and on a shallow frame a
      // full-strength correction lands visibly warm. The slider is there.
      physicalMix: 1, physicalDepth: 0.45, redComp: 0,
    },
  },
  auto: { label: '全自動', hint: '每個畫面自動分析與追蹤', set: {} },
  raw: { label: '原始', hint: '所有校正歸零、顯示原圖，從這裡手動調整（曲線／HSL 也重設）', set: RAW, raw: true },
  // Values from scripts/optimize.ts: each preset searched on the ground-truth
  // scene it is made for and kept only where it beats full auto there.
  sunny: {
    label: '淺水／陽光',
    hint: '陽光射入的淺水：提亮暗部、光束與水面不過曝、加強光紋清晰度、保留清透藍綠水色；紅色、去霧、光束與水面高光仍由自動依畫面量測',
    // locking dehaze or red compensation made colour worse (water drifts
    // violet); the surface filter did no better locked than on auto
    set: { highlights: -0.1, whites: 1, shadows: 0.45, clarity: 0.25, depthColor: 0, waterTint: 0.95, vibrance: -0.2 },
  },
  blue: { label: '深藍海水', hint: '15 m 以上的深水：紅色幾乎全失，少推飽和避免假色', set: { depthColor: 0.1, vibrance: -0.3 } },
  green: { label: '綠水／湖', hint: '湖泊、藻類多的綠水：補藍、去綠', set: { blueComp: 0.95, tint: 0.6 } },
  murky: {
    label: '混濁近攝',
    hint: '能見度差、懸浮粒子多',
    set: { dehaze: 0.85, clahe: 0.3, denoise: 0.55, sharpen: 0.35, clarity: 0.3, restore: 0.4 },
  },
  strobe: { label: '閃燈', hint: '有閃燈／補光，近處紅色大多還在', set: { redComp: 0.8, depthColor: 0, dehaze: 0.4 } },
};
