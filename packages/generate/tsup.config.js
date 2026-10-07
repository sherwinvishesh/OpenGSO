import { defineConfig } from 'tsup';
import { recordBundle } from '../../scripts/bundle-meta.mjs';

/**
 * `@opengeo/core` is private and never published, so it must be inlined into this bundle rather
 * than left as an import (§3). Everything else - jsdom in particular - stays external and
 * is declared as a real dependency.
 */
export default defineConfig({
  entry: { cli: 'src/cli.js' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  dts: false,
  sourcemap: false,
  noExternal: [/@opengeo\/core/],
  banner: { js: '#!/usr/bin/env node' },
  esbuildPlugins: [recordBundle('cli')],
});
