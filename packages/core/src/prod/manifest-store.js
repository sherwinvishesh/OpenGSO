/**
 * The stores that never touch a filesystem (§7).
 *
 * Kept apart from `store.js` because an edge bundler refuses a `node:` import outright: it does not
 * tree-shake a module that imports `node:fs` just because the function using it went unused. This
 * module, and everything `edge.js` exports, has no Node import at all.
 *
 *  - `createManifestStore` - the caller imports the manifest and the markdown bodies as data at
 *    build time and hands them over. `createFsStore` reads the disk and then builds one of these.
 *  - `createMemoryStore` - tests, and the local product website's preview.
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
