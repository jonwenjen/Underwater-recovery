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
vec3 shoulder(vec3 x) {
  const float k = 0.8;
  return mix(x, k + (1.0 - k) * tanh((x - k) / (1.0 - k)), step(vec3(k), x));
}
`;

/** Downsample the source for analysis (mip-filtered) — plain copy. */
export const COPY_FS = `${COMMON}
uniform sampler2D u_src;
void main() { o = vec4(texture(u_src, v_uv).rgb, 1.0); }
`;

/**
 * Pass 1 — photometric recovery + CLAHE. Writes sRGB-encoded float colour in
 * rgb and the post-CLAHE luminance in alpha (for detail and clarity).
 */
export const GRADE_FS = `${COMMON}
uniform sampler2D u_src;
uniform sampler2D u_coef;   // guided-filter mean coefficients (a, b) at analysis res
uniform sampler2D u_lut;    // CLAHE maps: 256 wide, tiles*tiles rows
uniform float u_aR, u_aB, u_dR, u_dB;
uniform mat3 u_wb;
uniform vec3 u_A, u_Aout, u_k, u_post;
uniform float u_t0, u_dehaze, u_dehazeChroma;
uniform float u_exp;
uniform float u_tiles, u_claheMix, u_claheK;

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
  vec3 c = toLin(texture(u_src, v_uv).rgb);
  // Ancuti compensation: borrow signal from green where the scene has it
  c.r = min(1.0, c.r + u_aR * u_dR * (1.0 - c.r) * c.g);
  c.b = min(1.0, c.b + u_aB * u_dB * (1.0 - c.b) * c.g);
  // white balance (Bradford), then dehaze on the balanced frame
  c = max(u_wb * c, 0.0);
  if (u_dehaze > 0.5) {
    float I = sqrt(dot(c, LUMA));
    vec2 ab = texture(u_coef, v_uv).rg;
    float t = clamp(ab.x * I + ab.y, 0.0, 1.0);
    float m = 1.0 - smoothstep(u_t0, u_t0 + 0.25, t);   // 1 = open water
    float div = mix(max(t, u_t0), 1.0, m);
    float veil = clamp((1.0 - t) / (1.0 - u_t0), 0.0, 1.0);
    vec3 j = max((c - u_A) / div * (1.0 + u_k * ((1.0 - t) * (1.0 - m))) + u_A + (u_Aout - u_A) * veil, 0.0);
    // luminance from the dehazed result, chroma mostly from the balanced one
    float yr = (dot(j, LUMA) + 1e-4) / (dot(c, LUMA) + 1e-4);
    c = mix(c * yr, j, u_dehazeChroma);
  }
  c *= u_post;
  vec3 e = toSrgb(shoulder(c * u_exp));
  float L = dot(e, LUMA);
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
uniform int u_mode;          // 0 result, 1 split, 2 original
uniform float u_split;
uniform int u_clip;          // highlight / shadow clipping overlay
uniform float u_seed;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32 + u_seed);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vec2(v_uv.x, u_flipY > 0.5 ? 1.0 - v_uv.y : v_uv.y);
  vec3 src = texture(u_src, uv).rgb;
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
