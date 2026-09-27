# 🌊 Underwater Recovery Studio

Real-time, high-quality recovery of underwater **photos and video**, entirely in
your browser. Every slider change and every video frame is re-graded live on
the GPU; an auto engine analyses each frame and **tracks the scene as the camera
moves** — descending, panning, cutting from blue to green water — while every
stage stays under professional manual control.

**No server, no upload, no account.** Pixels never leave the tab.

![Studio — split before/after on a reef degraded by the Jaffe–McGlamery model](docs/screenshots/studio-photo.png)

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine unit tests (Node, no browser)
npm run verify     # build + end-to-end verification in headless Chromium
npm run build      # typecheck + production bundle
```

## What it does

| Problem | Stage | How |
|---|---|---|
| Missing reds | **Red compensation** | Ancuti et al. (2018): `R += α·(Ḡ−R̄)·(1−R)·G` — rebuilds red from green where the scene has signal; blue compensation for green water |
| Blue / green cast | **White balance** | Grey-world illuminant → one **Bradford (von Kries) 3×3 matrix**; temperature / tint on top; **eyedropper** makes any tapped surface exactly neutral |
| Water haze | **Dehaze** | Water light = the *dominant smooth hazy colour* (Red Channel Prior + texture); transmission from **haze-lines** (Berman et al.); refined by a **guided filter** and upsampled edge-aware on the GPU; acts on luminance, keeps balanced chroma; open water is re-tinted to *clear* water instead of clipped |
| Distance colour loss | **Distance compensation** | Red lifted in proportion to `(1−t)` — farther objects lost more |
| Low contrast | **Exposure → CLAHE → clarity** | Log-average auto exposure with a dead zone; CLAHE on luminance only, scaled down when dehaze already restored contrast |
| Soft detail / particles | **Sharpen + denoise** | Threshold-gated: edges above the threshold are sharpened, flat water below it is smoothed (backscatter) |
| Tone & colour | **Curve + vibrance** | Levels (auto 0.3 / 99.7 % percentiles), shadows / highlights, contrast, vibrance, saturation, mid-tone de-cast, 8-bit dither |

### Auto mode that follows the video

- Each frame is read back at 192 px; a CPU **mirror** of the shader pipeline
  derives every parameter stage by stage (≈ 3 ms on a laptop).
- Global values (illuminant, water light, exposure, compensation…) are
  smoothed with an exponential moving average — the **反應時間** slider sets its
  time constant — so the grade glides as you descend instead of flickering.
- **Scene cuts** (soft colour-histogram distance) snap the tracker instantly;
  camera pans do not.
- Spatial maps (transmission, CLAHE tiles) are recomputed every frame so they
  move with the picture.

### ✨ 豐富色彩 (rich colour)

Accurate recovery can look flat: on the ground-truth reef the default output
has only 35–60 % of the true scene's colourfulness and is darker. One tap on
**✨ 豐富色彩** (strength in the 色彩 group) adds an automatic look layer,
with every amount *measured per frame*:

- **Adaptive chroma** — mean OKLab chroma of surfaces is measured and a gain
  computed toward a vivid target: flat frames get a lot, colourful ones little.
  Hue-preserving (OKLab), near-neutrals (greys, whites) left alone, soft
  roll-off, and a **gamut fit** that gives back only the added chroma instead
  of clipping.
- **Warm emphasis** on reds / oranges — the colours water removes first.
- **More light** — the auto-exposure target and contrast rise; de-cast eases
  off and open water keeps a deeper blue.

![豐富色彩 on — split before/after](docs/screenshots/studio-vivid.png)

### Presets, curves, HSL, rotation, speed, restoration

![Curves, HSL and the 淺水／陽光 preset](docs/screenshots/studio-controls.png)

- **Presets** — 全自動 · **原始** (every stage neutral: shows the untouched
  source, exact identity, and also resets curves / HSL — a clean start for
  manual grading) · **淺水／陽光** (sunlit shallow water: protects light shafts
  and surface highlights, lifts shadows, sharpens caustics, keeps turquoise
  water; red and dehaze stay automatic because locking them made colour worse
  on the ground-truth scenes) · 深藍海水 · 綠水／湖 · 混濁近攝 · 閃燈.
- **Curves** — RGB master + R / G / B, monotone cubic (never overshoots or
  inverts), drawn over the live histogram; tap to add, drag, double-tap to
  delete. Channel curves apply before the master, as in Photoshop / Lightroom.
- **HSL** — 色相 / 飽和度 / 明亮度 for 紅 橙 黃 綠 青 藍 紫 洋紅, in OKLCh with
  band weights that always sum to 1 (no seams). True greys are never tinted;
  pale colours such as recovered water respond fully. Out-of-gamut results
  give back chroma instead of clipping.
- **Rotation / flip** — ⟲ ⟳ ⇋ in the toolbar; applied before analysis, so the
  preview, the auto engine and both exporters see the turned frame.
- **Speed** — preview playback 0.25–2×; export 0.25–4× (faster keeps the
  source frame rate by dropping frames; slower holds frames for slow motion;
  audio is dropped when the speed changes).
- **🛠 畫質修復** — bilateral pre-pass: luminance grain and 8×8 compression
  steps smoothed with an edge stop; chroma filtered wider to remove colour
  blotches. For high-ISO, old or heavily compressed footage.

### Professional control

- Every auto-driven slider shows the value **auto is applying right now**
  (amber). Drag it and that one value becomes manual; press **A** to hand it back.
  Double-click a label to reset it. Turn the master switch off and every value
  freezes where auto left it.
- Presets (全自動 / 深藍海水 / 綠水 / 混濁近攝 / 閃燈淺水) lock a few values and
  leave the rest on auto.
- Split / result / original views, clipping warning overlay, live RGB
  histogram, water-light & illuminant swatches, per-frame timing.
- **Export at full resolution** (JPEG / PNG / WebP) and video to MP4 or WebM,
  optionally streamed straight to disk; the exporter runs the *same* processor
  and tracker as the preview, so what you see is what you get.

## Verified, not just tested

`npm run verify` drives the real built app in headless Chromium (WebGL2 via
SwiftShader, WebCodecs VP9) against scenes with **known ground truth**: a reef
rendered in true colour, then degraded with the Jaffe–McGlamery image-formation
model (`I = J·E·t + B·(1−t)`, wavelength-dependent β and K). Latest run
(47 / 47 passing):

| Check | Result |
|---|---|
| Colour error vs ground truth (chromaticity L1, surfaces) | **0.532 → 0.104 (80 % better)** |
| Blue cast, 75 %+ of the way to truth | 42.0 → −10.8 (truth −14.1) |
| Red / contrast | 37.6 → 103.6 / 17.9 → 45.6 |
| Eyedropper on a white slate | chroma error 0.042 → **0.005** |
| Detail vs truth local contrast | 1.65× — crisp, not crunchy (1.2–2.0× window) |
| Clean (non-underwater) photo | not flagged (0.19); colour change 0.022 |
| Full-res export vs preview | max channel-mean difference 0.1 / 255 |
| Video: descent 5 → 14 m | illuminant tracked smoothly (max step 0.001), no false cuts |
| Video: blue → green cut at 3.0 s | cut detected at 3.0 s; green water & blue compensation engage |
| Video export | 150 / 150 frames, VP9 640×360, casts corrected in both scenes |
| 豐富色彩 (button, GPU) | surface chroma 0.042 → **0.084** (truth 0.077), brighter, coral redder, 0.1 % blown, colour error still 0.532 → 0.180 |
| 「原始」 preset | output = source (mean diff 0.3 / 255) |
| Rotate 90° / flip | 800×500 → 500×800, content matches (luma diff 0.7 / 0.4); photo exports 500×800 |
| Curves | RGB mid-point lift 104 → 133; R curve moves red only (G, B ±0.0) |
| HSL 藍 −100 | water chroma 0.031 → 0.001; coral and slate unchanged |
| 畫質修復 | grain 29.4 → 15.6, colour noise 12.5 → 6.6, slate edge kept (140.6 → 146.5) |
| 淺水／陽光 on a sunlit scene | no blown light shafts; colour error 0.429 → 0.140 |
| Export speed | 2×: 2.5 s, 75 frames, rotated 360×640 · 0.5×: 9.9 s, all 150 frames |
| Phone layout (390 px) | no horizontal scroll |

`test/engine.test.ts` (45 checks) covers the colour math, LUTs, guided
filter, recovery goals on the CPU mirror, manual overrides, EMA tracking,
scene cuts, the eyedropper, 豐富色彩 (richer, not darker, greys stay grey,
never reduces chroma, gamut fit keeps hue), 「原始」 as an exact identity,
curves (identity, no overshoot, channel order), HSL (identity, targets its
band, pale colours respond, greys untouched, in gamut, seamless weights), and
the analysis time budget.

## Architecture

```
source ─upload+mips─▶ 192 px readback ─▶ AutoEngine.step (CPU mirror + tracker)
                                              │ uniforms · guided coefficients · CLAHE LUTs · tone curve
source ─────────────▶ GRADE ─mips─▶ BLUR H ─▶ BLUR V ─▶ FINAL ─▶ canvas / export
                      (comp, WB, dehaze,       (detail,  (detail, clarity, de-cast,
                       exposure, CLAHE)         σ px)     curve, colour, dither, split)
```

| File | Role |
|---|---|
| `src/engine/auto.ts` | Analysis, CPU mirror, temporal tracker, scene cuts, eyedropper |
| `src/engine/shaders.ts` | GLSL for the full-resolution passes (kept in lock-step with `auto.ts`) |
| `src/engine/renderer.ts` | WebGL2 renderer and the `Processor` loop shared by preview and export |
| `src/engine/color.ts`, `filters.ts`, `luts.ts` | Colour math, guided / box / min filters, CLAHE & tone-curve LUTs |
| `src/engine/params.ts` | Every control: range, default, auto or manual, presets |
| `src/engine/look.ts` | Curves (monotone cubic → LUT) and the 8-band OKLCh HSL mixer |
| `src/engine/export.ts` | Full-res photo export, video export with speed + rotation (mediabunny, lazy-loaded) |
| `src/ui/curves.ts`, `src/ui/hsl.ts` | Curve editor and HSL panel |
| `src/app.ts`, `src/app.css` | Studio UI |
| `scripts/verify.mjs`, `scripts/verify-scene.js` | End-to-end verification with ground-truth scenes |

The v1 CPU pipeline (`src/main.ts`, `pipeline.ts`, `video.ts`, workers — including
its later fixes: tap-to-neutral, source preview toggle, edge-line fix) is no
longer bundled. It stays in the tree for reference; its unit tests still run in
CI (`npm run test:legacy`). `scripts/e2e-video.mjs` drives the v1 UI and can
only be run against a build of the v1 `index.html` from git history.

## Honest limitations

- **Red that the water fully absorbed is inferred, not recovered.** At 8 m the
  test reef's corals keep only ~3 % of their red; compensation brings the red
  chromaticity from 0.23 to 0.38 against a true 0.58.
- The live preview needs WebGL2 (every current browser). Video export needs
  WebCodecs; H.264 availability depends on the browser (Chrome / Edge / Safari),
  VP9 / AV1 are widely available.
- The verification GPU is software (SwiftShader), so its timings (≈ 1 s per
  1600×1000 frame) say nothing about real hardware; on a real GPU the full-res
  passes cost a few milliseconds.
- Rotated phone videos keep their rotation as container metadata on export;
  this path has not been verified on real rotated footage yet.

## References

Ancuti et al. — *Color Balance and Fusion for Underwater Image Enhancement* (TIP 2018) ·
Galdran et al. — *Automatic Red-Channel Underwater Image Restoration* (JVCIR 2015) ·
Berman et al. — *Non-Local Image Dehazing* (CVPR 2016), *Underwater Single Image Color Restoration Using Haze-Lines* (BMVC 2017) ·
He, Sun & Tang — *Guided Image Filtering* (TPAMI 2013), *Fast Guided Filter* (2015) ·
Zuiderveld — CLAHE · Jaffe & McGlamery — underwater imaging model

MIT licensed.
