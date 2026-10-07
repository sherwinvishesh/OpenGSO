import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
 *    the markdown bodies as data at build time and hands them over.
 */

/**
 * @typedef {object} MarkdownDoc
 * @property {string} route
 * @property {string} title
 * @property {string} body Body only - frontmatter is stripped once at load, never per request.
 * @property {number} tokens
 * @property {string} lastUpdated
 * @property {string} [sourceHash] Hash of the HTML this twin was generated from. Carried so prod
 *   can advertise it and `test`'s B14 check can tell "regenerated from this exact page" from "the
 *   page moved on without me".
 */

/**
 * @typedef {object} MarkdownStore
 * @property {(route: string) => MarkdownDoc | undefined} get
 * @property {(route: string) => boolean} has
 * @property {() => string[]} routes
 * @property {number} size
 * @property {string[]} problems Non-fatal problems found while loading, reported by the startup log.
 */

/**
 * @typedef {object} StoreManifestEntry
 * @property {string} route
 * @property {string} [title]
 * @property {string} file
 * @property {number} tokens
 * @property {string} [lastUpdated]
 * @property {string} [sourceHash]
 */

/**
 * @typedef {object} StoreManifest
 * @property {Record<string, StoreManifestEntry>} pages
 */

/**
 * @typedef {object} FsStoreOptions
 * @property {string} root Project root. `publicDir` and `internalDir` are resolved against it.
 * @property {string} [publicDir]
 * @property {string} [internalDir]
 */

/**
 * @param {FsStoreOptions} options
 * @returns {MarkdownStore}
 */
export function createFsStore(options) {
  const root = resolve(options.root);
  const publicDir = resolve(root, options.publicDir ?? 'public');
  const internalDir = resolve(root, options.internalDir ?? '.opengeo');
  const manifestFile = join(internalDir, 'manifest.json');
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, MarkdownDoc>} */
  const docs = new Map();

  if (!existsSync(manifestFile)) {
    problems.push(`No manifest at ${manifestFile}. Run \`opengeo generate <url>\` to create the markdown twins.`);
    return buildStore(docs, problems);
  }

  /** @type {StoreManifest} */
  let manifest;
  try {
    manifest = /** @type {StoreManifest} */ (JSON.parse(readFileSync(manifestFile, 'utf8')));
  } catch (error) {
    problems.push(`Could not read ${manifestFile}: ${error instanceof Error ? error.message : String(error)}`);
    return buildStore(docs, problems);
  }

  for (const entry of Object.values(manifest.pages ?? {})) {
    const file = join(publicDir, entry.file);
    if (!existsSync(file)) {
      problems.push(`Manifest lists ${entry.route} but ${file} is missing. Rerun \`opengeo generate\`.`);
      continue;
    }
    const raw = readFileSync(file, 'utf8');
    docs.set(entry.route, {
      route: entry.route,
      title: entry.title ?? entry.route,
      body: stripFrontmatter(raw),
      tokens: entry.tokens,
      lastUpdated: entry.lastUpdated ?? '',
      sourceHash: entry.sourceHash,
    });
  }
  return buildStore(docs, problems);
}

/**
 * @typedef {object} ManifestStoreOptions
 * @property {StoreManifest} manifest
 * @property {Record<string, string>} contents Raw file contents keyed by the manifest's `file`
 *   value, e.g. `md/resume.md`.
 */

/**
 * @param {ManifestStoreOptions} options
 * @returns {MarkdownStore}
 */
export function createManifestStore(options) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, MarkdownDoc>} */
  const docs = new Map();
  for (const entry of Object.values(options.manifest.pages ?? {})) {
    const raw = options.contents[entry.file];
    if (raw === undefined) {
      problems.push(`Manifest lists ${entry.route} but no content was supplied for ${entry.file}.`);
      continue;
    }
    docs.set(entry.route, {
      route: entry.route,
      title: entry.title ?? entry.route,
      body: stripFrontmatter(raw),
      tokens: entry.tokens,
      lastUpdated: entry.lastUpdated ?? '',
      sourceHash: entry.sourceHash,
    });
  }
  return buildStore(docs, problems);
}

/**
 * In-memory store, used by tests and by the local product website's preview.
 *
 * @param {MarkdownDoc[]} docs
 * @returns {MarkdownStore}
 */
export function createMemoryStore(docs) {
  return buildStore(new Map(docs.map((d) => [d.route, d])), []);
}

/**
 * @param {Map<string, MarkdownDoc>} docs
 * @param {string[]} problems
 * @returns {MarkdownStore}
 */
function buildStore(docs, problems) {
  return {
    get: (route) => docs.get(route),
    has: (route) => docs.has(route),
    routes: () => [...docs.keys()],
    size: docs.size,
    problems,
  };
}

/**
 * Strip a leading `---` frontmatter block. Done once per file at load; the served body is the
 * markdown a reader actually wants, without OpenGEO's bookkeeping at the top.
 *
 * @param {string} raw
 * @returns {string}
 */
function stripFrontmatter(raw) {
  const text = raw.replace(/^﻿/, '');
  if (!text.startsWith('---')) return text.trim();
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text.trim();
  return text.slice(end + '\n---'.length).replace(/^[^\n]*\n?/, '').trim();
}
