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
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runtime files per backend, in ort/<version>/ (vite.config.ts). */
const RUNTIME: Record<Backend, { js: string; wasm: string }> = {
  wasm: { js: 'ort.wasm.bundle.min.mjs', wasm: 'ort-wasm-simd-threaded.wasm' },
  webgpu: { js: 'ort.webgpu.bundle.min.mjs', wasm: 'ort-wasm-simd-threaded.asyncify.wasm' },
};

/** Bytes received / expected (expected 0 while unknown, e.g. a compressed response). */
export type Progress = (got: number, total: number) => void;

/** fetch() with three tries and byte progress. */
async function download(url: string, onBytes?: Progress): Promise<Uint8Array> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await downloadOnce(url, onBytes);
    } catch (err) {
      last = err;
      await wait(600 * 2 ** i);
    }
  }
  throw new Error(`下載失敗 ${url.split('/').pop()}：${msg(last)}`);
}

async function downloadOnce(url: string, onBytes?: Progress): Promise<Uint8Array> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  // content-length is the compressed size when the server gzips
  const total = res.headers.get('content-encoding') ? 0 : Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onBytes?.(got, Math.max(total, got));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * The runtime module. Fetched with fetch() — the same path as the model — and
 * imported from a Blob URL: on some phones a module import() of the file URL
 * fails every time ("Failed to fetch dynamically imported module") while
 * fetch() of the 14 MB model succeeds. The bundle supports a blob: base, and
 * the .wasm is handed over as bytes (wasmBinary), so it never resolves a
 * path. A direct import of the URL is the fallback.
 */
async function importRuntime(url: string): Promise<Ort> {
  const errs: string[] = [];
  try {
    const src = await download(url);
    const blob = URL.createObjectURL(new Blob([src as BlobPart], { type: 'text/javascript' }));
    try {
      return (await import(/* @vite-ignore */ blob)) as Ort;
    } finally {
      URL.revokeObjectURL(blob);
    }
  } catch (err) {
    errs.push(`blob: ${msg(err)}`);
  }
  try {
    return (await import(/* @vite-ignore */ `${url}?t=${Date.now()}`)) as Ort;
  } catch (err) {
    errs.push(`url: ${msg(err)}`);
  }
  throw new Error(`無法載入 AI 執行環境（${errs.join('；')}）· ${navigator.userAgent}`);
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
   * `onProgress` gets the bytes of every download together.
   */
  static async create(modelUrl: string, ortDir: string, onProgress?: Progress): Promise<Funie> {
    const seen = new Map<string, [number, number]>();
    const track = (key: string): Progress => (got, total) => {
      seen.set(key, [got, total]);
      let g = 0, t = 0;
      for (const [a, b] of seen.values()) {
        g += a;
        t += b;
      }
      onProgress?.(g, t);
    };
    const model = download(modelUrl, track('model'));
    model.catch(() => {}); // awaited below; don't report it unhandled while the runtime loads
    const start = async (b: Backend) => {
      const [ort, wasm] = await Promise.all([importRuntime(ortDir + RUNTIME[b].js), download(ortDir + RUNTIME[b].wasm, track(b))]);
      // threads would need COOP/COEP (not on GitHub Pages) and a file URL for the worker
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmBinary = wasm;
      const session = await ort.InferenceSession.create(await model, { executionProviders: [b] });
      return new Funie(ort, session, b);
    };
    if (await webgpuUsable()) {
      try {
        return await start('webgpu');
      } catch (err) {
        console.warn('FUnIE-GAN: WebGPU unavailable, using WASM', err);
      }
    }
    return start('wasm');
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
