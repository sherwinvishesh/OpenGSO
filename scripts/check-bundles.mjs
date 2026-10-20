#!/usr/bin/env node
/**
 * Asserts the structural promises the built bundles make (§3).
 *
 * 1. `opengso-prod`'s importable library, and the copy of it `opengso` ships as `opengso/prod`,
 *    carry no jsdom, no AI provider code and no network call. That library runs on the user's
 *    server on every request, so its weight and its network surface are part of the product.
 * 2. The edge entries import no `node:` module at all, since edge bundlers reject one even when
 *    the code that uses it never runs.
 * 3. Every bundle, CLIs included, imports nothing but Node builtins and the dependencies its
 *    package declares, and jsdom is the only dependency any package may declare. `opengso-prod`
 *    may not declare even that.
 *
 * Run after `npm run build`. It reads what the build produced, never the source: the metafile
 * esbuild wrote beside `dist/` (`scripts/bundle-meta.mjs`) says which modules went into which
 * file and what each file imports, and the `dist/` text is scanned as well, because a string
 * that matters can arrive from anywhere.
 */
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_META_DIR } from './bundle-meta.mjs';
import { PROVIDERS } from '../packages/core/src/shared/providers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/** @type {string[]} */
const failures = [];

const PACKAGES = ['testing', 'generate', 'prod', 'cli', 'opengso'];
/** Library entries, by package directory. Each is checked as the runtime the middleware is. */
const LIBRARIES = {
  prod: { runtime: ['index.js', 'next.js', 'edge.js', 'node.js', 'fetch.js', 'vite.js'], edge: ['edge.js'] },
  opengso: {
    runtime: ['prod.js', 'prod-next.js', 'prod-edge.js', 'prod-node.js', 'prod-fetch.js', 'prod-vite.js'],
    edge: ['prod-edge.js'],
  },
};
const ALLOWED_DEPENDENCIES = { 'opengso-prod': [] };

/**
 * Modules whose presence in a runtime bundle means AI or jsdom code came along. Matched against
 * the metafile's input paths, which are relative to the package directory.
 */
const BANNED_MODULES = [
  { label: 'jsdom', pattern: /(^|\/)node_modules\/jsdom\// },
  { label: 'the AI provider catalogue', pattern: /core\/src\/shared\/providers\.js$/ },
  { label: 'the AI call path', pattern: /core\/src\/shared\/ai-call\.js$/ },
  { label: 'the AI rewriter', pattern: /core\/src\/generate\/ai\.js$/ },
  { label: 'the AI quality review', pattern: /core\/src\/test\/quality\.js$/ },
];

/**
 * Strings no runtime bundle may contain, derived from the provider catalogue so a thirteenth
 * provider is banned the day it is added.
 */
const BANNED_TEXT = [
  { label: 'jsdom', pattern: /\bjsdom\b/i },
  // The middleware answers from a map it loaded at boot. A network call in the library means
  // something like the deployment checker has been re-exported from the runtime entry.
  { label: 'a network call', pattern: /\bfetch\(/ },
  ...Object.values(PROVIDERS).flatMap((provider) => [
    ...(provider.baseUrl ? [{ label: `the ${provider.id} endpoint`, text: new URL(provider.baseUrl).host }] : []),
    ...(provider.envVars ?? []).map((name) => ({ label: `the ${provider.id} key variable ${name}`, text: name })),
  ]),
];
if (Object.keys(PROVIDERS).length < 12) failures.push(`The provider catalogue has ${Object.keys(PROVIDERS).length} entries; expected at least 12.`);

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/**
 * @typedef {{ path: string, kind: string, external?: boolean }} MetaImport
 * @typedef {{ imports: MetaImport[], inputs: Record<string, { bytesInOutput: number }>, entryPoint?: string }} MetaOutput
 * @typedef {{ outputs: Record<string, MetaOutput> }} Metafile
 */

/** @param {string} pkgDir @param {string} name @returns {Metafile | undefined} */
function readMeta(pkgDir, name) {
  const file = join(pkgDir, BUNDLE_META_DIR, `${name}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Every output file an entry pulls in, followed through static and dynamic imports.
 *
 * @param {Metafile} meta
 * @param {string} entry A file name inside `dist/`.
 * @returns {{ file: string, output: MetaOutput }[]}
 */
function reachable(meta, entry) {
  const seen = new Set();
  const queue = [`dist/${entry}`];
  const found = [];
  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.shift());
    if (seen.has(file)) continue;
    seen.add(file);
    const output = meta.outputs[file];
    if (!output) continue;
    found.push({ file, output });
    for (const imported of output.imports) if (!imported.external) queue.push(imported.path);
  }
  return found;
}

/** A bare specifier's package name: `@scope/name/sub` -> `@scope/name`, `jsdom/lib` -> `jsdom`. */
const packageName = (/** @type {string} */ specifier) =>
  specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');

let scanned = 0;
for (const dir of PACKAGES) {
  const pkgDir = join(root, 'packages', dir);
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const declared = Object.keys(pkg.dependencies ?? {});

  // 3a. What the package declares.
  const permitted = ALLOWED_DEPENDENCIES[pkg.name] ?? ['jsdom'];
  for (const dep of declared) {
    if (!permitted.includes(dep)) failures.push(`${pkg.name} declares an unexpected runtime dependency: ${dep}.`);
  }

  const builds = LIBRARIES[dir] ? ['library', 'cli'] : ['cli'];
  for (const build of builds) {
    const meta = readMeta(pkgDir, build);
    if (!meta) {
      failures.push(`packages/${dir}/${BUNDLE_META_DIR}/${build}.json is missing. Run \`npm run build\` first.`);
      continue;
    }

    // 3b. What the bundles import, which is what has to be installed for them to run.
    for (const [file, output] of Object.entries(meta.outputs)) {
      if (!file.endsWith('.js')) continue;
      if (!existsSync(join(pkgDir, file))) failures.push(`${pkg.name}: the metafile lists ${file}, which the build did not leave in dist/. Rebuild.`);
      for (const imported of output.imports) {
        if (!imported.external || builtins.has(imported.path)) continue;
        if (!declared.includes(packageName(imported.path))) {
          failures.push(`${pkg.name}: ${file} imports ${imported.path}, which the package does not declare.`);
        }
      }
    }

    if (build !== 'library') continue;
    const { runtime, edge } = LIBRARIES[dir];

    // 1. The runtime library.
    for (const entry of runtime) {
      const files = reachable(meta, entry);
      if (files.length === 0) {
        failures.push(`${pkg.name}: dist/${entry} is not in the metafile, so nothing about it was checked.`);
        continue;
      }
      for (const { file, output } of files) {
        scanned += 1;
        for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
          if (bytesInOutput === 0) continue;
          for (const { label, pattern } of BANNED_MODULES) {
            if (pattern.test(input)) failures.push(`${pkg.name}: ${file}, reachable from ${entry}, contains ${label} (${input}).`);
          }
        }
        for (const imported of output.imports) {
          if (imported.external && !imported.path.startsWith('node:')) {
            failures.push(`${pkg.name}: ${file}, reachable from ${entry}, imports ${imported.path}. The runtime imports Node builtins only.`);
          }
        }
        const text = readFileSync(join(pkgDir, file), 'utf8');
        for (const ban of BANNED_TEXT) {
          const hit = 'pattern' in ban ? ban.pattern.test(text) : text.includes(ban.text);
          if (hit) failures.push(`${pkg.name}: ${file}, reachable from ${entry}, contains ${ban.label}.`);
        }
      }
    }

    // 2. The edge entries.
    for (const entry of edge) {
      for (const { file, output } of reachable(meta, entry)) {
        for (const imported of output.imports) {
          if (imported.external) failures.push(`${pkg.name}: ${file} is reachable from ${entry} and imports ${imported.path}.`);
        }
      }
    }
  }
}

if (scanned === 0) failures.push('No runtime bundle file was scanned, so the check proved nothing.');
if (failures.length > 0) {
  for (const line of failures) console.error(`FAIL  ${line}`);
  process.exit(1);
}
console.log(
  `ok  ${scanned} runtime bundle files carry no jsdom, no AI code and no network call; the edge entries import nothing; every bundle imports only builtins and declared dependencies.`,
);
