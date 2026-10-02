import { FUSE_GAMMA, SEATHRU_MAX_GAIN } from './pipeline.ts';
import { DIVEROUT_PLUS } from './diverout.ts';

/**
 * GLSL for the three full-resolution passes. The maths mirrors `auto.ts`
 * (`step` stages 2–6 and `mirrorRender`) — keep them in lock-step.
 */

const COMMON = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 o;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec3 toLin(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSrgb(vec3 l) {
  l = clamp(l, 0.0, 1.0);
  return mix(l * 12.92, 1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), l));
}
// user rotation (quarter turns clockwise) and horizontal flip: maps an
// output-space uv to where it lives in the unrotated source texture
uniform int u_rot;
uniform float u_flipH;
vec2 srcUV(vec2 uv) {
  if (u_flipH > 0.5) uv.x = 1.0 - uv.x;
  if (u_rot == 1) return vec2(uv.y, 1.0 - uv.x);
  if (u_rot == 2) return vec2(1.0 - uv.x, 1.0 - uv.y);
  if (u_rot == 3) return vec2(1.0 - uv.y, uv.x);
  return uv;
}
vec3 shoulder(vec3 x) {
  const float k = 0.8;
  return mix(x, k + (1.0 - k) * tanh((x - k) / (1.0 - k)), step(vec3(k), x));
}
vec3 oklab(vec3 c) {
  vec3 lms = vec3(
    dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
    dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
    dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005)));
  lms = pow(max(lms, 0.0), vec3(1.0 / 3.0));
  return vec3(
    dot(lms, vec3(0.2104542553, 0.7936177850, -0.0040720468)),
    dot(lms, vec3(1.9779984951, -2.4285922050, 0.4505937099)),
    dot(lms, vec3(0.0259040371, 0.7827717662, -0.8086757660)));
}
vec3 fromOklab(vec3 lab) {
  vec3 lms = vec3(
    lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z,
    lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z,
    lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z);
  lms = lms * lms * lms;
  return vec3(
    dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
    dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
    dot(lms, vec3(-0.0041960863, -0.7034186147, 1.7076147010)));
}
`;

/** Downsample the source for analysis (mip-filtered) — plain copy. */
export const COPY_FS = `${COMMON}
uniform sampler2D u_src;
uniform vec4 u_crop;   // (x0, y0, width, height) in output uv — whole frame, or the noise probe
void main() { o = vec4(texture(u_src, srcUV(u_crop.xy + v_uv * u_crop.zw)).rgb, 1.0); }
`;

/**
 * Pass 1 — photometric recovery + CLAHE. Writes sRGB-encoded float colour in
 * rgb and the post-CLAHE luminance in alpha (for detail and clarity).
 */
export const GRADE_FS = `${COMMON}
uniform sampler2D u_src;
uniform sampler2D u_pre;    // 畫質修復 output, already oriented, at processing size
uniform float u_direct;     // 1 = read u_pre instead of the source
uniform float u_shoulder;   // highlight roll-off amount (0 when nothing lifts the image)
uniform sampler2D u_coef;   // guided-filter mean coefficients (a, b) at analysis res
uniform sampler2D u_lut;    // CLAHE maps: 256 wide, tiles*tiles rows
uniform float u_aR, u_aB, u_dR, u_dB;
uniform mat3 u_wb;
uniform vec3 u_A, u_Aout, u_k, u_post;
uniform float u_t0, u_dehaze, u_dehazeChroma;
uniform float u_exp;
uniform float u_tiles, u_claheMix, u_claheK;
// --- 自動化流程 (pipeline.ts) -----------------------------------------
uniform sampler2D u_aux;       // analysis res: depth guided coef (a, b), fusion weights (w2, w3)
uniform sampler2D u_lwb;       // 補光區域白平衡: grid of local RGB gains
uniform float u_lwbAmt;
uniform float u_stAmt;         // Sea-thru 深度感知
uniform vec3 u_stB, u_stb, u_stBeta;
uniform vec2 u_labShift;       // Lab 分軸校正: OKLab (a, b) shift toward red / yellow
uniform float u_labAmt;
uniform float u_fuse;          // 多分支融合
uniform sampler2D u_ai;        // 🤖 AI 風格: grid of 3×4 colour transforms (ai.ts), 3 texels per tile
uniform vec2 u_aiGrid;
uniform float u_aiAmt;
const float FUSE_GAMMA = ${FUSE_GAMMA.toFixed(3)};
const float SEATHRU_MAX = ${SEATHRU_MAX_GAIN.toFixed(1)};

// mirrors applyLabShift() / labWeight() in pipeline.ts
vec3 labShift(vec3 e, float t) {
  vec3 lab = oklab(toLin(clamp(e, 0.0, 1.0)));
  float C = length(lab.yz);
  float pale = 1.0 - smoothstep(0.06, 0.14, C);
  float mid = smoothstep(0.03, 0.15, lab.x) * (1.0 - smoothstep(0.85, 1.0, lab.x));
  float surf = 0.3 + 0.7 * smoothstep(0.3, 0.75, t);
  float k = u_labAmt * pale * mid * surf;
  if (k <= 0.0) return e;
  return clamp(toSrgb(clamp(fromOklab(vec3(lab.x, lab.yz + u_labShift * k)), 0.0, 1.0)), 0.0, 1.0);
}
// --- imported 全自動 profiles (docs/sources.md) ----------------------
// A profile is the colour front-end in place of the engine's compensation
// and white balance: its method runs on the sRGB-encoded SOURCE, where it is
// defined and where AutoEngine.profiles measured it, before dehaze. The CPU
// mirror applies it at the same point.
uniform mat3 u_mixMat;         // 直方圖間隙矩陣 (bornfree / nikolajbech)
uniform vec3 u_mixOff;
uniform float u_mixAmt;
uniform vec4 u_pull[3];        // 全自動-T77701: (mean, min, max, darkFraction)
uniform float u_pullAmt;
uniform vec3 u_physA;          // 全自動-warplab: per-channel attenuation
uniform float u_physBack, u_physAmt, u_physMaxGain;
uniform float u_dvK, u_dvSoft, u_dvAmt;  // 全自動-Diverout / Diverout+ (diverout.ts)
uniform vec3 u_dvLo, u_dvHi;
uniform vec3 u_dvWater;                  // Diverout+: open water colour (sRGB) kept
uniform float u_dvKeep;
const float DV_KEEP_WIDTH = ${DIVEROUT_PLUS.keepWidth.toFixed(3)};

// mirrors softRange() / applyDiverout() in diverout.ts
float dvSoft(float y) {
  const float T = 0.06, K = 0.82;
  if (y > K) return K + (1.0 - K) * tanh((y - K) / (1.0 - K));
  if (y < T) return T * exp((y - T) / T);
  return y;
}
vec3 diverout(vec3 e) {
  float amt = u_dvAmt;
  if (u_dvKeep > 0.0) {
    vec3 cp = e / (e.r + e.g + e.b + 1e-4), cw = u_dvWater / (u_dvWater.r + u_dvWater.g + u_dvWater.b + 1e-4);
    float d = length(cp - cw) / DV_KEEP_WIDTH;
    amt *= 1.0 - u_dvKeep * exp(-d * d);
  }
  vec3 t = vec3(clamp(e.r + u_dvK * (1.0 - e.r) * e.g, 0.0, 1.0), e.g, e.b);
  vec3 y = (t - u_dvLo) / (u_dvHi - u_dvLo);
  y = u_dvSoft > 0.5 ? vec3(dvSoft(y.r), dvSoft(y.g), dvSoft(y.b)) : clamp(y, 0.0, 1.0);
  return clamp(e + (y - e) * amt, 0.0, 1.0);
}

// 直方圖間隙色彩矩陣 — src/engine/matrix.ts, applied per pixel in sRGB.
// The upstream method computes gains with a 256 numerator and a 255 offset,
// so the endpoints do not land exactly on 0/255; that deviation is kept.
vec3 mixMatrix(vec3 e) {
  vec3 c = u_mixMat * e + u_mixOff;
  return clamp(mix(e, c, u_mixAmt), 0.0, 1.0);
}

// 全自動-T77701 — Fu et al. ISPACS 2017 Eq. 2, per channel; mirrors
// meanPullGL() in twostep.ts. Crushed channels (most pixels near black) are
// SHIFTED, which moves the mean and leaves the spread alone; otherwise the
// channel is stretched about its mean and re-anchored to 128. Stretching a
// destroyed channel is what detonates shadow noise, so the branch is the
// point. The two are blended over a dark fraction of 0.6–0.8 rather than
// switched at 0.7, so a video hovering there does not flip.
float meanPull(float v, vec4 s) {
  const float TARGET = 128.0 / 255.0;
  float shifted = v - 0.4 * (s.x - TARGET);
  float anchor = s.x <= TARGET ? s.y : s.z;   // min below 128, max above
  float span = anchor - s.x;
  float scale = abs(span) < 1e-5 ? 1.0 : (anchor - TARGET) / span;
  float stretched = (v - s.x) * scale + TARGET;
  float full = clamp(mix(stretched, shifted, smoothstep(0.6, 0.8, s.w)), 0.0, 1.0); // uint8 store, as published
  return mix(v, full, u_pullAmt);
}

// 全自動-warplab — Akkaynak-Treibitz formation model, solved in closed form
// (mirrors physicalGL() in physical.ts; u_physBack already includes β):
//   A = exp(-a_c z),  B = beta (1 - A),  J = (I - B) / A
// The gain is clamped: exp(a_r * z) is unbounded, and a distant red channel
// that is pure sensor noise must not be amplified 100x into magenta.
// The gain is differential, anchored on green (u_physA.y == 0): green is left
// alone and only the channels the water absorbed are lifted. Using the
// absolute exp(a_c·z) gain instead makes red and green both hit the ceiling
// and the red-to-green ratio — the entire point of the correction — is lost.
vec3 physical(vec3 e) {
  vec3 A = exp(-u_physA);
  vec3 B = u_physBack * (1.0 - A);
  // exp(0) = 1 for green by construction, so green passes through untouched.
  vec3 g = clamp(exp(u_physA), vec3(0.0), vec3(u_physMaxGain));
  // Never remove more than half of a channel: on a red-starved frame the
  // backscatter term is larger than the red that survived, and an unguarded
  // subtraction sends the channel to zero and the frame green.
  vec3 b = min(B, e * 0.5);
  return max(vec3(0.0), (e - b) * g);
}


// mirrors guideAt() / applyGuide() in ai.ts: bilinear over tile centres, sRGB
vec3 aiGuide(vec3 e, vec2 uv) {
  vec2 f = clamp(uv * u_aiGrid - 0.5, vec2(0.0), u_aiGrid - 1.0);
  ivec2 i0 = ivec2(floor(f));
  ivec2 i1 = min(i0 + 1, ivec2(u_aiGrid) - 1);
  vec2 w = f - vec2(i0);
  vec4 x = vec4(e, 1.0);
  vec3 y;
  for (int c = 0; c < 3; c++) {
    vec4 m = mix(mix(texelFetch(u_ai, ivec2(i0.x * 3 + c, i0.y), 0), texelFetch(u_ai, ivec2(i1.x * 3 + c, i0.y), 0), w.x),
                 mix(texelFetch(u_ai, ivec2(i0.x * 3 + c, i1.y), 0), texelFetch(u_ai, ivec2(i1.x * 3 + c, i1.y), 0), w.x), w.y);
    y[c] = dot(m, x);
  }
  return clamp(mix(e, clamp(y, 0.0, 1.0), u_aiAmt), 0.0, 1.0);
}

float claheMap(float L, vec2 uv) {
  float T = u_tiles;
  vec2 f = clamp(uv * T - 0.5, vec2(0.0), vec2(T - 1.0));
  vec2 i0 = floor(f);
  vec2 i1 = min(i0 + 1.0, vec2(T - 1.0));
  vec2 w = f - i0;
  float u = (clamp(L, 0.0, 1.0) * 255.0 + 0.5) / 256.0;
  float rows = T * T;
  float l00 = texture(u_lut, vec2(u, (i0.y * T + i0.x + 0.5) / rows)).r;
  float l01 = texture(u_lut, vec2(u, (i0.y * T + i1.x + 0.5) / rows)).r;
  float l10 = texture(u_lut, vec2(u, (i1.y * T + i0.x + 0.5) / rows)).r;
  float l11 = texture(u_lut, vec2(u, (i1.y * T + i1.x + 0.5) / rows)).r;
  return mix(mix(l00, l01, w.x), mix(l10, l11, w.x), w.y);
}

void main() {
  vec3 c = u_direct > 0.5 ? texture(u_pre, v_uv).rgb : texture(u_src, srcUV(v_uv)).rgb;
  // 🤖 AI 風格: the network's colour and tone, on the sRGB source like the network
  if (u_aiAmt > 0.0001) c = aiGuide(c, v_uv);
  // imported 全自動 profile: the method's own colour correction, on the source
  if (u_mixAmt > 0.0001) c = mixMatrix(c);
  if (u_pullAmt > 0.0001) c = vec3(meanPull(c.r, u_pull[0]), meanPull(c.g, u_pull[1]), meanPull(c.b, u_pull[2]));
  if (u_physAmt > 0.0001) c = mix(c, physical(c), u_physAmt);
  if (u_dvAmt > 0.0001) c = diverout(c);
  c = toLin(c);
  // Ancuti compensation: borrow signal from green where the scene has it
  c.r = min(1.0, c.r + u_aR * u_dR * (1.0 - c.r) * c.g);
  c.b = min(1.0, c.b + u_aB * u_dB * (1.0 - c.b) * c.g);
  // white balance (Bradford), then dehaze on the balanced frame
  c = max(u_wb * c, 0.0);
  // 補光區域白平衡: local gains where artificial light varies the illuminant
  if (u_lwbAmt > 0.001) c *= mix(vec3(1.0), texture(u_lwb, v_uv).rgb, u_lwbAmt);
  vec3 c0 = c;
  float I = sqrt(dot(c, LUMA));
  float tt = 1.0;
  if (u_dehaze > 0.5) {
    vec2 ab = texture(u_coef, v_uv).rg;
    float t = clamp(ab.x * I + ab.y, 0.0, 1.0);
    tt = t;
    float m = 1.0 - smoothstep(u_t0, u_t0 + 0.25, t);   // 1 = open water
    float div = mix(max(t, u_t0), 1.0, m);
    float veil = clamp((1.0 - t) / (1.0 - u_t0), 0.0, 1.0);
    vec3 j = max((c - u_A) / div * (1.0 + u_k * ((1.0 - t) * (1.0 - m))) + u_A + (u_Aout - u_A) * veil, 0.0);
    // luminance from the dehazed result, chroma mostly from the balanced one
    float yr = (dot(j, LUMA) + 1e-4) / (dot(c, LUMA) + 1e-4);
    c = mix(c * yr, j, u_dehazeChroma);
  }
  // Sea-thru 深度感知 — mirrors seaThruGL() in auto.ts
  if (u_stAmt > 0.001) {
    vec4 ax = texture(u_aux, v_uv);
    float td = clamp(ax.r * I + ax.g, 0.0, 1.0);
    float md = 1.0 - smoothstep(u_t0, u_t0 + 0.25, td);
    float z = -log(clamp(td, 0.02, 1.0));
    vec3 J = max(c0 - u_stB * (1.0 - exp(-u_stb * z)), 0.0) * min(vec3(SEATHRU_MAX), exp(u_stBeta * z));
    c = mix(c, mix(J, c0, md), u_stAmt);
  }
  c *= u_post;
  vec3 ce = c * u_exp;
  vec3 e = toSrgb(mix(ce, shoulder(ce), u_shoulder));
  if (u_labAmt > 0.001) e = labShift(e, tt);
  float L = dot(e, LUMA);
  // 多分支融合 — mirrors fuseL() in pipeline.ts
  if (u_fuse > 0.001) {
    vec2 fw = texture(u_aux, v_uv).ba;
    float he = claheMap(L, v_uv) * u_claheK;
    float f = (1.0 - fw.x - fw.y) * L + fw.x * pow(max(L, 0.0), FUSE_GAMMA) + fw.y * he;
    float L1 = mix(L, f, u_fuse);
    e *= (L1 + 1e-4) / (L + 1e-4);
    L = L1;
  }
  float L2 = L;
  if (u_claheMix > 0.0) {
    L2 = mix(L, claheMap(L, v_uv) * u_claheK, u_claheMix);
    e *= (L2 + 1e-4) / (L + 1e-4);
  }
  o = vec4(e, L2);
}
`;

/** Pass 2/3 — separable Gaussian of the luminance (alpha, then red). */
export const BLUR_FS = `${COMMON}
uniform sampler2D u_in;
uniform vec2 u_dir;          // texel step
uniform float u_w[9];        // weights for offsets 0..8
uniform int u_taps;
uniform int u_fromAlpha;
float lum(vec2 uv) {
  vec4 v = texture(u_in, uv);
  return u_fromAlpha == 1 ? v.a : v.r;
}
void main() {
  float s = lum(v_uv) * u_w[0];
  for (int i = 1; i < 9; i++) {
    if (i >= u_taps) break;
    vec2 d = u_dir * float(i);
    s += (lum(v_uv + d) + lum(v_uv - d)) * u_w[i];
  }
  o = vec4(s, 0.0, 0.0, 1.0);
}
`;

/**
 * Pass 4 — detail, clarity, de-cast, tone curve, colour, dither, compare.
 * Renders to the canvas (flipY = 1) or to an analysis target (flipY = 0).
 */
export const FINAL_FS = `${COMMON}
uniform sampler2D u_graded, u_blur, u_src, u_curve;
uniform float u_flipY;
uniform vec2 u_size;
uniform float u_sharpen, u_thr, u_denoise, u_clarity, u_clarityLod;
uniform vec3 u_gain;
uniform float u_deCast;
uniform float u_sat, u_vib;
uniform float u_chroma, u_warm;   // 豐富色彩: OKLab chroma gain, warm-hue extra
uniform sampler2D u_rays;         // 光束: radial blur of the bright part toward the source
uniform float u_beams, u_beamWarm, u_rayGain;
uniform vec2 u_surfA, u_surfB;    // 水面高光: graduated filter A (full) → B (none)
uniform float u_surfHL, u_surfTone, u_surfWarm;
uniform float u_hiThr, u_hiAmt;   // 光線去洋紅: sunlight above u_hiThr loses magenta
uniform sampler2D u_look;         // user curves: 256×1, rgb = master(channel(x))
uniform float u_lookOn, u_hslOn;
uniform float u_hslC[8], u_hslH[8], u_hslS[8], u_hslL[8];
uniform int u_mode;          // 0 result, 1 split, 2 original
uniform float u_split;
uniform int u_clip;          // highlight / shadow clipping overlay
uniform float u_seed;

// mirrors boostChroma() in color.ts
float boostChroma(float C, float h) {
  float warmW = smoothstep(-0.3, 0.2, h) * (1.0 - smoothstep(1.1, 1.5, h));
  float g = u_chroma * (1.0 + u_warm * warmW);
  float x = C * (1.0 + (g - 1.0) * smoothstep(0.012, 0.05, C));
  const float knee = 0.12, cmax = 0.27;
  float soft = x <= knee ? x : knee + (cmax - knee) * tanh((x - knee) / (cmax - knee));
  return max(C, soft);
}

// mirrors gamutFit() in auto.ts: give back only the added chroma if needed
vec3 gamutFit(vec3 lab, float k) {
  vec3 c = fromOklab(vec3(lab.x, lab.yz * k));
  if (min(c.r, min(c.g, c.b)) >= -1e-4 && max(c.r, max(c.g, c.b)) <= 1.0001) return c;
  float lo = 1.0, hi = k;
  for (int i = 0; i < 5; i++) {
    float mid = 0.5 * (lo + hi);
    vec3 m = fromOklab(vec3(lab.x, lab.yz * mid));
    if (min(m.r, min(m.g, m.b)) >= -1e-4 && max(m.r, max(m.g, m.b)) <= 1.0001) lo = mid;
    else hi = mid;
  }
  return clamp(fromOklab(vec3(lab.x, lab.yz * lo)), 0.0, 1.0);
}

// mirrors fitLab() in look.ts: shrink chroma until the colour is in sRGB
vec3 fitLab(vec3 lab) {
  vec3 c = fromOklab(lab);
  if (min(c.r, min(c.g, c.b)) >= -1e-4 && max(c.r, max(c.g, c.b)) <= 1.0001) return c;
  float lo = 0.0, hi = 1.0;
  for (int i = 0; i < 6; i++) {
    float mid = 0.5 * (lo + hi);
    vec3 m = fromOklab(vec3(lab.x, lab.yz * mid));
    if (min(m.r, min(m.g, m.b)) >= -1e-4 && max(m.r, max(m.g, m.b)) <= 1.0001) lo = mid;
    else hi = mid;
  }
  return clamp(fromOklab(vec3(lab.x, lab.yz * lo)), 0.0, 1.0);
}

// mirrors applyHsl() in look.ts: 8 bands, partition-of-unity weights in OKLCh
vec3 applyHsl(vec3 e) {
  vec3 lab = oklab(toLin(e));
  float C = length(lab.yz);
  if (C < 1e-5) return e;
  const float TAU = 6.28318531;
  float h = atan(lab.z, lab.y);
  float hh = mod(h, TAU);
  int i0 = 7;
  for (int i = 0; i < 7; i++) {
    if (hh >= u_hslC[i] && hh < u_hslC[i + 1]) { i0 = i; break; }
  }
  float a, b;
  if (i0 < 7) { a = u_hslC[i0]; b = u_hslC[i0 + 1]; }
  else if (hh >= u_hslC[7]) { a = u_hslC[7]; b = u_hslC[0] + TAU; }
  else { a = u_hslC[7] - TAU; b = u_hslC[0]; }
  float t = smoothstep(0.0, 1.0, (hh - a) / (b - a));
  int i1 = i0 == 7 ? 0 : i0 + 1;
  float dh = (1.0 - t) * u_hslH[i0] + t * u_hslH[i1];
  float ds = (1.0 - t) * u_hslS[i0] + t * u_hslS[i1];
  float dl = (1.0 - t) * u_hslL[i0] + t * u_hslL[i1];
  float colourful = smoothstep(0.003, 0.02, C);
  float h2 = h + dh / 100.0 * 0.52359878 * colourful;
  float C2 = C * max(0.0, 1.0 + ds / 100.0 * colourful);
  float L2 = clamp(lab.x + dl / 100.0 * 0.2 * colourful, 0.0, 1.0);
  return toSrgb(fitLab(vec3(L2, C2 * cos(h2), C2 * sin(h2))));
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32 + u_seed);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vec2(v_uv.x, u_flipY > 0.5 ? 1.0 - v_uv.y : v_uv.y);
  vec3 src = texture(u_src, srcUV(uv)).rgb;
  if (u_mode == 2 || (u_mode == 1 && uv.x < u_split)) {
    o = vec4(src, 1.0);
  } else {
    vec4 g = texture(u_graded, uv);
    vec3 e = g.rgb;
    float L = g.a;
    // detail: amplify above threshold (sharpen), flatten below (denoise)
    float Lb = texture(u_blur, uv).r;
    float d = L - Lb;
    float edge = smoothstep(u_thr * 0.5, u_thr * 1.5 + 1e-5, abs(d));
    float Ld = Lb + d * mix(1.0 - u_denoise, 1.0 + u_sharpen, edge);
    // clarity: mid-frequency contrast from a coarse mip of the luminance
    vec2 px = 1.0 / u_size;
    float big = 0.25 * (textureLod(u_graded, uv + px * vec2(3.0, 3.0), u_clarityLod).a
                      + textureLod(u_graded, uv + px * vec2(-3.0, 3.0), u_clarityLod).a
                      + textureLod(u_graded, uv + px * vec2(3.0, -3.0), u_clarityLod).a
                      + textureLod(u_graded, uv + px * vec2(-3.0, -3.0), u_clarityLod).a);
    Ld += u_clarity * (Ld - big) * 4.0 * clamp(Ld, 0.0, 1.0) * (1.0 - clamp(Ld, 0.0, 1.0));
    e *= (max(Ld, 0.0) + 0.02) / (L + 0.02);
    // mid-tone weighted de-cast
    float l0 = dot(e, LUMA);
    float wgt = l0 < 0.3 ? pow(max(l0, 0.0) / 0.3, 1.5)
              : (l0 > 0.8 ? 0.5 + 0.5 * max(0.0, 1.0 - (l0 - 0.8) / 0.2) : 1.0);
    e *= 1.0 + (u_gain - 1.0) * u_deCast * wgt;
    // master curve on luminance
    float l1 = dot(e, LUMA);
    float lc = texture(u_curve, vec2((clamp(l1, 0.0, 1.0) * 1023.0 + 0.5) / 1024.0, 0.5)).r;
    e *= (lc + 1e-3) / (l1 + 1e-3);
    // vibrance favours muted colours; saturation is global
    float l2 = dot(e, LUMA);
    float sat = max(e.r, max(e.g, e.b)) - min(e.r, min(e.g, e.b));
    e = l2 + (e - l2) * (u_sat + u_vib * (1.0 - smoothstep(0.0, 0.6, sat)));
    e = clamp(e, 0.0, 1.0);
    // 豐富色彩: hue-preserving chroma gain in OKLab, measured per frame
    if (u_chroma > 1.0001 || u_warm > 0.0001) {
      vec3 lab = oklab(toLin(e));
      float C = length(lab.yz);
      if (C > 1e-5) {
        e = toSrgb(gamutFit(lab, boostChroma(C, atan(lab.z, lab.y)) / C));
      }
    }
    // 光束: add light along the beams (screen) or take the beam structure away
    if (abs(u_beams) > 0.001) {
      float r = clamp(texture(u_rays, uv).r * u_rayGain, 0.0, 1.0);
      if (u_beams > 0.0) {
        vec3 tint = vec3(1.0 + 0.25 * u_beamWarm, 1.0, 1.0 - 0.25 * u_beamWarm);
        e = 1.0 - (1.0 - e) * (1.0 - clamp(u_beams * 1.5 * r * tint, 0.0, 1.0));
      } else {
        float Lb = dot(e, LUMA);
        float Lr = max(Lb + u_beams * 1.2 * r, Lb * 0.55);
        e *= (Lr + 1e-3) / (Lb + 1e-3);
      }
    }
    // 水面高光: graduated filter from the surface — mirrors applySurface() in light.ts
    if (u_surfHL > 0.001 || abs(u_surfTone) > 0.001 || abs(u_surfWarm) > 0.001) {
      vec2 ab = u_surfB - u_surfA;
      float m = clamp(dot(uv - u_surfA, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
      float wgt = 1.0 - smoothstep(0.0, 1.0, m);
      if (wgt > 0.0) {
        float Ls = dot(e, LUMA);
        float a = u_surfHL * wgt;
        float Lh = Ls > 0.55 ? 0.55 + (Ls - 0.55) * (1.0 - 0.75 * a) : Ls;
        Lh *= exp2(u_surfTone * 0.8 * wgt);
        e *= (Lh + 1e-3) / (Ls + 1e-3);
        e *= vec3(1.0 + 0.12 * u_surfWarm * wgt, 1.0, 1.0 - 0.12 * u_surfWarm * wgt);
        e = clamp(e, 0.0, 1.0);
      }
    }
    // 光線去洋紅 — mirrors neutralLight() in light.ts
    if (u_hiAmt > 0.001) {
      float wL = smoothstep(u_hiThr - 0.12, u_hiThr, dot(e, LUMA));
      if (wL > 0.0) {
        vec3 lab = oklab(toLin(e));
        float hd = degrees(atan(lab.z, lab.y));
        float dh = abs(mod(hd - 320.0 + 540.0, 360.0) - 180.0);
        float k = 1.0 - u_hiAmt * wL * (1.0 - smoothstep(30.0, 55.0, dh)) * (1.0 - smoothstep(0.05, 0.09, length(lab.yz)));
        if (k < 1.0) e = clamp(toSrgb(fromOklab(vec3(lab.x, lab.yz * k))), 0.0, 1.0);
      }
    }
    // user look: curves (per channel, then RGB master), then HSL mixer
    if (u_lookOn > 0.5) {
      e = vec3(texture(u_look, vec2((e.r * 255.0 + 0.5) / 256.0, 0.5)).r,
               texture(u_look, vec2((e.g * 255.0 + 0.5) / 256.0, 0.5)).g,
               texture(u_look, vec2((e.b * 255.0 + 0.5) / 256.0, 0.5)).b);
    }
    if (u_hslOn > 0.5) e = applyHsl(e);
    if (u_clip == 1) {
      if (max(e.r, max(e.g, e.b)) > 0.996) e = vec3(1.0, 0.1, 0.3);
      else if (max(e.r, max(e.g, e.b)) < 0.004) e = vec3(0.1, 0.4, 1.0);
    }
    // ±0.5 LSB dither: the pipeline is float end to end, so hide the final
    // 8-bit quantisation instead of letting smooth water gradients band
    e += (hash(uv * u_size) - 0.5) / 255.0;
    o = vec4(e, 1.0);
  }
  if (u_mode == 1 && abs(uv.x - u_split) * u_size.x < 1.0) o = vec4(1.0, 1.0, 1.0, 1.0);
}
`;

/**
 * 畫質修復 pre-pass (at processing resolution, output orientation):
 * luminance gets a 5×5 bilateral (edges kept, grain and 8×8 compression
 * steps smoothed); chroma gets a wider 5×5 at 2 px spacing with the same
 * luminance edge-stop, which is what removes colour blotches and chroma noise
 * without bleeding colour across edges.
 */
export const PRE_FS = `${COMMON}
uniform sampler2D u_src;
uniform vec2 u_px;      // one output pixel, in uv
uniform float u_sigL;   // luminance range sigma
uniform float u_amt;    // blend with the original
void main() {
  vec3 c0 = texture(u_src, srcUV(v_uv)).rgb;
  float y0 = dot(c0, LUMA);
  float sy = 0.0, wy = 0.0, wc = 0.0;
  vec3 sc = vec3(0.0);
  float k1 = 1.0 / (2.0 * u_sigL * u_sigL), k2 = k1 / 4.0;
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      vec2 off = vec2(float(dx), float(dy));
      float sp = exp(-dot(off, off) / 4.5);
      vec3 c1 = texture(u_src, srcUV(v_uv + off * u_px)).rgb;
      float y1 = dot(c1, LUMA);
      float w1 = sp * exp(-(y1 - y0) * (y1 - y0) * k1);
      sy += y1 * w1; wy += w1;
      vec3 c2 = texture(u_src, srcUV(v_uv + off * 2.0 * u_px)).rgb;
      float y2 = dot(c2, LUMA);
      float w2 = sp * exp(-(y2 - y0) * (y2 - y0) * k2);
      sc += (c2 - y2) * w2; wc += w2;
    }
  }
  vec3 outc = clamp(sy / wy + sc / wc, 0.0, 1.0);
  o = vec4(mix(c0, outc, u_amt), 1.0);
}
`;

/**
 * 光束 rays (half resolution): average the light above a threshold along the
 * line from each pixel toward the source, with decay — a radial blur of the
 * bright part, i.e. the beams' own structure, extended toward the light.
 */
export const RAYS_FS = `${COMMON}
uniform sampler2D u_graded;   // alpha = post-CLAHE luminance, output orientation
uniform vec2 u_sun;           // source, uv (may lie outside the frame)
uniform float u_thr, u_len;
void main() {
  vec2 d = u_sun - v_uv;
  float acc = 0.0, wsum = 0.0, decay = 1.0;
  for (int i = 0; i < 40; i++) {
    vec2 p = v_uv + d * (float(i) / 40.0) * u_len;
    if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) break;
    acc += max(texture(u_graded, p).a - u_thr, 0.0) * decay;
    wsum += decay;
    decay *= 0.95;
  }
  o = vec4(acc / max(wsum, 1e-3), 0.0, 0.0, 1.0);
}
`;
