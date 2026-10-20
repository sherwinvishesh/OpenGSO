import { defineConfig } from 'tsup';
import { recordBundle } from '../../scripts/bundle-meta.mjs';

/**
 * `@opengeo/core` is private and never published, so it must be inlined into these bundles rather
 * than left as an import (§3). Everything else - jsdom in particular - stays external and
 * is declared as a real dependency.
 *
 * Two builds: the importable middleware, so a project that installed only this package can wire up
 * prod without a second install, and the CLI. Only the library gets declarations, and only the CLI
 * gets a shebang. The library build cleans `dist/`, so it has to run first. The dashboard is not
 * built at all: `web/` ships as it is.
 */
export default defineConfig([
  {
    entry: {
      prod: 'src/prod.js',
      'prod-next': 'src/prod-next.js',
      'prod-edge': 'src/prod-edge.js',
      'prod-node': 'src/prod-node.js',
      'prod-fetch': 'src/prod-fetch.js',
      'prod-vite': 'src/prod-vite.js',
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
    dts: { resolve: true },
    sourcemap: false,
    noExternal: [/@opengeo\/core/],
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
    noExternal: [/@opengeo\/core/],
    banner: { js: '#!/usr/bin/env node' },
    esbuildPlugins: [recordBundle('cli')],
  },
]);
