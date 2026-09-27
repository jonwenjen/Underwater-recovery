# 🌊 Underwater Recovery

Automatic recovery of underwater photos, running entirely in your browser.
Fixes the four things that go wrong underwater:

| Problem | What the app does |
|---|---|
| Heavy blue / green cast | Gray-world white balance on LAB chroma, referenced against a neutral grey so colour-accurate photos are left alone |
| Missing red & warm tones | Jaffe–McGlamery spectral expansion of the red channel, anchored at the observed maximum so nothing clips |
| Low contrast / water haze | Dark channel prior dehazing with guided transmission, self-limiting so clean images are untouched |
| Blurry fine detail | CLAHE on the luminance plane + edge-aware unsharp mask |

**No server, no upload, no account.** Every pixel is processed in a Web Worker
in the tab. Nothing leaves your machine.

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # numeric pipeline tests (no browser needed)
npm run build    # typecheck + production bundle
```

## Using it

Drop photos in (or paste from the clipboard). The before/after slider compares
them. Pick a preset or let auto mode tune itself, then adjust any stage by hand.

- **Auto** — scales every correction by how strongly the image actually reads as
  underwater, so a strobe-lit shot with its reds intact is not pushed into neon.
- **深藍海水 / 綠水 / 混濁近攝 / 淺水自然** — fixed starting points for common
  conditions. Tweak from there.
- Batch: drop many files, switch between them in the strip, then 下載全部.

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

## Honest limitations

- **Red is guessed, not recovered.** Water physically absorbs red; that
  information is gone. A deep-learning model (UIEB / Water-Net class) will
  generally look better, but needs a server or a large WASM runtime. This is a
  deliberate trade for a private, offline, dependency-free tool.
- Deep shadows in a strobe-lit scene can keep a residual purple cast, and very
  turbid water still fights you. The sliders are there for that.
- Images are processed at up to 1600 px on the long edge; the original file is
  not written back.
- Video is out of scope — export a frame first.

## References

- Jaffe & McGlamery — underwater imaging model
- He, Sun & Tang — dark channel prior dehazing
- Zuiderveld — CLAHE
- OpenCV, *Guide to Underwater Image Enhancement* — stage ordering and defaults

MIT licensed.
