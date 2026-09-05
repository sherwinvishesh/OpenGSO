import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dashboard is built to `dist/web` and served by `opengeo start` from a plain node:http server,
 * so React and Vite are devDependencies of this package and never reach a user's node_modules.
 *
 * `base: './'` keeps every asset URL relative, which is what lets the same build be served from any
 * port without a rebuild.
 */
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    // One JS file and one CSS file. The dashboard is small and served from localhost, so splitting
    // it would only add requests.
    rollupOptions: { output: { manualChunks: undefined } },
  },
  server: {
    // `vite dev` proxies the API to a running `opengeo start`, so the UI can be developed with hot
    // reload against a real project.
    proxy: { '/api': 'http://127.0.0.1:4321' },
  },
});
