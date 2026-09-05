#!/usr/bin/env node
/**
 * Asserts the two structural promises the built bundles make (idea.md §3).
 *
 * 1. `opengeo-prod`'s importable library carries no jsdom and no AI provider code. It is the one
 *    package that runs on the user's server on every request, so its weight and its network
 *    surface are part of the product, not an implementation detail.
 * 2. jsdom is the only runtime dependency any published package may declare, and `opengeo-prod`
 *    may not declare even that.
 *
 * Run after `npm run build`. It reads `dist/`, never the source, because the source is not what
 * ships.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function read(dir, files) {
  return files.map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

/** Everything the entry pulls in: the entry file plus the shared chunks it imports. */
function libraryFiles(dir, entries) {
  const all = readdirSync(dir);
  const chunks = all.filter((name) => name.startsWith('chunk-') && name.endsWith('.js'));
  return read(dir, [...entries, ...chunks]);
}

// 1. opengeo-prod's library half.
const prodDist = join(root, 'packages/prod/dist');
if (!existsSync(prodDist)) {
  failures.push('packages/prod/dist is missing. Run `npm run build` first.');
} else {
  const banned = [
    { label: 'jsdom', pattern: /\bjsdom\b/i },
    { label: 'an AI provider endpoint', pattern: /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com/i },
    { label: 'an API key environment variable', pattern: /ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY/ },
  ];
  for (const file of libraryFiles(prodDist, ['index.js', 'next.js'])) {
    for (const { label, pattern } of banned) {
      if (pattern.test(file.text)) failures.push(`opengeo-prod/dist/${file.name} contains ${label}.`);
    }
  }
}

// 2. Declared runtime dependencies. jsdom is the one dependency OpenGEO has, and `opengeo-prod`
// is not allowed even that: it is the package that runs on a server on every request.
const allowed = { 'opengeo-prod': [] };
for (const dir of ['testing', 'generate', 'prod', 'cli', 'opengeo']) {
  const pkg = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies ?? {});
  const permitted = allowed[pkg.name] ?? ['jsdom'];
  for (const dep of deps) {
    if (!permitted.includes(dep)) failures.push(`${pkg.name} declares an unexpected runtime dependency: ${dep}.`);
  }
}

if (failures.length > 0) {
  for (const line of failures) console.error(`FAIL  ${line}`);
  process.exit(1);
}
console.log('ok  opengeo-prod ships no jsdom and no AI code, and no package declares an unexpected runtime dependency.');
