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
 * Two builds: the importable middleware library, and the CLI that ships `opengeo prod test`.
 *
 * Only the library gets type declarations, and only the CLI gets a shebang. `@opengeo/core/prod`
 * imports neither jsdom nor any provider code, which is what keeps this package dependency-free
 * (idea.md §3) - `npm run check:no-jsdom` asserts it.
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts', next: 'src/next.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'neutral',
    clean: true,
    // Inline core's declarations too: core is never published, so a bare re-export would leave
    // consumers with types that resolve to nothing.
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
