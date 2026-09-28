# 外部來源與授權紀錄 / Provenance and licensing

本專案是 **MIT**。下面四個外部專案全部是 copyleft 或無授權，因此**沒有任何一行它們的程式碼被複製進來**。
No line of code from any of the four upstream projects has been copied into this
MIT-licensed repository. Each method was reimplemented from its published
description; algorithms are not copyrightable, only their expression is.

實作位置 / Implementation:

| Preset | Method | Source module |
|---|---|---|
| `全自動-bornfree` | Histogram-gap colour matrix, fixed 256×256 analysis | `src/engine/matrix.ts` |
| `全自動-nikolajbech` | Same matrix, threshold scales with frame size | `src/engine/matrix.ts` |
| `全自動-T77701` | Fu et al., ISPACS 2017, Eq. 2 | `src/engine/twostep.ts` |
| `全自動-warplab` | Akkaynak–Treibitz formation model, closed form | `src/engine/physical.ts` |

測試 / Tests: `test/methods.test.ts` (39 checks).

---

## 1. bornfree/dive-color-corrector

- **Upstream:** <https://github.com/bornfree/dive-color-corrector> · GPL-3.0 · Python · 153★
- **What it actually is:** a Python port of #2, not an implementation of
  Ancuti et al. 2017. It cites no paper; its own README points at
  nikolajbech/underwater-image-color-correction. A grep for `lab`, `gamma`,
  `clahe`, `percentile`, `shades of grey`, `attenuat` over `correct.py` returns
  nothing.
- **Constants reproduced:** `THRESHOLD_RATIO` 2000, `MIN_AVG_RED` 60,
  `MAX_HUE_SHIFT` 120°, `BLUE_MAGIC_VALUE` 1.2, gain numerator **256** (not 255).
- **The difference from #2:** it analyses a `cv2.resize(mat, (256,256))`
  downscale, which pins the sparse threshold at 65536/2000 = 32.768 and makes
  the result independent of input resolution. That is the whole reason
  `全自動-bornfree` and `全自動-nikolajbech` are separate presets — and the
  fixed grid is the better choice for video, where a per-frame
  resolution-dependent threshold makes the correction breathe.

## 2. nikolajbech/underwater-image-color-correction

- **Upstream:** <https://github.com/nikolajbech/underwater-image-color-correction> · **no licence** (all rights reserved) · JS · 110★
- **What it is:** an author's heuristic. It cites no paper at all. The
  npm demo at `colorcorrection.firebaseapp.com` runs a *different* method with
  an extra "Gain adjust" stage (confirmed by the author in issue #1).
- **Constants reproduced:** same set as #1, plus the `+2` slack on the sparse
  test (`hist[i] - threshold < 2`).
- **Faithful quirks, each covered by a test:**
  - gains use 256 and the offset is scaled by 255, so the mapped endpoints land
    at 0 / 255.06 rather than 0 / 255;
  - the hue-shift loop increments *after* evaluating, so the returned angle is
    one degree past the last working one, and a hopeless image clamps at
    **121**, not 120;
  - the 1.2 blue factor is applied when building the matrix but **not** when
    building the histogram, so the blue term actually subtracted is 20% larger
    than the one that was analysed.
- **Deviation, deliberate:** a gap narrower than `MIN_TONAL_SPAN` (24) is
  treated as a hairline between two adjacent empty bins and replaced by the
  full range. In the reference implementation a flat frame makes almost every
  bin sparse, the candidate list degenerates to `0,1,2,…,255`, every gap is
  exactly 1, and the leftmost wins — a red gain of **256**. A 2×1 crop really
  does produce this. Clamping the span keeps the method usable on small crops.
- **Deviation, documented:** the reference derives its sparse threshold from
  the pixel count and so must analyse the frame it will correct. This engine
  hands `AutoEngine.step()` a 192 px analysis thumbnail rather than the
  full-resolution frame, so `全自動-nikolajbech` analyses that thumbnail
  (threshold = thumbnailPixels / 2000), while `全自動-bornfree` resamples to
  exactly 256×256 and so always lands on 32.768. That difference in threshold
  is exactly the behavioural difference between the two upstream projects, and
  it is why the two presets do not produce identical output — but for
  `全自動-nikolajbech` it is an approximation of the original's full-resolution
  analysis, not a reproduction of it.

## 3. T77701/Underwater-Image-Enhancement-Resources

- **Upstream:** <https://github.com/T77701/Underwater-Image-Enhancement-Resources> · no licence · **0★** · `language: null`
- **What it is:** a curated link list. The whole repository is a 45 KB
  `README.md` plus nine paper-screenshot PNGs. There is no `src/`, no `.py`,
  no `.js`, and nothing to port.
- **What `全自動-T77701` therefore implements:** the technique that list points
  to and that is actually implementable —
  Fu, Fan, Ling, Huang, Ding, *"Two-Step Approach for Single Underwater Image
  Enhancement"*, ISPACS 2017, pp. 789–794.
  <https://xueyangfu.github.io/paper/2017/ISPACS/ISPACS2017.pdf>
- **Ported:** Eq. 2's protection branch. When more than 70% of a channel's
  pixels sit at or below 40, the channel is *shifted* (`S − λ(mean − 128)`,
  λ = 0.4) rather than stretched. A shift moves the mean and leaves the
  spread exactly alone; on a red channel crushed to ~10 grey levels that is the
  difference between lifting the subject and detonating sensor noise.
- **Not ported:** the contrast step (Eq. 5–6). Its gradient terms cancel
  analytically when both weights are equal, and the printed closed form has a
  Fourier denominator whose DC gain is ½ — i.e. reproducing it faithfully
  halves the brightness of every image. The correct Tikhonov form is
  implementable but is "weighted average plus a high-frequency shelf", which
  this engine already obtains from CLAHE + clarity.
- **Note:** the commonly circulated MATLAB reproduction uses λ = 0.1 and a
  strict `<` at the mean; neither matches the paper. The paper's 0.4 is used.

## 4. warplab/DeepSeeColor

- **Upstream:** <https://github.com/warplab/DeepSeeColor> · **AGPL-3.0** · Python + PyTorch/Kornia · 40★
- **Paper:** Jamieson, How, Girdhar, *"Deep See Water"*, **ICRA 2023**,
  pp. 3095–3101, <https://arxiv.org/abs/2303.04025>.
- **Attribution correction:** the frequently cited *"Deep See Water: Towards
  Underwater Image Enhancement Using CNN" (Li, Guo, Loy, He, ECCV 2018)* could
  not be verified to exist. Searches of the full ECCV 2018 programme (776
  titles), DBLP, Crossref and arXiv all returned nothing relevant. The ICRA
  2023 paper above is real and is what the repository implements.
- **What is reimplemented:** the Akkaynak–Treibitz underwater image formation
  model, which is the physics the paper's 25 fitted scalars parameterise:

  ```
  I = J·A + B
  A = exp(-a_c·z)              attenuation
  B = β·(1 - A)                 backscatter
  J = (I - B) / A               restoration
  ```

  with Jerlov-type per-channel coefficients (`src/engine/physical.ts`); the
  water type is chosen from the engine's own measured veil, and the depth
  scale from the measured haze.
- **This is an approximation, and it is a deliberate one.** The published method
  fits `a_c` and `β` per image with a self-supervised network; a browser has
  neither a depth map nor a per-frame optimiser budget. The published code also
  requires a single-channel depth image as a hard input, which this app cannot
  ask a user for.
- **The gain is clamped at 3×.** `exp(a_r·z)` is unbounded: a pixel 40 m out
  with almost no surviving red asks for a multiple of 100, and in a real image
  that pixel is sensor noise, not signal. The reference implementation clamps
  for the same reason.

---

## Measured behaviour, and the limits of each profile

On a real shallow-water photograph (divers, bait ball, strobed; source mean
`r=106 g=108 b=87`, blue-cast −19.8), rendering the whole engine plus the
imported method:

| Profile | mean r,g,b | blue-cast | verdict |
|---|---|---|---|
| 全自動-bornfree | 114, 119, 112 | −4.5 | balanced |
| 全自動-nikolajbech | 117, 119, 112 | −5.9 | balanced |
| 全自動-T77701 | 185, 140, 113 | −49.5 | visibly warm |
| 全自動-warplab | 162, 104, 85 | −47.9 | visibly warm |

The two matrix profiles behave. The other two land warm on **this** photo, and
the reason is the photo rather than the implementations: both are red-restoring
methods aimed at water that has genuinely absorbed red, and a shallow strobed
frame is not that. The engine's own auto pipeline restores red gently and a
frame like this is already close, so a method that adds a deliberate red lift
tips it over. On a deeper, unlit frame they are the ones doing the needed work.

Both ship with their strength below maximum for the same reason
(`meanPull` 0.7, `physicalDepth` 0.45) and both are exposed as sliders.

### Guards added, and why each exists

These are deviations from the published methods, all deliberate:

- **R-row blue term capped at −0.85** (`matrix.ts`). With the published 1.2
  factor the coefficient reaches −1.4 on a red-starved frame, and every blue
  pixel is pulled far below red: magenta.
- **Hue-shift search limited to 60°** in the presets (`matrixHue`). The
  published search runs to 121°, which folds a large amount of green into red.
- **Tonal span floor of 24** (`MIN_TONAL_SPAN`). A flat or tiny crop makes the
  reference method return a gain of 256.
- **Differential gain anchored on green** (`physical.ts`). The literal model
  gain `exp(a_c·z)` is >3 for both red *and* green at 10 m, so both clamp and
  the red-to-green ratio — the entire point — is destroyed; the frame goes
  green.
- **Blue gain fixed at 1.0.** Reducing blue as well produces a golden fog: the
  blue that survives underwater is scattered light, not an attenuated signal.
- **Backscatter capped at half a channel.** Subtracting the full backscatter
  term from a red-starved channel removes more than is there and sends it to
  zero.
- **`physicalMix` scales with measured red starvation.** On a frame that still
  has red, the physical model should do nothing, and as a "全自動" profile it
  now does.

## Deliberate omissions

- **No `c·(max/curr)^p` white balance.** That formula belongs to Ancuti's 2011
  ICIP work, not the 2017 TIP paper. Neither `c` nor `p` is defined in TIP
  2017, which uses a Shades-of-Grey p = 5 percentile illuminant estimate.
  Neither upstream repo implements it, so neither profile pretends to.
- **No Ancuti fusion.** The four weight maps (contrast, saliency, saturation,
  well-exposedness) and the 10-level pyramid need global statistics, a σ = 20
  separable Gaussian and a full multi-resolution pyramid — not a single
  fragment pass. The engine's existing Ancuti-style red compensation
  (`r += aR·dR·(1-r)·g`) is unrelated to the upstream repos and predates them.
- **No `L_intensity` / `L_var` / `L_saturation` loss port.** They are training
  regularisers for a per-image fit that this approximation does not run.
