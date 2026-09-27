# 🌊 Underwater Recovery

Automatic recovery of underwater **photos and video**, running entirely in your
browser. Fixes the four things that go wrong underwater:

| Problem | What the app does |
|---|---|
| Heavy blue / green cast | Gray-world white balance on LAB chroma, referenced against a neutral grey so colour-accurate photos are left alone |
| Missing red & warm tones | Jaffe–McGlamery spectral expansion of the red channel, anchored at the observed maximum so nothing clips |
| Low contrast / water haze | Dark channel prior dehazing, self-limiting so clean images are untouched. The transmission map is smoothed with a windowed **minimum** filter, not He's guided filter — see limitations |
| Blurry fine detail | CLAHE on the luminance plane + an unsharp mask. The mask is a plain box blur, **not** edge-aware and not noise-aware — see limitations |

**No server, no upload, no account.** Every pixel is processed in a Web Worker
in the tab. Nothing leaves your machine. Video is decoded, graded and re-encoded
locally via WebCodecs; the file is never sent anywhere.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # numeric pipeline tests (no browser needed)
npm run typecheck  # src + test + bench
npm run build      # typecheck + production bundle
npm run bench      # per-resolution frame timings

# video end-to-end test — drives a throwaway headless Chrome with its own
# profile, so it never touches your own browser
node scripts/e2e-video.mjs \
  http://localhost:4173/Underwater-recovery/ test/fixtures/underwater.mp4 /tmp/out.mp4
```

CI runs typecheck, the pipeline tests, the production build and that same
video e2e on every push and pull request.

## Using it

Drop photos in (or paste from the clipboard). The before/after slider compares
them. Pick a preset or let auto mode tune itself, then adjust any stage by hand.

- **Auto** — scales every correction by how strongly the image actually reads as
  underwater, so a strobe-lit shot with its reds intact is not pushed into neon.
  Auto is a *starting point*, not an override: it writes its values onto the
  sliders, and any slider you move — or any preset you pick — pins that value
  for the rest of the session. Click 自動判斷 to hand everything back to Auto.
- **深藍海水 / 綠水 / 混濁近攝 / 淺水自然** — fixed starting points for common
  conditions. Tweak from there.
- Batch: drop many files, switch between them in the strip, then 下載全部.

## Video

The 影片 tab takes MP4 / WebM / MOV and runs the *same* pipeline over every frame,
with the same presets and sliders. Audio is passed through untouched.

- **Preview** is a scrub bar, not live playback. The graded pipeline runs at
  roughly 45 ms per 640×360 frame, so real-time preview is not reachable in
  JavaScript — you get a still frame at the playhead plus the real parameters.
- **Export** decodes, grades and re-encodes offline with a progress bar and a
  cancel button. Cost is roughly linear in frames: expect about a minute for a
  10-second 720p 30 fps clip.
- Parameters are analysed **once**, from the first few frames, and held for the
  whole clip. Per-frame auto-analysis flickers, because underwater statistics
  swing with every passing shadow.
- Choose the output size (720p / 1080p / 1440p / 2160p / original) and MP4 or
  WebM. Frames are resampled to the target size *before* grading, so a 4K source
  is not processed at 4K.

Implementation notes worth knowing if you touch this code:

- `src/video.ts` owns decode/encode. `src/video.worker.ts` owns the per-frame
  grading. `src/controls.ts` is the shared slider/preset builder.
- mediabunny does **not** pre-scale samples before calling the `process`
  callback, and the encoder takes its dimensions from the sample you return — so
  the scale happens by hand inside the callback. Passing `width`/`height` alone
  silently does nothing.
- A `VideoSample` is not a `CanvasImageSource`; draw it with `sample.draw(...)`.
- `quality` must be a `Quality` instance (`QUALITY_HIGH`), not a string. The
  pipeline sharpens, and sharpening amplifies compression artefacts, so this is
  not cosmetic.
- The export analyses the clip itself, from 7 frames spread across 5–95 % of the
  runtime, taking a per-field median. It never reuses the preview's analysis:
  the preview analyses a single ≤480 px frame at the playhead, so reusing it made
  the same file export differently depending on where you last scrubbed.

## How the pipeline works

Photometric stages run in **linear light**, where the absorption and scattering
model is physically meaningful; perceptual stages run on **sRGB-encoded** values,
where CLAHE and unsharp actually do something:

```
sRGB ─▶ linear
  1. white balance   LAB a/b shifted by the measured cast vs a neutral grey
  2. red restoration red expanded toward its observed max, gated on real deficit
  3. dehazing        dark channel prior, omega scaled by measured haze
linear ─▶ sRGB
  4. CLAHE           local contrast, luminance only, mean preserved
  5. unsharp         edge detail
  6. de-cast guard   mid-tone-weighted grey-world trim
  7. tone            levels, gamma, saturation
```

### Implementation notes worth knowing

- **Red expansion is anchored.** `f(v) = tr · (v/tr)^(1-s)` satisfies `f(0)=0`
  and `f(tr)=tr`, so it widens a compressed range without inventing light or
  blowing out already-bright pixels. It is also gated on a red deficit measured
  *before* white balance, since WB equalises the channel means and would
  otherwise erase the signal.
- **CLAHE output is written back into the colour planes.** Computing it on `L`
  and stopping there is a silent no-op; the new luminance has to be pushed back
  through a ratio that preserves chroma.
- **Dehazing is self-limiting.** The dark channel prior assumes the dark channel
  sits well below the atmospheric light. In a clean image it does not, and full
  strength would collapse the frame. `omega` is scaled by measured haze, so a
  clean scene gets a no-op.
- **The de-cast is mid-tone weighted.** A flat global gain chases whatever is
  brightest (often a subject) and leaves deep shadows — which carry almost no
  red signal — tinted purple.
- **An sRGB grey is not LAB-neutral under D65.** The white balance measures the
  chroma of a neutral grey at the same brightness and subtracts it, so a
  colour-accurate photo is not tinted.

## Tests

`test/pipeline.test.ts` runs the real pipeline over a synthetic underwater frame
and a neutral-grey frame, asserting all four recovery goals numerically, plus two
regression guards that caught real bugs during development:

- a neutral grey must not be flagged underwater, and must stay grey
- a no-op configuration must not change a single byte

## Numerics

The colour transforms are table-driven: a 256-entry LUT into linear light, and a
4096-entry LUT out of it with linear interpolation. The tone curve is likewise
indexed on the float sRGB value rather than a rounded byte. Nothing in the
pipeline re-quantises to 8 bits until the final write, where a half-LSB of
zero-mean dither breaks up the contour banding that stretched 8-bit steps cause
in smooth water.

Two consequences worth knowing:

- Any table lookup that interpolates at exactly 1.0 must guard the last index.
  Reading one entry past the end yields `NaN`, and a `NaN` written to a
  `Uint8ClampedArray` becomes `0` — so a missing guard turns every fully clipped
  channel black. There are regression tests for exactly this.
- Removing the mid-pipeline quantisation changes individual pixels by a few LSB
  (the unsharp stage differences nearby values, so it amplifies small changes),
  while leaving global colour statistics unchanged to within 0.1 LSB.

## Honest limitations

- **Red is guessed, not recovered.** Water physically absorbs red; that
  information is gone. A deep-learning model (UIEB / Water-Net class) will
  generally look better, but needs a server or a large WASM runtime. This is a
  deliberate trade for a private, offline, dependency-free tool.
- Deep shadows in a strobe-lit scene can keep a residual purple cast, and very
  turbid water still fights you. The sliders are there for that.
- **The unsharp mask is not edge-aware.** It is a plain box USM applied
  everywhere, so it also amplifies backscatter and sensor noise in flat water.
  A variance-gated or cored version is the obvious next step.
- **Transmission is smoothed with a windowed minimum filter, not a guided
  filter.** That can leave mild halos and blocky edges around silhouettes
  (a diver against open water). His is O(n) and `boxBlur` already exists here,
  so swapping it in is cheap.
- Red restoration rescales the red that survives; it does not borrow signal from
  the green channel the way Ancuti et al. (2018) do, which is why deep shadows
  stay the weakest part of the result.
- Photo export is capped at 1600 px on the long edge. Video export is not.
- Images are processed at up to 1600 px on the long edge; the original file is
  not written back.
- Video re-encodes rather than stream-copying the video track, so quality is
  re-quantised. Audio is copied, not re-encoded. Codec support follows
  WebCodecs: H.264 everywhere, VP9/AV1 where the browser offers them.
- Export runs on the main thread's worker pool and will keep a laptop busy for
  the length of the export. There is no GPU path.

## References

- Jaffe & McGlamery — underwater imaging model
- He, Sun & Tang — dark channel prior dehazing
- Zuiderveld — CLAHE
- OpenCV, *Guide to Underwater Image Enhancement* — stage ordering and defaults

MIT licensed.
