#!/usr/bin/env node
/**
 * Checks what a user would actually install, not the source it was built from.
 *
 * Tests run against `src/` and `check-bundles` reads what went into each bundle, so neither notices a bin
 * that crashes on start, an export pointing at a file the build stopped producing, or a tarball
 * that leaves out the dashboard. For every published package this script:
 *
 * 1. runs each `bin` with `--version` and expects the package's own version back;
 * 2. imports each entry in `exports` by package name, which goes through the exports map the way a
 *    user's `import` does;
 * 3. asks `npm pack --dry-run` for the file list and checks every bin and export target is in it,
 *    nothing from `src/` or `tests/` is, and the `opengeo` tarball carries the dashboard.
 *
 * Everything is read from each package.json, so a new export is covered without editing this
 * file. Run after `npm run build`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireFrom = createRequire(import.meta.url);
const PACKAGES = ['testing', 'generate', 'prod', 'cli', 'opengeo'];
/** Files the `opengeo` tarball must carry, and files it must not. */
const DASHBOARD = { present: ['web/index.html', 'web/app.js', 'web/styles.css'], absent: ['web/tsconfig.json'] };

/** @type {string[]} */
const failures = [];
let checked = 0;

/** @param {string} target @returns {string} */
const clean = (target) => target.replace(/^\.\//, '');

/**
 * Every file an `exports` map points at, by subpath. Conditions nest, so this walks them all.
 *
 * @param {unknown} exportsField
 * @returns {Map<string, string[]>}
 */
function exportTargets(exportsField) {
  const bySubpath = new Map();
  if (!exportsField || typeof exportsField !== 'object') return bySubpath;
  for (const [subpath, value] of Object.entries(exportsField)) {
    /** @type {string[]} */
    const files = [];
    const walk = (/** @type {unknown} */ node) => {
      if (typeof node === 'string') files.push(clean(node));
      else if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    walk(value);
    bySubpath.set(subpath, files);
  }
  return bySubpath;
}

for (const dir of PACKAGES) {
  const pkgDir = join(root, 'packages', dir);
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const label = pkg.name;

  // 1. Every bin starts and knows its version.
  for (const [bin, target] of Object.entries(pkg.bin ?? {})) {
    const run = spawnSync(process.execPath, [join(pkgDir, target), '--version'], { encoding: 'utf8', timeout: 30_000 });
    if (run.status !== 0) failures.push(`${label}: \`${bin} --version\` exited ${run.status}: ${(run.stderr || run.error?.message || '').trim()}`);
    else if (!run.stdout.includes(pkg.version)) failures.push(`${label}: \`${bin} --version\` printed "${run.stdout.trim()}", not ${pkg.version}`);
  }

  // 2. Every export resolves through the exports map and loads.
  const exportsMap = exportTargets(pkg.exports);
  for (const subpath of exportsMap.keys()) {
    const specifier = subpath === '.' ? label : `${label}/${subpath.replace(/^\.\//, '')}`;
    // A resolver that does not match `import` (require, or a tool asking with no conditions) falls
    // through to `default`. Without one, the subpath does not exist for it at all.
    try {
      requireFrom.resolve(specifier);
    } catch (error) {
      failures.push(`${label}: \`${specifier}\` has no \`default\` condition, so a non-import resolver cannot find it: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const loaded = await import(specifier);
      if (Object.keys(loaded).length === 0) failures.push(`${label}: \`import '${specifier}'\` loaded, but exports nothing`);
    } catch (error) {
      failures.push(`${label}: \`import '${specifier}'\` failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 3. The tarball has what the manifest promises and nothing it should not.
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: pkgDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 60_000,
  });
  if (pack.status !== 0) {
    failures.push(`${label}: npm pack --dry-run exited ${pack.status}: ${pack.stderr.trim()}`);
    continue;
  }
  /** @type {Set<string>} */
  const shipped = new Set(JSON.parse(pack.stdout)[0].files.map((/** @type {{ path: string }} */ file) => file.path.replaceAll('\\', '/')));
  const promised = [...Object.values(pkg.bin ?? {}).map(clean), ...[...exportsMap.values()].flat(), 'README.md'];
  for (const file of promised) if (!shipped.has(file)) failures.push(`${label}: the tarball is missing ${file}`);
  for (const file of shipped) if (/^(src|tests)\//.test(file)) failures.push(`${label}: the tarball ships ${file}`);
  if (dir === 'opengeo') {
    for (const file of DASHBOARD.present) if (!shipped.has(file)) failures.push(`${label}: the tarball is missing the dashboard's ${file}`);
    for (const file of DASHBOARD.absent) if (shipped.has(file)) failures.push(`${label}: the tarball ships ${file}`);
  }
  checked += 1;
  console.log(`ok  ${label}: ${Object.keys(pkg.bin ?? {}).length} bin, ${exportsMap.size} export(s), ${shipped.size} files packed`);
}

if (checked !== PACKAGES.length) failures.push(`Checked ${checked} of ${PACKAGES.length} packages.`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
