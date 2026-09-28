/**
 * 🤖 AI 風格 — FUnIE-GAN in the browser (onnxruntime-web), loaded on demand.
 *
 * Nothing here runs until the button is pressed: the runtime (WebGPU or WASM
 * build, whichever this device can use) and the 14 MB float16 model are
 * fetched then, once. WebGPU is used only on a real adapter with 'shader-f16'
 * (the model's float16 weights); otherwise the single-threaded WASM build
 * (GitHub Pages cannot send the COOP/COEP headers threads need).
 *
 * `guide()` runs the network on a small copy of the frame and returns the
 * transform grid (ai.ts) the GRADE pass applies at full resolution.
 */
import { fitGuide, gridFor, netSize, type AiGuide } from './ai.ts';

type Ort = typeof import('onnxruntime-web');
type Session = import('onnxruntime-web').InferenceSession;
export type Backend = 'webgpu' | 'wasm';

/** Network input long edge per backend: WASM ~0.4 s at 256 px, WebGPU a few ms at 512. */
const EDGE: Record<Backend, number> = { webgpu: 512, wasm: 256 };

async function webgpuUsable(): Promise<boolean> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<any> } }).gpu;
  if (!gpu) return false;
  try {
    const a: any = await gpu.requestAdapter();
    const fallback = a?.isFallbackAdapter || a?.info?.isFallbackAdapter;
    return !!a && !fallback && a.features.has('shader-f16');
  } catch {
    return false;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Import the runtime by URL, retrying with a cache-busting query: a mobile
 * connection can drop one request, and Chromium keeps a failed import()
 * failed for the life of the page.
 */
async function importRuntime(url: string): Promise<Ort> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return (await import(/* @vite-ignore */ i ? `${url}?retry=${i}-${Date.now()}` : url)) as Ort;
    } catch (err) {
      last = err;
      await wait(600 * 2 ** i);
    }
  }
  throw last;
}

async function download(url: string, onProgress?: (f: number) => void): Promise<Uint8Array> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await downloadOnce(url, onProgress);
    } catch (err) {
      last = err;
      await wait(600 * 2 ** i);
    }
  }
  throw last;
}

async function downloadOnce(url: string, onProgress?: (f: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`模型下載失敗（${res.status}）`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) onProgress?.(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export class Funie {
  private ort: Ort;
  private session: Session;
  readonly backend: Backend;
  private constructor(ort: Ort, session: Session, backend: Backend) {
    this.ort = ort;
    this.session = session;
    this.backend = backend;
  }

  /**
   * Load runtime + model. `modelUrl` is public/models/funie-gan.fp16.onnx and
   * `ortDir` the ort/<version>/ folder (vite.config.ts), both under the app base.
   */
  static async create(modelUrl: string, ortDir: string, onProgress?: (f: number) => void): Promise<Funie> {
    const model = download(modelUrl, onProgress);
    model.catch(() => {}); // awaited below; don't report it unhandled while the runtime loads
    const setup = (ort: Ort) => {
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      return ort;
    };
    if (await webgpuUsable()) {
      try {
        const ort = setup(await importRuntime(`${ortDir}ort.webgpu.bundle.min.mjs`));
        const session = await ort.InferenceSession.create(await model, { executionProviders: ['webgpu'] });
        return new Funie(ort, session, 'webgpu');
      } catch (err) {
        console.warn('FUnIE-GAN: WebGPU unavailable, using WASM', err);
      }
    }
    const ort = setup(await importRuntime(`${ortDir}ort.wasm.bundle.min.mjs`));
    const session = await ort.InferenceSession.create(await model, { executionProviders: ['wasm'] });
    return new Funie(ort, session, 'wasm');
  }

  /** Network input size for a w × h frame. */
  inputSize(w: number, h: number): [number, number] {
    return netSize(w, h, EDGE[this.backend]);
  }

  /** Run the network on `rgba` (w × h, top row first, sizes from inputSize). */
  async enhance(rgba: Uint8Array, w: number, h: number): Promise<Uint8Array> {
    const n = w * h;
    const x = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      x[i] = (rgba[i * 4] / 255) * 2 - 1;
      x[n + i] = (rgba[i * 4 + 1] / 255) * 2 - 1;
      x[2 * n + i] = (rgba[i * 4 + 2] / 255) * 2 - 1;
    }
    const r = await this.session.run({ x: new this.ort.Tensor('float32', x, [1, 3, h, w]) });
    const y = r.y.data as Float32Array;
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      out[i * 4] = Math.round(Math.min(1, Math.max(0, (y[i] + 1) / 2)) * 255);
      out[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, (y[n + i] + 1) / 2)) * 255);
      out[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, (y[2 * n + i] + 1) / 2)) * 255);
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  /** Network + grid fit: the guide the GRADE pass applies at full resolution. */
  async guide(rgba: Uint8Array, w: number, h: number): Promise<AiGuide> {
    const out = await this.enhance(rgba, w, h);
    const [gx, gy] = gridFor(w, h);
    return fitGuide(rgba, out, w, h, gx, gy);
  }
}
