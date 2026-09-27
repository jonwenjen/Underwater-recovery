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
node --experimental-strip-types scripts/optimize.ts [--report]   # re-tune auto against the scene suite
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
| Tone & colour | **Curve + vibrance** | Levels (auto 0.3 / 99.7 % percentiles), shadows / highlights, contrast, vibrance, saturation, mid-tone de-cast (with a guard that stops it turning open water violet on a sandy bottom), 8-bit dither |
| Sunlight | **光束 / 水面高光** | Beams detected from streak geometry and enhanced or suppressed toward a draggable light source; the surface band's clipped highlights recovered with a draggable A→B gradient; pale sunlight kept white instead of pink |
| Grain | **Auto 畫質修復** | Luminance grain σ measured per frame (Immerkær, flattest blocks); restoration, denoise and the sharpen threshold follow it |

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

Accurate recovery can look flat. Full auto now applies a mild dose (0.25,
found by the optimizer); one tap on **✨ 豐富色彩** locks a strong one (0.7,
strength in the 色彩 group), a second tap hands it back to auto. Every
amount is *measured per frame*:

- **Adaptive chroma** — mean OKLab chroma of surfaces is measured and a gain
  computed toward a vivid target: flat frames get a lot, colourful ones little.
  Hue-preserving (OKLab), near-neutrals (greys, whites) left alone, soft
  roll-off, and a **gamut fit** that gives back only the added chroma instead
  of clipping.
- **Warm emphasis** on reds / oranges — the colours water removes first.
- **More light** — the auto-exposure target and contrast rise; de-cast eases
  off and open water keeps a deeper blue.

![豐富色彩 on — split before/after](docs/screenshots/studio-vivid.png)

### ☀ Light: beams and surface highlights, with on-image control points

![光線控制點: ☀ light source (dragged), surface gradient A → B; split before/after](docs/screenshots/studio-light.png)

Press **☀ 光線控制點** in the toolbar to show the control points on the picture:

- **☀ light source** — the point the sun beams converge on. Auto finds it from
  the streaks themselves (local structure tensor: long, coherent, bright,
  near-vertical ridges; their lines are intersected, parallel beams put the
  source far above the frame). Drag it anywhere — also **outside the frame**
  (drag past the edge; it is then drawn dashed at the edge). **☀ 光束強度**
  `+` adds light along the beams (a radial blur of the bright part of the
  frame toward the source), `−` takes the beam structure away; **光束長度**
  and **光束色溫** shape it.
- **A → B surface gradient** — full effect at A (the surface), none past B.
  Auto places B where the bright top band fades back to the scene.
  **水面高光壓制** compresses highlights above a knee (clipped surface comes
  back), **水面亮度 / 水面色溫** set tone and warmth inside the gradient.
- Dragging a point makes that group manual (and turns its effect on if it was
  off); **double-click** a point or press **自動定位** to hand it back to auto.
  Arrow keys nudge a focused point (Shift = ×10).
- **光線去洋紅** — red compensation adds red where green is bright, so pale
  sunlight can come out pink. Where light is detected, bright *pale* magenta
  is pulled back to white; saturated pinks (coral, fish) are untouched.

On video, the source and gradient track the scene like every other auto value
(beam detection runs every third frame).

### How auto was tuned

`scripts/optimize.ts` scores the CPU mirror of the pipeline on a suite of
ground-truth scenes — the verify reef (two layouts) degraded with the
Jaffe–McGlamery model: blue water at 4 / 8 / 12 m, green water 6 m, murky
water with grain, a strobe close-up at 10 m, sunlit shallows (2.5 m) with
beams and a clipped surface, and a clean non-underwater photo that must stay
untouched. The score is the mean OKLab ΔE to the true colours on surfaces
(hue, chroma and lightness at once) plus local-contrast match, white-slate
neutrality, clipping, open-water hue (no violet) and harm to the clean photo.
Coordinate descent over every constant that maps a measurement to an auto
value (`TUNING` in `auto.ts`, within ranges that stay sane on real footage),
then over each preset's values on the scene it is made for. A preset lock is
dropped where auto does as well.

| Scene | OKLab ΔE before → after | | Preset | its scene: score auto → preset |
|---|---|---|---|---|
| blue 4 m | 0.131 → **0.084** | | 淺水／陽光 | sunny 2.5 m: 0.857 → **0.471** |
| blue 8 m | 0.160 → **0.078** | | 深藍海水 | blue 18 m: 0.703 → **0.676** |
| blue 12 m | 0.153 → **0.071** | | 綠水／湖 | green 6 m: 0.652 → **0.625** |
| green 6 m | 0.224 → **0.148** | | 混濁近攝 | murky 5 m + grain: 0.891 → **0.829** |
| murky 5 m + grain | 0.265 → **0.202** | | 閃燈 | strobe 10 m: 0.910 → **0.682** |
| strobe 10 m | 0.238 → **0.216** | | | |
| sunny 2.5 m | 0.283 → **0.203** (water no longer violet) | | | |
| clean photo (mean change) | 0.058 → **0.052** | | | |

What changed in full auto: stronger red compensation and dehaze, brighter
exposure target, less CLAHE (dehaze already restores local contrast; output
was 1.3–1.4× the true local contrast), stronger de-cast (with the violet
guard) and a **mild 豐富色彩 always on** (0.25 — the flat, dull look the
earlier default had). The presets were re-found too: 深藍海水 is now for
very deep water (18 m) and pushes saturation *down* (colour there is mostly
inferred; boosting it makes false colour); 閃燈 keeps red compensation light;
淺水／陽光 lifts shadows and keeps turquoise water. Two guards came from GPU
checks the CPU mirror cannot see: 淺水／陽光 keeps the white point at 1
(a lower one clipped the beams once clarity was applied), and the auto
restore / sharpen mapping was checked on real grain.

### Presets, curves, HSL, rotation, speed, restoration

![Curves, HSL and the 淺水／陽光 preset](docs/screenshots/studio-controls.png)

- **Presets** — 全自動 (everything back to auto) · **原始** (every stage
  neutral: shows the untouched source, exact identity, and also resets
  curves / HSL — a clean start for manual grading) · **淺水／陽光** (sunlit
  shallow water: lifts shadows, sharpens caustics, keeps turquoise water;
  red, dehaze, beams and the surface filter stay automatic because locking
  them did no better on the ground-truth scenes) · 深藍海水 · 綠水／湖 ·
  混濁近攝 · 閃燈 — all re-tuned by `scripts/optimize.ts` (above). Other
  presets keep a 豐富色彩 / 畫質修復 value you locked.
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
  blotches. For high-ISO, old or heavily compressed footage. **Now automatic**:
  the grain level is measured on a 256 px crop at processing scale (every 4th
  video frame) and restoration, denoise, the sharpen threshold and sharpening
  follow it — clean frames stay untouched, grainy ones are cleaned and not
  over-sharpened. The analysis card shows the measured σ (雜訊).

### Professional control

- Every auto-driven slider shows the value **auto is applying right now**
  (amber). Drag it and that one value becomes manual; press **A** to hand it back.
  Double-click a label to reset it. Turn the master switch off and every value
  freezes where auto left it.
- Presets lock a few values and leave the rest on auto.
- Split / result / original views, clipping warning overlay, live RGB
  histogram, water-light & illuminant swatches, grain σ, detected light
  (光束 / 水面), per-frame timing.
- **Export at full resolution** (JPEG / PNG / WebP) and video to MP4 or WebM,
  optionally streamed straight to disk; the exporter runs the *same* processor
  and tracker as the preview, so what you see is what you get.

## Verified, not just tested

`npm run verify` drives the real built app in headless Chromium (WebGL2 via
SwiftShader, WebCodecs VP9) against scenes with **known ground truth**: a reef
rendered in true colour, then degraded with the Jaffe–McGlamery image-formation
model (`I = J·E·t + B·(1−t)`, wavelength-dependent β and K). Latest run
(59 / 59 passing):

| Check | Result |
|---|---|
| Colour error vs ground truth (chromaticity L1, surfaces) | **0.532 → 0.088 (83 % better)** |
| Blue cast, 75 %+ of the way to truth | 42.0 → −23.8 (truth −14.1) |
| Red / contrast | 37.6 → 129.8 / 17.9 → 54.7 |
| Eyedropper on a white slate | chroma error 0.030 → **0.005** |
| Detail vs truth local contrast | 1.90× — crisp, not crunchy (1.2–2.0× window) |
| Clean (non-underwater) photo | not flagged (0.19); colour change 0.021 |
| Full-res export vs preview | max channel-mean difference 0.3 / 255 |
| Video: descent 5 → 14 m | illuminant red falls in 115 / 115 steps (max step 0.001), no false cuts |
| Video: blue → green cut at 3.0 s | cut detected at 3.1 s; green water & blue compensation engage |
| Video export | 150 / 150 frames, VP9 640×360; blue cast 43.2 → −20.6 (truth −13.7), green 58.4 → 8.6 (truth 4.9) |
| 豐富色彩 (button, GPU) | surface chroma 0.057 → **0.076** (truth 0.077), coral redder, 0.7 % blown; press / press again = lock / back to auto |
| 「原始」 preset | output = source (mean diff 0.3 / 255) |
| Rotate 90° / flip | 800×500 → 500×800, content matches (luma diff 2.7 / 0.4); photo exports 500×800 |
| Curves | RGB mid-point lift 127 → 154; R curve moves red only (G, B ±0.0) |
| HSL 藍 −100 | water chroma 0.030 → 0.001; coral and slate unchanged |
| 畫質修復 | grain 19.3 → 8.6, colour noise 12.9 → 6.2, slate edge kept |
| Auto 畫質修復 | σ 0.7 → restore 0; σ 10.2 → restore 0.85, sharpening 0.35 → 0.11 |
| 淺水／陽光 on a sunlit scene | blown 0.2 % → 0.0 %; colour error 0.429 → 0.127 |
| Sun beams: auto | presence 1.0, source (0.68, −0.02) for a true (0.70, −0.40) |
| ☀ 光束 +0.8 / −0.8 | beam − gap luminance 66.6 → 95.9 / 27.8; at a wrong source only 66.8 |
| 水面高光壓制 | clipped top band 35.7 % → 0.0 %, lower frame unchanged (Δ 0.0) |
| Control points (mouse drag) | ☀ lands at (0.250, 0.050), B at y 0.450, both lock; 自動定位 unlocks all |
| Export speed | 2×: 2.5 s, 75 frames, rotated 360×640 · 0.5×: 9.9 s, all 150 frames |
| Phone layout (390 px) | no horizontal scroll |

`test/engine.test.ts` (56 checks) covers the colour math, LUTs, guided
filter, recovery goals on the CPU mirror, manual overrides, EMA tracking,
scene cuts, the eyedropper, 豐富色彩 (mild in auto, richer when locked, not
darker, greys stay grey, gamut fit keeps hue), 「原始」 as an exact identity,
curves, HSL, the light module (beam and surface detection, source position,
grain σ within 15 %, surface mask and recovery, 光線去洋紅 keeping coral
pink, sun beams near-white, open water not violet on a sandy bottom), and the
analysis time budget.

## Architecture

```
source ─upload+mips─▶ 192 px readback ─▶ AutoEngine.step (CPU mirror + tracker)
                                              │ uniforms · guided coefficients · CLAHE LUTs · tone curve
source ─────────────▶ GRADE ─mips─▶ BLUR H ─▶ BLUR V ─▶ FINAL ─▶ canvas / export
                      (comp, WB, dehaze,  │    (detail,  (detail, clarity, de-cast,
                       exposure, CLAHE)   │     σ px)     curve, colour, beams, surface,
                                          └─ RAYS ────▶   去洋紅, curves/HSL, dither, split)
                                             (½ res radial blur toward ☀)
```

| File | Role |
|---|---|
| `src/engine/auto.ts` | Analysis, CPU mirror, temporal tracker, scene cuts, eyedropper |
| `src/engine/shaders.ts` | GLSL for the full-resolution passes (kept in lock-step with `auto.ts`) |
| `src/engine/renderer.ts` | WebGL2 renderer and the `Processor` loop shared by preview and export |
| `src/engine/color.ts`, `filters.ts`, `luts.ts` | Colour math, guided / box / min filters, CLAHE & tone-curve LUTs |
| `src/engine/params.ts` | Every control: range, default, auto or manual, presets |
| `src/engine/look.ts` | Curves (monotone cubic → LUT) and the 8-band OKLCh HSL mixer |
| `src/engine/light.ts` | Beam / surface detection, grain σ, JS twins of the light shader maths |
| `src/ui/lightPoints.ts` | Draggable ☀ / A / B control points over the viewer |
| `scripts/optimize.ts` | Ground-truth scene suite + coordinate descent that tuned auto and the presets |
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
- Auto was tuned on synthetic ground-truth scenes (the only kind where the
  true colours are known). The ranges keep every constant sane, but real
  footage may still prefer a preset or a nudge. Beam enhancement is a look,
  not a recovery, so its auto amount stays gentle (0.2 × presence).
- Beam detection needs visible streaks: diffuse caustics on the sand are not
  beams and are (correctly) left alone.

## References

Ancuti et al. — *Color Balance and Fusion for Underwater Image Enhancement* (TIP 2018) ·
Galdran et al. — *Automatic Red-Channel Underwater Image Restoration* (JVCIR 2015) ·
Berman et al. — *Non-Local Image Dehazing* (CVPR 2016), *Underwater Single Image Color Restoration Using Haze-Lines* (BMVC 2017) ·
He, Sun & Tang — *Guided Image Filtering* (TPAMI 2013), *Fast Guided Filter* (2015) ·
Zuiderveld — CLAHE · Jaffe & McGlamery — underwater imaging model

MIT licensed.
