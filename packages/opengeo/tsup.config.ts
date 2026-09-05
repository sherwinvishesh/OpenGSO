import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};

const define = {
  __OPENGEO_PACKAGE__: JSON.stringify(pkg.name),
  __OPENGEO_VERSION__: JSON.stringify(pkg.version),
};

/**
 * `@opengeo/core` is private and never published, so it must be inlined into these bundles rather
 * than left as an import (§3). Everything else - jsdom in particular - stays external and
 * is declared as a real dependency.
 *
 * Two builds: the importable middleware, so a project that installed only this package can wire up
 * prod without a second install, and the CLI. Only the library gets declarations, and only the CLI
 * gets a shebang. The library build cleans `dist/`, so it has to run first - and `vite build`,
 * which writes `dist/web`, has to run after both.
 */
export default defineConfig([
  {
    entry: { prod: 'src/prod.ts', 'prod-next': 'src/prod-next.ts' },
    format: ['esm'],
    target: 'node20',
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
    define,
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: false,
    dts: false,
    sourcemap: false,
    noExternal: [/@opengeo\/core/],
    banner: { js: '#!/usr/bin/env node' },
    define,
  },
]);
