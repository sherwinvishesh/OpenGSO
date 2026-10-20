import { defineConfig } from 'tsup';
import { recordBundle } from '../../scripts/bundle-meta.mjs';

/**
 * Two builds: the importable middleware library, and the CLI that ships `omnigeo prod test`.
 *
 * Only the library gets type declarations, and only the CLI gets a shebang. `@omnigeo/core/prod`
 * imports neither jsdom nor any provider code, which is what keeps this package dependency-free
 * (§3) - `npm run check:bundles` asserts it.
 */
export default defineConfig([
  {
    entry: {
      index: 'src/index.js',
      next: 'src/next.js',
      edge: 'src/edge.js',
      node: 'src/node.js',
      fetch: 'src/fetch.js',
      vite: 'src/vite.js',
    },
    format: ['esm'],
    target: 'node22',
    platform: 'neutral',
    // tsup strips `node:` prefixes by default, and a neutral platform has no builtin list, so both
    // halves are set here: keep the prefix, and tell esbuild those specifiers are external.
    // Bundlers for serverless and edge targets use that prefix to recognise a builtin with
    // certainty, which is worth more than the shorter specifier.
    removeNodeProtocol: false,
    external: [/^node:/],
    clean: true,
    // Inline core's declarations too: core is never published, so a bare re-export would leave
    // consumers with types that resolve to nothing.
    dts: { resolve: true },
    sourcemap: false,
    noExternal: [/@omnigeo\/core/],
    esbuildPlugins: [recordBundle('library')],
  },
  {
    entry: { cli: 'src/cli.js' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    clean: false,
    dts: false,
    sourcemap: false,
    noExternal: [/@omnigeo\/core/],
    banner: { js: '#!/usr/bin/env node' },
    esbuildPlugins: [recordBundle('cli')],
  },
]);
