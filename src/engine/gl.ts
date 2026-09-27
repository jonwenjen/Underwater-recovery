/** Minimal WebGL2 plumbing: programs, textures, framebuffers. */

export type GL = WebGL2RenderingContext;

export interface Program {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

export const VERT = `#version 300 es
out vec2 v_uv;
void main() {
  // one oversized triangle covers the viewport; uv (0,0) is the image top-left
  // because textures are uploaded top row first and never flipped
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

function compile(gl: GL, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const numbered = src
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(3)} ${l}`)
      .join('\n');
    throw new Error(`shader compile failed: ${log}\n${numbered}`);
  }
  return s;
}

export function program(gl: GL, frag: string): Program {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
  const u: Program['u'] = {};
  const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(prog, i)!;
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(prog, info.name);
  }
  return { prog, u };
}

export interface Tex {
  tex: WebGLTexture;
  w: number;
  h: number;
  internal: number;
}

export function texture(
  gl: GL,
  w: number,
  h: number,
  internal: number,
  format: number,
  type: number,
  opts: { mips?: boolean; filter?: number } = {},
): Tex {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
  const f = opts.filter ?? gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.mips ? gl.LINEAR_MIPMAP_LINEAR : f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { tex, w, h, internal };
}

export interface Target extends Tex {
  fb: WebGLFramebuffer;
}

export function target(gl: GL, t: Tex): Target {
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incomplete: 0x${st.toString(16)}`);
  return { ...t, fb };
}

export function destroy(gl: GL, t: Tex | Target | null) {
  if (!t) return;
  gl.deleteTexture(t.tex);
  if ('fb' in t) gl.deleteFramebuffer(t.fb);
}
