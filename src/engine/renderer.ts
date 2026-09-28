/**
 * WebGL2 renderer + the per-frame loop that ties it to the auto engine.
 *
 *   source ─upload+mips─▶ small (256 px) ─readPixels─▶ AutoEngine.step (CPU)
 *                                                          │ uniforms, maps, LUTs
 *   source ─────────────▶ GRADE (full res) ─mips─▶ BLUR H ─▶ BLUR V ─▶ FINAL ─▶ canvas
 *
 * Everything at full resolution happens on the GPU; the CPU only ever touches
 * the 256 px analysis frame, so cost barely grows with resolution.
 */
import { ANALYSIS_EDGE, AutoEngine, DEHAZE_CHROMA, T0, type FrameState, type StepOptions } from './auto.ts';
import { toGLMat3 } from './color.ts';
import { MAX_GAIN } from './physical.ts';
import { LWB_GRID } from './pipeline.ts';
import { destroy, program, target, texture, type GL, type Program, type Target, type Tex } from './gl.ts';
import { CLAHE_BINS, CURVE_N } from './luts.ts';
import { buildCurveLut, HSL_CENTERS, identityLook, isIdentityCurves, isIdentityHsl, LOOK_N, type Look } from './look.ts';
import { BLUR_FS, COPY_FS, FINAL_FS, GRADE_FS, PRE_FS, RAYS_FS } from './shaders.ts';

/** Quarter turns clockwise (0–3) and a horizontal mirror, applied before everything else. */
export interface Orient {
  rot: 0 | 1 | 2 | 3;
  flip: boolean;
}
export const NO_ORIENT: Orient = { rot: 0, flip: false };
/** Output size of a w×h source after `o`. */
export const orientedSize = (w: number, h: number, o: Orient): [number, number] => (o.rot % 2 ? [h, w] : [w, h]);

export interface View {
  mode: 0 | 1 | 2; // result | split | original
  split: number;
  clip: boolean;
}
export const RESULT_VIEW: View = { mode: 0, split: 0.5, clip: false };

type Canvas = HTMLCanvasElement | OffscreenCanvas;

export class Renderer {
  readonly gl: GL;
  readonly canvas: Canvas;
  readonly floatTargets: boolean;
  readonly maxTexture: number;
  private progs: { copy: Program; grade: Program; blur: Program; final: Program; pre: Program; rays: Program };
  private vao: WebGLVertexArrayObject;
  private src: Tex | null = null;
  private small: Target | null = null;
  private scope: Target | null = null;
  private graded: Target | null = null;
  private blurA: Target | null = null;
  private blurB: Target | null = null;
  private coef: Tex | null = null;
  /** 自動化流程 maps: analysis-res aux (depth coef, fusion weights), local WB grid. */
  private aux: Tex | null = null;
  private lwb: Tex | null = null;
  /** 🤖 AI 風格 transform grid (ai.ts): 3 RGBA32F texels per tile. */
  private ai: Tex | null = null;
  private aiKey: Float32Array | null = null;
  private aiReadT: Target | null = null;
  private lut: Tex | null = null;
  private curve: Tex;
  private pre: Target | null = null;
  private rays: Target | null = null;
  private noise: Target | null = null;
  private lookTex: Tex;
  private look: Look = identityLook();
  private lookCurves = false;
  private lookHsl = false;
  private orient: Orient = NO_ORIENT;
  private smallKey = '';
  srcW = 0;
  srcH = 0;
  pw = 0;
  ph = 0;
  sw = 0;
  sh = 0;
  private seed = 0;

  constructor(canvas: Canvas, opts: { preserve?: boolean } = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: !!opts.preserve,
      powerPreference: 'high-performance',
    }) as GL | null;
    if (!gl) throw new Error('此瀏覽器不支援 WebGL2，無法即時運算');
    this.gl = gl;
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.progs = {
      copy: program(gl, COPY_FS),
      grade: program(gl, GRADE_FS),
      blur: program(gl, BLUR_FS),
      final: program(gl, FINAL_FS),
      pre: program(gl, PRE_FS),
      rays: program(gl, RAYS_FS),
    };
    this.vao = gl.createVertexArray()!;
    this.curve = texture(gl, CURVE_N, 1, gl.R16F, gl.RED, gl.FLOAT);
    this.lookTex = texture(gl, LOOK_N, 1, gl.RGBA16F, gl.RGBA, gl.FLOAT);
    this.setLook(this.look);
  }

  /** Rotation / flip. Takes effect on the next `frame` (analysis targets follow). */
  setOrient(o: Orient) {
    this.orient = { rot: o.rot, flip: o.flip };
  }
  get outW() {
    return orientedSize(this.srcW, this.srcH, this.orient)[0];
  }
  get outH() {
    return orientedSize(this.srcW, this.srcH, this.orient)[1];
  }

  /** User curves + HSL. Cheap: only the final pass reads them. */
  setLook(look: Look) {
    const gl = this.gl;
    this.look = look;
    this.lookCurves = !isIdentityCurves(look.curves);
    this.lookHsl = !isIdentityHsl(look.hsl);
    gl.bindTexture(gl.TEXTURE_2D, this.lookTex.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, LOOK_N, 1, 0, gl.RGBA, gl.FLOAT, buildCurveLut(look.curves));
  }

  /** Analysis-size targets follow the *oriented* frame. */
  private ensureSmall() {
    const gl = this.gl;
    const w = this.outW,
      h = this.outH;
    const key = `${w}x${h}`;
    if (key === this.smallKey) return;
    this.smallKey = key;
    const s = Math.min(1, ANALYSIS_EDGE / Math.max(w, h));
    this.sw = Math.max(8, Math.round(w * s));
    this.sh = Math.max(8, Math.round(h * s));
    destroy(gl, this.small);
    destroy(gl, this.scope);
    this.small = target(gl, texture(gl, this.sw, this.sh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE));
    this.scope = target(gl, texture(gl, this.sw, this.sh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE));
  }

  /** Upload a new source frame (image, video element, VideoFrame, canvas). */
  upload(source: TexImageSource, w: number, h: number) {
    const gl = this.gl;
    if (!this.src || this.src.w !== w || this.src.h !== h) {
      destroy(gl, this.src);
      this.src = texture(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, { mips: true });
      this.srcW = w;
      this.srcH = h;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.src.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** Processing (and canvas) resolution. */
  resize(pw: number, ph: number) {
    if (pw === this.pw && ph === this.ph) return;
    const gl = this.gl;
    this.pw = pw;
    this.ph = ph;
    this.canvas.width = pw;
    this.canvas.height = ph;
    for (const t of [this.graded, this.blurA, this.blurB, this.pre, this.rays]) destroy(gl, t);
    const f = this.floatTargets;
    const rw = Math.max(2, pw >> 1),
      rh = Math.max(2, ph >> 1);
    this.rays = target(gl, texture(gl, rw, rh, f ? gl.R16F : gl.RGBA8, f ? gl.RED : gl.RGBA, f ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE));
    this.pre = target(gl, texture(gl, pw, ph, f ? gl.RGBA16F : gl.RGBA8, gl.RGBA, f ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE));
    this.graded = target(
      gl,
      texture(gl, pw, ph, f ? gl.RGBA16F : gl.RGBA8, gl.RGBA, f ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, { mips: true }),
    );
    const blur = () =>
      target(gl, texture(gl, pw, ph, f ? gl.R16F : gl.RGBA8, f ? gl.RED : gl.RGBA, f ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE));
    this.blurA = blur();
    this.blurB = blur();
  }

  /** Render the source into the 256 px analysis target and read it back. */
  readSmall(): Uint8Array {
    const gl = this.gl;
    this.ensureSmall();
    const out = new Uint8Array(this.sw * this.sh * 4);
    this.pass(this.progs.copy, this.small!, () => {
      this.bind(0, this.src!, 'u_src', this.progs.copy);
      this.gl.uniform4f(this.progs.copy.u.u_crop, 0, 0, 1, 1);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.small!.fb);
    gl.readPixels(0, 0, this.sw, this.sh, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /**
   * The oriented source at w × h (the 🤖 AI 風格 network input), top row first.
   * Downscaling reads the source mips, like the analysis frame.
   */
  readAt(w: number, h: number): Uint8Array {
    const gl = this.gl;
    if (!this.aiReadT || this.aiReadT.w !== w || this.aiReadT.h !== h) {
      destroy(gl, this.aiReadT);
      this.aiReadT = target(gl, texture(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE));
    }
    this.pass(this.progs.copy, this.aiReadT, () => {
      this.bind(0, this.src!, 'u_src', this.progs.copy);
      gl.uniform4f(this.progs.copy.u.u_crop, 0, 0, 1, 1);
    });
    const out = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.aiReadT.fb);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /**
   * Noise probe: a centred crop at *processing* scale (the scale the grade and
   * 畫質修復 passes see), so the engine can measure grain the 192 px analysis
   * frame has averaged away.
   */
  readNoise(): { rgba: Uint8Array; w: number; h: number } {
    const gl = this.gl;
    const cw = Math.min(256, this.pw),
      ch = Math.min(256, this.ph);
    if (!this.noise || this.noise.w !== cw || this.noise.h !== ch) {
      destroy(gl, this.noise);
      this.noise = target(gl, texture(gl, cw, ch, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE));
    }
    const zw = cw / this.pw,
      zh = ch / this.ph;
    this.pass(this.progs.copy, this.noise, () => {
      this.bind(0, this.src!, 'u_src', this.progs.copy);
      gl.uniform4f(this.progs.copy.u.u_crop, 0.5 - zw / 2, 0.5 - zh / 2, zw, zh);
    });
    const out = new Uint8Array(cw * ch * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.noise.fb);
    gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { rgba: out, w: cw, h: ch };
  }

  /** Upload the per-frame maps and LUTs computed by the engine. */
  private uploadState(s: FrameState) {
    const gl = this.gl;
    if (!this.coef || this.coef.w !== s.coefW || this.coef.h !== s.coefH) {
      destroy(gl, this.coef);
      this.coef = texture(gl, s.coefW, s.coefH, gl.RGBA16F, gl.RGBA, gl.FLOAT);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.coef.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, s.coefW, s.coefH, 0, gl.RGBA, gl.FLOAT, s.coef);
    const rows = s.claheTiles * s.claheTiles;
    if (!this.lut || this.lut.h !== rows) {
      destroy(gl, this.lut);
      this.lut = texture(gl, CLAHE_BINS, rows, gl.R16F, gl.RED, gl.FLOAT);
    }
    if (s.clahe) {
      gl.bindTexture(gl.TEXTURE_2D, this.lut.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, CLAHE_BINS, rows, 0, gl.RED, gl.FLOAT, s.clahe);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.curve.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, CURVE_N, 1, 0, gl.RED, gl.FLOAT, s.curve);
    if (!this.aux || this.aux.w !== s.coefW || this.aux.h !== s.coefH) {
      destroy(gl, this.aux);
      this.aux = texture(gl, s.coefW, s.coefH, gl.RGBA16F, gl.RGBA, gl.FLOAT);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.aux.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, s.coefW, s.coefH, 0, gl.RGBA, gl.FLOAT, s.aux);
    if (!this.lwb) this.lwb = texture(gl, LWB_GRID, LWB_GRID, gl.RGBA16F, gl.RGBA, gl.FLOAT);
    const g4 = new Float32Array(LWB_GRID * LWB_GRID * 4);
    for (let k = 0; k < LWB_GRID * LWB_GRID; k++) {
      g4[k * 4] = s.lwb.gains[k * 3];
      g4[k * 4 + 1] = s.lwb.gains[k * 3 + 1];
      g4[k * 4 + 2] = s.lwb.gains[k * 3 + 2];
      g4[k * 4 + 3] = 1;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.lwb.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, LWB_GRID, LWB_GRID, 0, gl.RGBA, gl.FLOAT, g4);
    const ai = s.ai.guide;
    if (ai && ai.m !== this.aiKey) {
      // float32: the offsets and cross terms need more than half precision; texelFetch only
      if (!this.ai || this.ai.w !== ai.gx * 3 || this.ai.h !== ai.gy) {
        destroy(gl, this.ai);
        this.ai = texture(gl, ai.gx * 3, ai.gy, gl.RGBA32F, gl.RGBA, gl.FLOAT, { filter: gl.NEAREST });
      }
      gl.bindTexture(gl.TEXTURE_2D, this.ai.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, ai.gx * 3, ai.gy, 0, gl.RGBA, gl.FLOAT, ai.m);
      this.aiKey = ai.m;
    }
    if (!this.ai) this.ai = texture(gl, 3, 1, gl.RGBA32F, gl.RGBA, gl.FLOAT, { filter: gl.NEAREST });
  }

  /** Full-resolution grade + blur passes. Call when the state or source changed. */
  grade(s: FrameState) {
    const gl = this.gl;
    this.uploadState(s);
    const restore = s.restore > 0.001;
    const ai = s.ai.guide && s.ai.amount > 0.001 ? s.ai.guide : null;
    if (restore) {
      const pp = this.progs.pre;
      this.pass(pp, this.pre!, () => {
        this.bind(0, this.src!, 'u_src', pp);
        gl.uniform2f(pp.u.u_px, 1 / this.pw, 1 / this.ph);
        gl.uniform1f(pp.u.u_sigL, 0.012 + 0.06 * s.restore);
        gl.uniform1f(pp.u.u_amt, Math.min(1, s.restore * 2));
      });
    }
    const g = this.progs.grade;
    this.pass(g, this.graded!, () => {
      this.bind(0, this.src!, 'u_src', g);
      this.bind(3, this.pre!, 'u_pre', g);
      gl.uniform1f(g.u.u_direct, restore ? 1 : 0);
      gl.uniform1f(g.u.u_shoulder, s.shoulder);
      // imported 全自動 profile (colour front-end); inert when its amount is 0
      if (s.mixAmt > 0.0001) {
        gl.uniformMatrix3fv(g.u.u_mixMat, false, toGLMat3(s.mixMat));
        gl.uniform3fv(g.u.u_mixOff, s.mixOff);
      }
      gl.uniform1f(g.u.u_mixAmt, s.mixAmt);
      if (s.pullAmt > 0.0001) gl.uniform4fv(g.u.u_pull, s.pull);
      gl.uniform1f(g.u.u_pullAmt, s.pullAmt);
      if (s.physAmt > 0.0001) {
        gl.uniform3fv(g.u.u_physA, s.physA);
        gl.uniform1f(g.u.u_physBack, s.physBack);
      }
      gl.uniform1f(g.u.u_physAmt, s.physAmt);
      gl.uniform1f(g.u.u_physMaxGain, MAX_GAIN);
      this.bind(1, this.coef!, 'u_coef', g);
      this.bind(2, this.lut!, 'u_lut', g);
      gl.uniform1f(g.u.u_aR, s.aR);
      gl.uniform1f(g.u.u_aB, s.aB);
      gl.uniform1f(g.u.u_dR, s.dR);
      gl.uniform1f(g.u.u_dB, s.dB);
      gl.uniformMatrix3fv(g.u.u_wb, false, toGLMat3(s.wb));
      gl.uniform3fv(g.u.u_A, s.A);
      gl.uniform3fv(g.u.u_Aout, s.Aout);
      gl.uniform3fv(g.u.u_post, s.post);
      gl.uniform1f(g.u.u_dehazeChroma, DEHAZE_CHROMA);
      gl.uniform3fv(g.u.u_k, s.k);
      gl.uniform1f(g.u.u_t0, T0);
      gl.uniform1f(g.u.u_dehaze, s.dehazeOn ? 1 : 0);
      gl.uniform1f(g.u.u_exp, s.expMul);
      gl.uniform1f(g.u.u_tiles, s.claheTiles);
      gl.uniform1f(g.u.u_claheMix, s.clahe ? s.claheMix : 0);
      gl.uniform1f(g.u.u_claheK, s.claheK);
      // 自動化流程
      this.bind(6, this.aux!, 'u_aux', g);
      this.bind(7, this.lwb!, 'u_lwb', g);
      gl.uniform1f(g.u.u_lwbAmt, s.lwb.amount);
      gl.uniform1f(g.u.u_stAmt, s.seathru.amount);
      gl.uniform3fv(g.u.u_stB, s.seathru.B);
      gl.uniform3fv(g.u.u_stb, s.seathru.b);
      gl.uniform3fv(g.u.u_stBeta, s.seathru.beta);
      gl.uniform2f(g.u.u_labShift, s.lab.shift[0], s.lab.shift[1]);
      gl.uniform1f(g.u.u_labAmt, s.lab.amount);
      gl.uniform1f(g.u.u_fuse, s.clahe ? s.fusion : 0);
      // 🤖 AI 風格
      this.bind(8, this.ai!, 'u_ai', g);
      gl.uniform2f(g.u.u_aiGrid, ai ? ai.gx : 1, ai ? ai.gy : 1);
      gl.uniform1f(g.u.u_aiAmt, ai ? s.ai.amount : 0);
    });
    gl.bindTexture(gl.TEXTURE_2D, this.graded!.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // separable Gaussian of luminance for the detail band
    const sigma = Math.max(0.3, s.sharpenRadius);
    const taps = Math.min(9, Math.ceil(2.5 * sigma) + 1);
    const w = new Float32Array(9);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      w[i] = Math.exp((-i * i) / (2 * sigma * sigma));
      sum += i === 0 ? w[i] : 2 * w[i];
    }
    for (let i = 0; i < taps; i++) w[i] /= sum;
    const b = this.progs.blur;
    const blur = (src: Tex, dst: Target, dir: [number, number], fromAlpha: boolean) =>
      this.pass(b, dst, () => {
        this.bind(0, src, 'u_in', b);
        gl.uniform2f(b.u.u_dir, dir[0], dir[1]);
        gl.uniform1fv(b.u.u_w, w);
        gl.uniform1i(b.u.u_taps, taps);
        gl.uniform1i(b.u.u_fromAlpha, fromAlpha ? 1 : 0);
      });
    blur(this.graded!, this.blurA!, [1 / this.pw, 0], true);
    blur(this.blurA!, this.blurB!, [0, 1 / this.ph], false);

    // 光束: only when the control is in use
    if (Math.abs(s.beams.amount) > 0.001) {
      const rp = this.progs.rays;
      this.pass(rp, this.rays!, () => {
        this.bind(0, this.graded!, 'u_graded', rp);
        gl.uniform2f(rp.u.u_sun, s.beams.x, s.beams.y);
        gl.uniform1f(rp.u.u_thr, s.beams.thr);
        gl.uniform1f(rp.u.u_len, 0.15 + 0.85 * s.beams.length);
      });
    }
  }

  /** Detail/tone/colour/compare pass to the canvas, or into the scope target. */
  finish(s: FrameState, view: View, toScope = false) {
    const gl = this.gl;
    const f = this.progs.final;
    const dst = toScope ? this.scope! : null;
    this.pass(f, dst, () => {
      this.bind(0, this.graded!, 'u_graded', f);
      this.bind(1, this.blurB!, 'u_blur', f);
      this.bind(2, this.src!, 'u_src', f);
      this.bind(3, this.curve, 'u_curve', f);
      gl.uniform1f(f.u.u_flipY, toScope ? 0 : 1);
      gl.uniform2f(f.u.u_size, toScope ? this.sw : this.pw, toScope ? this.sh : this.ph);
      gl.uniform1f(f.u.u_sharpen, s.sharpen);
      gl.uniform1f(f.u.u_thr, s.threshold);
      gl.uniform1f(f.u.u_denoise, s.denoise);
      gl.uniform1f(f.u.u_clarity, s.clarity);
      gl.uniform1f(
        f.u.u_clarityLod,
        Math.max(0, Math.min(Math.log2(Math.max(this.pw, this.ph) / 48), Math.log2(Math.max(this.pw, this.ph)))),
      );
      gl.uniform3fv(f.u.u_gain, s.gain);
      gl.uniform1f(f.u.u_deCast, s.deCast);
      gl.uniform1f(f.u.u_sat, s.saturation);
      gl.uniform1f(f.u.u_vib, s.vibrance);
      gl.uniform1f(f.u.u_chroma, s.chromaGain);
      gl.uniform1f(f.u.u_warm, s.warmGain);
      this.bind(4, this.lookTex, 'u_look', f);
      this.bind(5, this.rays!, 'u_rays', f);
      gl.uniform1f(f.u.u_beams, s.beams.amount);
      gl.uniform1f(f.u.u_beamWarm, s.beams.warm);
      gl.uniform1f(f.u.u_rayGain, 1 / Math.max(0.08, 1 - s.beams.thr));
      gl.uniform2f(f.u.u_surfA, s.surface.ax, s.surface.ay);
      gl.uniform2f(f.u.u_surfB, s.surface.bx, s.surface.by);
      gl.uniform1f(f.u.u_surfHL, s.surface.hl);
      gl.uniform1f(f.u.u_surfTone, s.surface.tone);
      gl.uniform1f(f.u.u_surfWarm, s.surface.warm);
      gl.uniform1f(f.u.u_hiThr, s.neutral.thr);
      gl.uniform1f(f.u.u_hiAmt, s.neutral.amount);
      gl.uniform1f(f.u.u_lookOn, this.lookCurves ? 1 : 0);
      gl.uniform1f(f.u.u_hslOn, this.lookHsl ? 1 : 0);
      if (this.lookHsl) {
        gl.uniform1fv(f.u.u_hslC, HSL_CENTERS);
        gl.uniform1fv(f.u.u_hslH, this.look.hsl.h);
        gl.uniform1fv(f.u.u_hslS, this.look.hsl.s);
        gl.uniform1fv(f.u.u_hslL, this.look.hsl.l);
      }
      gl.uniform1i(f.u.u_mode, toScope ? 0 : view.mode);
      gl.uniform1f(f.u.u_split, view.split);
      gl.uniform1i(f.u.u_clip, !toScope && view.clip ? 1 : 0);
      gl.uniform1f(f.u.u_seed, (this.seed = (this.seed + 0.618) % 1));
    });
  }

  /** Final image at analysis size (no split, no overlay) — histogram & tests. */
  readScope(s: FrameState): Uint8Array {
    const gl = this.gl;
    this.finish(s, RESULT_VIEW, true);
    const out = new Uint8Array(this.sw * this.sh * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scope!.fb);
    gl.readPixels(0, 0, this.sw, this.sh, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  private bind(unit: number, t: Tex, name: string, p: Program) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1i(p.u[name], unit);
  }

  private pass(p: Program, dst: Target | null, setup: () => void) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
    gl.viewport(0, 0, dst ? dst.w : this.pw, dst ? dst.h : this.ph);
    gl.useProgram(p.prog);
    gl.bindVertexArray(this.vao);
    if (p.u.u_rot) gl.uniform1i(p.u.u_rot, this.orient.rot);
    if (p.u.u_flipH) gl.uniform1f(p.u.u_flipH, this.orient.flip ? 1 : 0);
    setup();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    const gl = this.gl;
    for (const t of [this.src, this.small, this.scope, this.graded, this.blurA, this.blurB, this.coef, this.aux, this.lwb, this.ai, this.aiReadT, this.lut, this.curve, this.pre, this.lookTex, this.rays, this.noise])
      destroy(gl, t);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/**
 * One source → analysis → render loop. Used identically by the live preview,
 * photo export and video export, so what you see is what you export.
 */
export class Processor {
  readonly renderer: Renderer;
  readonly engine = new AutoEngine();
  state: FrameState | null = null;
  lastFrameMs = 0;
  private frames = 0;
  private noiseProbe: { rgba: Uint8Array; w: number; h: number } | null = null;

  constructor(canvas: Canvas, opts: { preserve?: boolean } = {}) {
    this.renderer = new Renderer(canvas, opts);
  }

  /** Upload a frame, analyse it, and render. `source` null re-uses the last upload. */
  frame(source: TexImageSource | null, w: number, h: number, step: StepOptions, view: View): FrameState {
    const t0 = performance.now();
    const r = this.renderer;
    if (source) r.upload(source, w, h);
    const small = r.readSmall();
    // grain changes slowly: probe every frame for stills, every 4th in video
    this.frames++;
    if (!(step.dt > 0) || step.snap || this.frames % 4 === 1) this.noiseProbe = r.readNoise();
    this.state = this.engine.step(small, r.sw, r.sh, { ...step, noise: this.noiseProbe ?? undefined });
    r.grade(this.state);
    r.finish(this.state, view);
    this.lastFrameMs = performance.now() - t0;
    return this.state;
  }

  setOrient(o: Orient) {
    this.renderer.setOrient(o);
  }
  setLook(l: Look) {
    this.renderer.setLook(l);
  }

  /** Re-draw with a new view (split, overlay) without re-grading. */
  redraw(view: View) {
    if (this.state) this.renderer.finish(this.state, view);
  }
}
