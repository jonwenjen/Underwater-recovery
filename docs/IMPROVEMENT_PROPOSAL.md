# Underwater Recovery — Improvement Proposal

_Analysis of `main` @ `1f5b315` ("Add video recovery as a first-class mode"), 2026-09-27._

> **Status (v2.0 "Studio"):** implemented as a redesign rather than patches —
> P1/P2/P4 (GPU real-time pipeline, Bradford WB matrix), Q1 (Ancuti red
> compensation), Q2 (haze-lines + guided filter, RCP water light), Q3
> (eyedropper), Q4 (threshold-gated sharpen/denoise), Q5 (EMA tracking with
> scene cuts), U1 (full-res export), U2 (transparent auto), U3 (stream to
> disk, ETA), B1–B4 by construction, E1/E2 (CI, ground-truth verification).
> Not done: Q6 (on-device ML), U4 (PWA), removal of the v1 files. See README.

This document reviews the current codebase (≈2,400 lines of TypeScript across
`src/`, `test/`, `bench/` and `scripts/`) and proposes concrete improvements,
each with **why**, **how**, and an estimate of effort. Where a claim could be
checked by running code, it was — the measurements and probes are reproduced
below so they can be re-run.

---

## 0. TL;DR

| # | Proposal | Type | Impact | Effort |
|---|---|---|---|---|
| B1 | "下載這張" saves the before/after **split composite**, not the result | Bug | 🔴 High | XS |
| B2 | Presets and 5 of the sliders are **silently ignored while Auto is on** (the default) | Bug | 🔴 High | S |
| B3 | Video export grades with whatever analysis the **preview** last cached | Bug | 🟠 Med | S |
| B4 | 8-bit re-quantisation mid-pipeline → **banding** in smooth water gradients | Quality bug | 🟠 Med | S |
| P1 | Lookup tables for sRGB↔linear — **measured 2.0–2.2× faster**, bit-identical test results | Perf | 🔴 High | XS |
| P2 | Replace per-pixel Lab white balance with a 3×3 chromatic-adaptation matrix | Perf + quality | 🟠 Med | S |
| P3 | Buffer reuse, low-res dehaze, worker pool | Perf | 🟠 Med | M |
| P4 | WebGPU / WebGL2 path → real-time video preview | Perf | 🔴 High | L |
| Q1 | Ancuti red-channel compensation (use green to rebuild red) | Quality | 🔴 High | S |
| Q2 | Underwater-specific dark channel + real guided filter | Quality | 🔴 High | M |
| Q3 | Robust white balance + **tap-to-neutral eyedropper** | Quality/UX | 🔴 High | S |
| Q4 | Noise-aware sharpening | Quality | 🟠 Med | S |
| Q5 | Temporal smoothing of analysis for video | Quality | 🟠 Med | S |
| Q6 | Optional on-device ML model (still 100 % local) | Quality | 🔴 High | L |
| U1 | Full-resolution export, JPEG/WebP choice, keep EXIF | UX | 🔴 High | M |
| U2 | Auto mode shows its values on the sliders; manual edits override | UX | 🔴 High | S |
| U3 | Stream long video exports to disk | UX | 🟠 Med | S |
| U4 | PWA (offline + installable + share-target from phone gallery) | UX | 🟠 Med | S |
| E1 | CI on PRs, typecheck tests/bench, portable e2e via Playwright | Eng | 🟠 Med | S |
| E2 | Golden-image + quality-metric regression tests | Eng | 🟠 Med | M |
| E3 | Remove dead code / template leftovers, fix doc drift | Eng | 🟢 Low | XS |

Effort: XS < ½ day · S ≈ 1 day · M ≈ 2–4 days · L ≈ 1–2 weeks.

**Suggested first PR:** B1 + B2 + B3 + P1 + E3. All small, all user-visible, and
P1 alone halves processing time.

---

## 1. What is already good

Worth saying up front, because the proposals below should preserve it:

- **Privacy-first architecture.** Everything runs in a Web Worker; no server,
  no upload. Video goes through WebCodecs via mediabunny with lazy loading so
  photo-only users never download it.
- **Physically sensible stage ordering** — photometric stages in linear light,
  perceptual stages in sRGB — and each stage is self-limiting (dehaze scales
  `omega` by measured haze, red restore is gated on a pre-WB deficit, the
  de-cast is mid-tone weighted). The inline comments explain *why*, which is
  rare and valuable.
- **O(n) algorithms where it matters**: van Herk/Gil-Werman min filter,
  histogram-based atmospheric light instead of a sort.
- **Numeric tests** that assert the four recovery goals plus a neutral-grey
  "do no harm" guard.

---

## 2. Bugs (verified)

### B1 — Photo download saves the split-screen composite 🔴

`downloadCurrent()` (`src/main.ts:263`) calls `toBlob()`, which serialises the
visible canvas `cv`. But `draw()` (`src/main.ts:115`) paints **original on the
left of the handle and the result on the right**. Unless the user has dragged
the handle fully to the left, the saved PNG is half-original, half-recovered.
(`downloadAll()` is correct — it renders `it.result` into a fresh canvas.)

**Fix:** share one helper with `downloadAll()`:

```ts
async function encodeResult(it: Item): Promise<Blob | null> {
  const c = new OffscreenCanvas(it.w, it.h);
  c.getContext('2d')!.putImageData(it.result!, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}
```

Add an e2e assertion: download with `split = 0.5` and compare to `stats().after`.

### B2 — Presets and most sliders do nothing while Auto is on 🔴

`autoParams()` (`src/pipeline.ts:718`) **overwrites** `redStrength`,
`dehazeStrength`, `gamma`, `claheClip` and `sharpenAmount` from the analysis.
Both workers apply it whenever `params.auto` is true — and Auto is checked by
default, and clicking a preset keeps `auto: autoBox.checked`
(`src/controls.ts:631`).

Probe (preset "深藍海水" vs. plain auto on the same image):

```
redStrength     preset= 0.9   effective(auto on)= 0.889  same as plain auto: true
dehazeStrength  preset= 0.9   effective(auto on)= 0.932  same as plain auto: true
claheClip       preset= 2.2   effective(auto on)= 2.958  same as plain auto: true
sharpenAmount   preset= 0.7   effective(auto on)= 0.924  same as plain auto: true
gamma           preset= 1.16  effective(auto on)= 1.057  same as plain auto: true
warm / greenBias / saturation                             → respected
```

So with default settings, 5 of 8 preset values and 5 of 9 sliders are no-ops,
while the slider still visibly moves. Users will conclude "the sliders don't
work".

**Fix (pairs with U2):** make Auto a *starting point*, not an override:

1. Run `analyse()` on load (already done in `loadFile`) and compute
   `autoParams()` **on the main thread**.
2. Write those values into the sliders, so the UI shows what is actually
   applied.
3. Any manual slider move marks that key as user-owned
   (`manual: Set<keyof Params>`); `autoParams` then skips owned keys.
4. Presets become multipliers/offsets on top of the auto result (e.g.
   `blue: { redStrength: ×1.2, warm: +12 }`), or turn Auto off explicitly.

This also removes the need for the worker to know about `auto` at all — it
just receives final params.

### B3 — Video export uses the preview's cached analysis 🟠

In `exportVideo()` (`src/video.ts:357–365`):

- `analyse()` runs on 3 frames, but only frame 0 is used; frames 1–2 are
  computed and discarded (the comment says "from the first few frames").
- `processFrame(frame, resolved, { fresh: false })` sends
  `analysis: cachedAnalysis` — the module-level value last written by the
  **preview** (a ≤480p frame at wherever the user scrubbed). White balance
  (`castA/castB`) and red restore (`redDeficit`) therefore depend on scrub
  position, not on the clip.
- If no preview ran (e.g. the `__uw.exportVideo` test hook), `cachedAnalysis`
  is `null`, and since `resolved.auto` is still `true` the worker recomputes
  `analyse` **and** `autoParams` per frame — exactly the flicker the README
  says is avoided.

**Fix:** have export compute its own analysis and pass it explicitly:

```ts
const probe = await sampleFrames(track, 8);          // evenly spaced, not the first 3
const a = medianAnalysis(probe.map(analyse));        // robust to a black fade-in
const resolved = params.auto ? { ...autoParams({...DEFAULT_PARAMS, ...params}, a), auto: false } : params;
// ...
processFrame(frame, resolved, a);                     // never read cachedAnalysis
```

See Q5 for per-scene smoothing on long clips.

### B4 — Mid-pipeline 8-bit quantisation causes banding 🟠

`process()` converts back to sRGB with `toSrgb(buf[q]) / 255`
(`src/pipeline.ts:582`), and `toSrgb` **rounds to an integer**. CLAHE, unsharp
and the tone curve then stretch those 256 levels, and the final tone LUT
indexes by `Math.round(enc * 255)` again. Underwater photos are dominated by
smooth blue gradients, which is exactly where stretched 8-bit steps show as
contour bands — and sharpening makes them crisper.

**Fix:** keep `enc` in float end-to-end (`toSrgbFloat`, no rounding), make the
tone LUT 4096 entries with linear interpolation (or just compute
`pow` on the tone path via the LUT from P1), and add ±0.5 LSB ordered or
blue-noise **dither** in the final 8-bit write.

### Minor

- **Cancel reports as failure.** Cancelling throws `Error('cancelled')`
  inside `process`, so the UI shows `匯出失敗：cancelled`. Use
  `conversion.cancel()` and show "已取消".
- **Stale indices after removing a photo.** `dirty` stores array indices
  (`src/main.ts:69`); `items.splice(i, 1)` shifts them, so a pending
  re-process can hit the wrong image or be lost. Store `Item` references or
  stable ids instead.
- **Neutral-grey reference uses the red mean.** `analyse()` builds the grey
  reference from `toLinear(mr)` (`src/pipeline.ts:158`) rather than mean luma.
  For underwater images `mr` is the smallest channel, so the reference is too
  dark (≈1 Lab unit error). Cleaner fix: normalise XYZ by the D65 white point
  in both the forward and inverse transforms; then sRGB grey is exactly
  `a = b = 0` and the reference subtraction disappears (see P2).
- **Slider changes during preview playback** don't apply after a preset click,
  because `play()` captures the `params` object and presets replace it. Read
  `videoParams()` each frame.

---

## 3. Performance

Baseline measured in this environment with the repo's own benches
(absolute numbers are slower than the README's laptop figures; ratios are what
matter):

```
bench/stages.ts (1280×720)          bench/bench.ts
analyse only   878 ms   ← all stages off   1280×720  1321 ms/frame
EVERYTHING    1303 ms                       640×360    314 ms/frame
```

With every stage disabled, a frame still costs **67 % of the full pipeline**.
That cost is the colour conversions: `toLinear` and `toSrgb` each call
`Math.pow` per channel per pixel (6 `pow`s/pixel), plus the `analyse` pass.

### P1 — Lookup tables for sRGB ↔ linear 🔴 (XS)

`toLinear` has only 256 possible inputs; `toSrgb` can use a 4096–16384-entry
table. Experiment (scratch copy, only these two functions changed):

```
                     before      after     speed-up
stages: all off      878 ms  →  178 ms      4.9×
stages: everything  1303 ms  →  632 ms      2.1×
bench 1280×720      1321 ms  →  646 ms      2.0×
bench  640×360       314 ms  →  142 ms      2.2×
npm test             7/7 pass, identical numbers
```

```ts
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const ENC_N = 16384;                        // 4096 is enough for 8-bit out; 16k keeps B4 float-clean
const ENC = new Float32Array(ENC_N + 1);    // store float sRGB, not rounded bytes (B4)
for (let i = 0; i <= ENC_N; i++) { /* same formula as toSrgb, no rounding */ }
const toLinear = (c8: number) => LIN[c8];
const toSrgbF  = (l: number) => ENC[(clamp(l, 0, 1) * ENC_N + 0.5) | 0];
```

### P2 — White balance as a 3×3 matrix (S)

`whiteBalance()` does a full sRGB→XYZ→Lab→XYZ→sRGB round trip per pixel,
with 3 `cbrt`, 3 cubes, and two closures allocated **inside the loop**
(`f` and `inv`, `src/pipeline.ts:219,233`). Shifting Lab `a/b` by a constant is
also not what a real illuminant change does.

Replace it with a **von Kries / Bradford chromatic adaptation**: estimate the
scene illuminant in linear RGB (see Q3), convert to cone space (LMS), scale,
and convert back. That collapses to **one precomputed 3×3 matrix per image**
— 9 multiply-adds per pixel — and is the standard, physically motivated way to
white-balance. Manual `warm`/`greenBias` become a small rotation of the target
white point.

### P3 — Allocation, resolution and parallelism (M)

- **Reuse buffers.** One frame allocates ~12 full-size `Float32Array`s
  (`buf`, `enc`, `L`, `dark`, `r/g/b`, 2× per `minFilter`, `t`, `tRef`,
  2× per `boxBlur`, CLAHE `out`). At 1080p that is ≈100 MB of garbage per
  frame during video export. Keep a per-worker `Scratch` object sized to the
  largest frame seen and pass views into each stage.
- **Dehaze at quarter resolution.** The dark channel and transmission are
  low-frequency by nature. Compute them on a ½- or ¼-scale image and upsample
  with the guided filter from Q2 (He's *Fast Guided Filter*, 2015) — typically
  4–10× cheaper for this stage with no visible loss.
- **Analyse on a thumbnail.** `analyse()` only needs means and a luma
  variance; a 256-px downsample is plenty.
- **Worker pool.** Photos: process a batch across
  `navigator.hardwareConcurrency - 1` workers. Video: keep 2–4 frames in
  flight (decode N+1 while grading N) instead of a single serial worker; the
  analysis is fixed for the whole clip (B3), so frames are independent.
- **Transfer, don't copy.** `data.data.slice().buffer`
  (`src/video.ts:89`, `src/main.ts:98`) copies every frame before
  transferring it; the `getImageData` result is already private and can be
  transferred directly in the video path.

### P4 — GPU path for real-time preview (L)

Every stage except CLAHE's per-tile histograms and the atmospheric-light
search is per-pixel or a separable filter — ideal fragment/compute-shader work.
A WebGPU implementation (WebGL2 fallback) would:

- make the video preview **real-time with a live before/after split**, which
  the README currently says is "not reachable in JavaScript";
- let `VideoFrame`s go straight from the decoder to a GPU texture
  (`importExternalTexture`) without `getImageData` round trips;
- keep the CPU pipeline as the reference implementation and the fallback, and
  test the two against each other (E2).

Suggested order: port tone/saturation/WB (trivial) → unsharp + min/box filters
→ dehaze with GPU guided filter → CLAHE (histograms via compute shader
atomics, or keep CLAHE on CPU at low-res and upload the 8×8 LUT grid as a
texture).

---

## 4. Image quality

### Q1 — Red compensation from the green channel (Ancuti 2018) 🔴 (S)

The current red restoration is a gamma-like curve
`f(v) = tr·(v/tr)^(1−s)` — it rescales the red that is left, but where red is
~0 there is nothing to scale, which is why deep shadows stay purple (README
"Honest limitations"). Green is attenuated much less than red and is strongly
correlated with it, so Ancuti et al. (*Color Balance and Fusion for Underwater
Image Enhancement*, IEEE TIP 2018) **borrow signal from green**:

```
R_c(x) = R(x) + α · (Ḡ − R̄) · (1 − R(x)) · G(x)        α ≈ 1, values in [0,1]
```

- `(Ḡ − R̄)` is the global red deficit (already computed as `redDeficit`).
- `(1 − R(x))` protects pixels that already have red (coral, strobe-lit
  subjects), replacing the current anchor trick.
- `G(x)` puts red back where there is actual scene signal, not in the water.
- For green-water scenes, the same form compensates **blue** from green.

Run it *before* white balance (as the paper does), keep the existing
`redDeficit` gate and `redStrength` slider as `α`. It's ~15 lines, one pass,
and is the single highest-leverage quality change here.

### Q2 — An underwater-aware dark channel + a real guided filter 🔴 (M)

Two issues with the dehaze stage:

1. **Standard DCP misfires underwater.** Red is dark everywhere underwater, so
   `min(R,G,B)` ≈ `R` and the dark channel mostly measures red attenuation,
   not haze. Better-suited priors:
   - **UDCP** (Drews et al. 2013): dark channel over `G` and `B` only.
   - **Red Channel Prior** (Galdran et al. 2015): `min(1 − R, G, B)`.
   Also estimate **per-channel transmission**
   `t_c = t_b^(β_c/β_b)` using typical ocean attenuation ratios
   (e.g. β_r:β_g:β_b ≈ 0.8:0.3:0.1 for Jerlov type I), so red is lifted more
   than blue in the far field — this is what the Jaffe–McGlamery model
   actually predicts.
2. **Refinement is a min filter, not a guided filter.** README and the header
   comment say "guided transmission", but the code refines with
   `minFilter(t, w, h, 5)` (`src/pipeline.ts:449`). A min filter on a
   block-wise transmission map produces **halos and blocky edges** around
   silhouettes (divers, fish against open water). He's guided filter is O(n)
   using box filters — and `boxBlur` already exists:

   ```ts
   // I = luminance guide, p = raw transmission, r ≈ 20–40 px, eps ≈ 1e-3
   meanI = box(I); meanP = box(p); corrIP = box(I*p); varI = box(I*I) - meanI²
   a = (corrIP - meanI*meanP) / (varI + eps);  b = meanP - a*meanI
   q = box(a)*I + box(b)
   ```

   Combined with P3's quarter-resolution trick, this is both better and faster.

Also consider making atmospheric-light estimation robust to bright subjects
(strobe highlights, white sand) with Kim et al.'s quad-tree search, or by
restricting candidates to the upper half of the frame / low-saturation
pixels.

### Q3 — Robust white balance + tap-to-neutral 🔴 (S)

Gray-world assumes the scene averages to grey; the code comments already note
it "chases whatever is brightest (often a subject)" — the wall of yellow fish.
Improvements, cheapest first:

- **Exclude outliers** from the illuminant estimate: clipped highlights,
  near-black pixels, and the most saturated 5 %.
- **Shades-of-Gray** (Minkowski p ≈ 6) or **Gray-Edge** (average of gradient
  magnitudes) are drop-in replacements that are much less subject-biased.
- **Eyedropper** 🔴: let the user tap something known to be neutral (sand,
  a white slate, a dive-computer screen, a tank). That pixel's colour
  *is* the illuminant — feed it to P2's adaptation matrix. Divers already do
  this in Lightroom; it's the most-requested control in underwater editing and
  costs ~50 lines.

### Q4 — Noise-aware sharpening (S)

The unsharp mask (`src/pipeline.ts:619`) is a plain box-blur USM applied
everywhere; the README calls it "edge-aware", but it isn't. Underwater frames
have **backscatter particles and sensor noise in flat blue water**, which USM
amplifies — and video encoders then spend bits on that noise.

- Add a **threshold/coring** term: only sharpen where `|L − blur| > τ`, with a
  soft knee.
- Or modulate the amount by local variance (`boxBlur(L²) − boxBlur(L)²`), so
  flat water gets ~0 and edges get the full amount.
- Optionally a light edge-preserving denoise (guided filter self-guided, or
  bilateral) before CLAHE, since CLAHE also amplifies noise in flat tiles.

### Q5 — Temporal consistency for video (S)

Holding one analysis for the whole clip (after B3's fix) is right for short
clips, but a 3-minute dive descends through changing depth and light.
Proposal:

- Re-analyse every ~0.5 s on a thumbnail (cheap after P3).
- Smooth with an **EMA** (τ ≈ 2–3 s) so parameters glide rather than jump.
- Reset the EMA on a **scene cut** (histogram distance between consecutive
  thumbnails above a threshold).

### Q6 — Optional on-device ML model (L)

The README's honest limitation — "a deep-learning model will generally look
better, but needs a server or a large WASM runtime" — is less true in 2026.
ONNX Runtime Web and transformers.js run on **WebGPU** in-browser, and
lightweight underwater models (e.g. Shallow-UWnet, FUnIE-GAN-class networks)
are in the sub-MB to few-MB range. Keeping privacy intact:

- Ship as an **opt-in "AI 強化" mode**, lazily loaded like mediabunny, cached
  by the service worker (U4).
- Run at ≤ 512 px and use the network's output as a **colour transfer** onto
  the full-res image (e.g. fit a per-tile 3×3 colour matrix or a 3D LUT), so
  resolution and detail stay classical.
- Check model licences before bundling; prefer MIT/Apache weights.

A more ambitious follow-up is **Sea-thru-style** depth-aware correction using
a small monocular depth model (Depth-Anything-small via transformers.js) to
make attenuation vary with distance.

---

## 5. Product & UX

### U1 — Full-resolution output and better formats 🔴 (M)

- Photos are capped at 1600 px (`MAX_EDGE`, `src/main.ts:30`) **for export
  too**, so a 24 MP dive photo comes out at ~2 MP. Keep 1600 px for the
  interactive preview, but on download re-run the pipeline at full resolution
  in the worker (parameters are resolution-independent, except filter radii,
  which should be scaled by `edge / 1600`).
- Offer **JPEG / WebP with a quality slider** (PNG of a 24 MP photo is huge),
  and **preserve EXIF** (date, GPS, camera, and especially orientation) by
  copying the source APP1 segment into the JPEG output.
- `downloadAll` triggers N separate downloads 300 ms apart; browsers often
  block that. Offer a single ZIP (a small store-only zip writer is ~100 lines,
  or `fflate`).

### U2 — Make Auto transparent 🔴 (S)

See B2. Also show *why* Auto chose its values in the diagnosis panel
(e.g. "紅色缺損 42 % → 紅色復原 0.71"), which builds trust and teaches users
which slider to reach for.

### U3 — Video export UX (S)

- **Stream to disk** for long clips: `BufferTarget` keeps the whole output in
  memory. Use mediabunny's `StreamTarget` with
  `showSaveFilePicker()` (File System Access) where available, falling back
  to `BufferTarget`.
- Show **ETA** (frames done / elapsed) next to the percentage.
- Add a **trim range** so users can export just the good 10 s.
- Add a **before/after split** to the video preview (cheap with P4, possible
  now with two canvases).

### U4 — PWA: offline, installable, share target (S)

The app's promise is "offline, private". Make it literally true:

- `manifest.webmanifest` + a service worker (e.g. `vite-plugin-pwa`) so it
  works on a boat with no signal and installs to the home screen.
- A **Web Share Target** so divers can pick photos in the phone gallery →
  Share → Underwater Recovery.

### U5 — Smaller UX items

- **Split-view rendering.** Every `pointermove` on the handle rebuilds two
  `ImageData` crops, two temporary canvases, **and all queue thumbnails**
  (`draw()` → `renderQueue()`). Instead, draw original and result into two
  stacked canvases once and move a CSS `clip-path: inset(0 0 0 X%)` on the top
  one; only re-render the queue when the queue changes.
- **Keyboard access**: make the split handle a focusable `role="slider"` with
  arrow keys; add arrow-key navigation to the tabs.
- **Custom presets**: save/load the current parameters (localStorage) and
  "apply these settings to all photos in the batch".
- **Language toggle**: UI is zh-Hant only while the README is English; a tiny
  string table with zh-Hant / English would widen the audience.

---

## 6. Engineering

### E1 — CI and portability (S)

- `pages.yml` only runs on pushes to `main`; nothing runs on pull requests.
  Add a `ci.yml` on `pull_request` that runs `npm ci`, `npm test` and
  `npm run build`.
- `tsconfig.json` includes only `src`, so `test/` and `bench/` are never
  type-checked (and bench files use `// @ts-nocheck`). Add a
  `tsconfig.test.json` and a `typecheck` script.
- All scripts hard-code `/Applications/Google Chrome.app/...` and
  `bench/probe.ts` reads `/Users/jonwenjen/.hermes/...`. Switch them to
  **Playwright** (or `process.env.CHROME_PATH` with a sensible default) and
  commit a tiny synthetic fixture clip (`scripts/make-underwater-clip.mjs`
  already generates one), so the video e2e can run in CI.
- Add ESLint + Prettier (the code is already consistently formatted — lock it
  in).

### E2 — Regression tests that catch visual changes (M)

The numeric tests guard direction ("red went up"), not appearance. Add:

- **Golden images**: 6–10 small (≈320 px) real underwater photos with
  permissive licences, their expected outputs committed, and a per-image
  tolerance on mean ΔE2000 / PSNR. Any algorithm change produces a visible
  diff to review.
- **No-reference quality metrics** commonly used for underwater imagery —
  **UCIQE** and **UIQM** — computed before/after on the same set, so proposals
  like Q1/Q2 can be judged by numbers as well as by eye.
- **Unit tests per stage** (e.g. "min filter equals brute force on random
  input", "guided filter with eps→0 reproduces the guide").
- A **perf budget** test (e.g. 640×360 must stay under N ms relative to a
  reference loop) so regressions like the `pow`-per-pixel one are caught.

### E3 — Clean-ups and doc drift (XS)

- Delete Vite template leftovers: `src/counter.ts`, `src/assets/hero.png`,
  `src/assets/typescript.svg`, `src/assets/vite.svg` (none are referenced).
- `src/worker.ts` contains a full `VideoReq` branch that nothing sends —
  video uses `src/video.worker.ts`, which duplicates the same logic. Keep one
  worker with one message type.
- Documentation vs code:
  - README/header say **guided** transmission → code uses a min filter (Q2).
  - README says **edge-aware** unsharp → it's a plain box USM (Q4).
  - `clahe()` says LUTs are "gaussian-blurred" → they aren't.
  - `src/video.ts` header says ~200 ms/720p frame and 12-frame preview reuse;
    README says 45 ms/640×360. Pick one source of truth, ideally generated by
    the bench.
- Split `pipeline.ts` (730 lines) into `color.ts`, `filters.ts`
  (min/box/guided), and one file per stage, all operating on a shared
  `Scratch` buffer context (P3). This makes the GPU port (P4) a stage-by-stage
  swap.

---

## 7. Roadmap

**Phase 1 — Fix & speed (≈1 week)**
B1, B2 + U2, B3, B4, P1, minor bugs, E1, E3.
_Outcome: downloads are correct, controls do what they show, ~2× faster, CI on PRs._

**Phase 2 — Look better (≈2 weeks)**
Q1 (Ancuti red), Q3 (robust WB + eyedropper), P2 (CAT matrix), Q2 (UDCP +
guided filter at low-res), Q4 (noise-aware sharpen), E2 (golden images +
UCIQE/UIQM to prove each change).
_Outcome: visibly better shadows and edges, measurable quality gains._

**Phase 3 — Ship like a product (≈1–2 weeks)**
U1 (full-res, JPEG/EXIF, ZIP), U3 (stream-to-disk, ETA, trim), U4 (PWA +
share target), U5, Q5 (temporal smoothing), P3 (worker pool, buffer reuse).

**Phase 4 — Stretch**
P4 (WebGPU real-time preview with live split), Q6 (opt-in on-device ML,
depth-aware correction).

---

## Appendix — How the measurements were made

```bash
npm test                                             # 7/7 pass on main
node --experimental-strip-types bench/stages.ts      # per-stage cost, 1280×720
node --experimental-strip-types bench/bench.ts       # full pipeline at 3 sizes
```

P1 was measured on a scratch copy of `src/pipeline.ts` in which only
`toLinear` (256-entry table) and `toSrgb` (4096-entry table) were replaced;
`npm test` produced identical numbers on both versions. B2 was verified by
calling `autoParams()` with and without the "blue" preset merged in and
comparing the resulting fields.

### References

- C. Ancuti, C. O. Ancuti, C. De Vleeschouwer, P. Bekaert — *Color Balance and
  Fusion for Underwater Image Enhancement*, IEEE TIP 2018.
- P. Drews Jr. et al. — *Transmission Estimation in Underwater Single Images*
  (UDCP), ICCV Workshops 2013.
- A. Galdran et al. — *Automatic Red-Channel Underwater Image Restoration*,
  JVCIR 2015.
- K. He, J. Sun, X. Tang — *Guided Image Filtering*, TPAMI 2013; K. He,
  J. Sun — *Fast Guided Filter*, arXiv 2015.
- D. Akkaynak, T. Treibitz — *Sea-thru*, CVPR 2019.
- M. Yang, A. Sowmya — *UCIQE*, TIP 2015; K. Panetta et al. — *UIQM*, IEEE
  JOE 2016.
- G. Finlayson, E. Trezzi — *Shades of Gray and Colour Constancy*, 2004;
  J. van de Weijer et al. — *Edge-Based Color Constancy*, TIP 2007.
