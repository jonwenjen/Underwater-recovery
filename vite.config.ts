import { createReadStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * 🤖 AI 風格 runtime: onnxruntime-web's self-contained ESM bundles and their
 * .wasm, served as plain files at ort/<version>/ instead of going through the
 * chunk graph. The app imports them by URL, so a failed load (flaky mobile
 * network) can be retried with a cache-busting query — Chromium caches a
 * failed dynamic import() of a chunk for the life of the page.
 */
const ORT_DIST = join(import.meta.dirname, 'node_modules/onnxruntime-web/dist');
const ORT_VERSION: string = JSON.parse(readFileSync(join(ORT_DIST, '../package.json'), 'utf8')).version;
const ORT_FILES = ['ort.wasm.bundle.min.mjs', 'ort-wasm-simd-threaded.wasm', 'ort.webgpu.bundle.min.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];
const ortRuntime = (): Plugin => ({
  name: 'ort-runtime',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const f = req.url?.match(/\/ort\/[^/]+\/([^/?]+)/)?.[1];
      if (!f || !ORT_FILES.includes(f)) return next();
      res.setHeader('Content-Type', f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      createReadStream(join(ORT_DIST, f)).pipe(res);
    });
  },
  generateBundle() {
    for (const f of ORT_FILES) this.emitFile({ type: 'asset', fileName: `ort/${ORT_VERSION}/${f}`, source: readFileSync(join(ORT_DIST, f)) });
  },
});

export default defineConfig({
  // Served from https://jonwenjen.github.io/Underwater-recovery/ — without this
  // prefix every built asset resolves to the domain root and 404s.
  base: '/Underwater-recovery/',
  define: { __ORT_VERSION__: JSON.stringify(ORT_VERSION) },
  plugins: [ortRuntime()],
});
