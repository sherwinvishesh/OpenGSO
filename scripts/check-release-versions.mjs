#!/usr/bin/env node
/**
 * Refuses to publish a version nobody chose.
 *
 * `changeset publish` publishes every package whose version is not on the registry yet, and an npm
 * version can never be reused once it is out. So a placeholder that reaches the registry is
 * permanent. `npm run release` runs this first, which means it gates the publish and nothing else:
 * the release workflow can still open the "Version Packages" pull request that moves off them.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['testing', 'generate', 'prod', 'cli', 'omnigeo'];

/**
 * `0.0.0` is the placeholder the private root and core carry. `0.1.0` is the version every package
 * was scaffolded with and has never been bumped from. Remove it from this list once it is the
 * version the first release is meant to have.
 */
const PLACEHOLDERS = new Set(['0.0.0', '0.1.0']);

/** @type {string[]} */
const failures = [];
for (const dir of PACKAGES) {
  const pkg = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
  if (PLACEHOLDERS.has(pkg.version)) failures.push(`${pkg.name} is still at the placeholder version ${pkg.version}.`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error('Nothing was published. Add a changeset and merge the "Version Packages" pull request first.');
  process.exit(1);
}
console.log(`ok  no published package is at a placeholder version (${[...PLACEHOLDERS].join(', ')}).`);
