import { defineConfig } from 'vite';

export default defineConfig({
  // Served from https://jonwenjen.github.io/Underwater-recovery/ — without this
  // prefix every built asset resolves to the domain root and 404s.
  base: '/Underwater-recovery/',
});
