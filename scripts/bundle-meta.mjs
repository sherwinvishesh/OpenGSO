/**
 * Records what went into each bundle, for `check-bundles.mjs` to assert on.
 *
 * tsup's own `metafile` option writes into `dist/`, which ships, and every build in a package
 * writes the same file name, so a package with a library build and a CLI build keeps only the
 * last one. This esbuild plugin asks for the same metafile and writes it to `.bundle-meta/<name>.json`
 * beside `dist/`, which is gitignored and outside every package's `files`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUNDLE_META_DIR = '.bundle-meta';

/**
 * @param {string} name What this build is called in the check's messages: `library` or `cli`.
 * @returns {import('esbuild').Plugin}
 */
export function recordBundle(name) {
  return {
    name: 'opengeo-record-bundle',
    setup(build) {
      build.initialOptions.metafile = true;
      build.onEnd((result) => {
        if (!result.metafile) return;
        const dir = join(build.initialOptions.absWorkingDir ?? process.cwd(), BUNDLE_META_DIR);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${name}.json`), JSON.stringify(result.metafile, null, 1));
      });
    },
  };
}
