import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { STORE_ERRORS } from '../shared/errors.js';
import { createManifestStore } from './manifest-store.js';

export * from './manifest-store.js';

/**
 * Where prod reads markdown from (§7).
 *
 * Everything is loaded once, at startup. By the time a request arrives, serving a twin is a map
 * lookup against already-parsed strings - no filesystem walk, no frontmatter parsing, no token
 * counting, and certainly no AI call. A development server may build a new store when `sources`
 * change on disk; that is the adapter's business, and production never does it.
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
  const twins = readTwins(options);
  return loadedFrom(createManifestStore(twins), twins.problems, twins.sources);
}

/**
 * @typedef {object} TwinFiles
 * @property {StoreManifest} manifest Only the entries whose file was found and read.
 * @property {Record<string, string>} contents Raw file contents keyed by the manifest's `file`.
 * @property {string[]} problems
 * @property {string[]} sources The manifest and every twin it lists, read or not.
 */

/**
 * What `createFsStore` loads, as data: the same manifest checks and the same refusal of a twin
 * outside publicDir. `opengso prod data` writes this for the edge, so a Worker and a Node server
 * built from one project serve exactly the same twins.
 *
 * @param {FsStoreOptions} options
 * @returns {TwinFiles}
 */
export function readTwins(options) {
  const root = resolve(options.root);
  const publicDir = resolve(root, options.publicDir ?? 'public');
  const internalDir = resolve(root, options.internalDir ?? '.opengso');
  const manifestFile = join(internalDir, 'manifest.json');

  // The manifest is listed even when it is missing, so a development server started before the
  // first generate still notices when one appears.
  if (!existsSync(manifestFile)) return nothingRead(STORE_ERRORS.noManifest(manifestFile), manifestFile);

  /** @type {unknown} */
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return nothingRead(STORE_ERRORS.unreadableManifest(manifestFile, reason), manifestFile);
  }
  // Parsed is not the same as a manifest, and this runs at server start: a TypeError here would
  // take the site down over a file that only decides which pages get a twin.
  const table = isRecord(manifest) ? manifest.pages : undefined;
  if (!isRecord(table)) {
    return nothingRead(STORE_ERRORS.manifestHasNoPages(manifestFile), manifestFile);
  }

  /** @type {string[]} */
  const problems = [];
  /** @type {Record<string, StoreManifestEntry>} */
  const pages = {};
  /** @type {Record<string, string>} */
  const contents = {};
  const sources = [manifestFile];
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
    // Listed whether or not it is there, so a twin that appears later counts as a change.
    sources.push(file);
    if (!existsSync(file)) {
      problems.push(STORE_ERRORS.twinMissing(entry.route, file));
      continue;
    }
    // A twin that is a directory, or has lost its read permission, costs that one page and is
    // reported, rather than throwing out of a server's boot.
    try {
      contents[entry.file] = readFileSync(file, 'utf8');
    } catch (error) {
      problems.push(STORE_ERRORS.twinUnreadable(entry.route, file, error instanceof Error ? error.message : String(error)));
      continue;
    }
    pages[key] = entry;
  }
  return { manifest: { pages }, contents, problems, sources };
}

/**
 * @param {string} problem
 * @param {string} manifestFile
 * @returns {TwinFiles}
 */
function nothingRead(problem, manifestFile) {
  return { manifest: { pages: {} }, contents: {}, problems: [problem], sources: [manifestFile] };
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
 * @param {string[]} sources
 * @returns {MarkdownStore}
 */
function loadedFrom(store, problems, sources) {
  store.problems.unshift(...problems);
  store.sources = sources;
  return store;
}
