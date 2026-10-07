import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { STORE_ERRORS } from '../shared/errors.js';
import { createManifestStore, createMemoryStore } from './manifest-store.js';

export * from './manifest-store.js';

/**
 * Where prod reads markdown from (§7).
 *
 * Everything is loaded once, at startup. By the time a request arrives, serving a twin is a map
 * lookup against already-parsed strings - no filesystem walk, no frontmatter parsing, no token
 * counting, and certainly no AI call.
 *
 * Two implementations, because hosting targets differ:
 *  - `createFsStore`   - Node runtime (Next.js Node middleware, a Node server, Netlify functions).
 *  - `createManifestStore` - edge runtimes with no filesystem: the caller imports the manifest and
 *    the markdown bodies as data at build time and hands them over. It lives in
 *    `manifest-store.js`, so the edge entry never sees this file's `node:` imports.
 */

/**
 * @import { MarkdownStore, StoreManifest, StoreManifestEntry } from './manifest-store.js'
 */

/**
 * @typedef {object} FsStoreOptions
 * @property {string} root Project root. `publicDir` and `internalDir` are resolved against it.
 * @property {string} [publicDir]
 * @property {string} [internalDir]
 */

/**
 * Reads the manifest and the files it lists, then hands both to `createManifestStore`, so the two
 * stores cannot drift in how they parse a twin.
 *
 * @param {FsStoreOptions} options
 * @returns {MarkdownStore}
 */
export function createFsStore(options) {
  const root = resolve(options.root);
  const publicDir = resolve(root, options.publicDir ?? 'public');
  const internalDir = resolve(root, options.internalDir ?? '.opengeo');
  const manifestFile = join(internalDir, 'manifest.json');

  if (!existsSync(manifestFile)) {
    return withProblems(createMemoryStore([]), [
      `No manifest at ${manifestFile}. Run \`opengeo generate <url>\` to create the markdown twins.`,
    ]);
  }

  /** @type {unknown} */
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    return withProblems(createMemoryStore([]), [
      `Could not read ${manifestFile}: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  // Parsed is not the same as a manifest, and this runs at server start: a TypeError here would
  // take the site down over a file that only decides which pages get a twin.
  const table = isRecord(manifest) ? manifest.pages : undefined;
  if (!isRecord(table)) return withProblems(createMemoryStore([]), [STORE_ERRORS.manifestHasNoPages(manifestFile)]);

  /** @type {string[]} */
  const problems = [];
  /** @type {Record<string, StoreManifestEntry>} */
  const pages = {};
  /** @type {Record<string, string>} */
  const contents = {};
  for (const [key, value] of Object.entries(table)) {
    if (!isRecord(value) || typeof value.route !== 'string' || typeof value.file !== 'string') {
      problems.push(STORE_ERRORS.manifestEntryUnusable(key, manifestFile));
      continue;
    }
    const entry = /** @type {StoreManifestEntry} */ (value);
    const file = resolve(publicDir, entry.file);
    // The manifest is a file on disk that anything with write access can edit, and prod serves
    // whatever it points at to anyone who asks. Only files inside publicDir are twins.
    const fromPublic = relative(publicDir, file);
    if (fromPublic === '' || fromPublic === '..' || fromPublic.startsWith(`..${sep}`) || isAbsolute(fromPublic)) {
      problems.push(STORE_ERRORS.twinOutsidePublicDir(entry.route, entry.file, publicDir));
      continue;
    }
    if (!existsSync(file)) {
      problems.push(`Manifest lists ${entry.route} but ${file} is missing. Rerun \`opengeo generate\`.`);
      continue;
    }
    pages[key] = entry;
    contents[entry.file] = readFileSync(file, 'utf8');
  }
  return withProblems(createManifestStore({ manifest: { pages }, contents }), problems);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {MarkdownStore} store
 * @param {string[]} problems
 * @returns {MarkdownStore}
 */
function withProblems(store, problems) {
  store.problems.unshift(...problems);
  return store;
}
