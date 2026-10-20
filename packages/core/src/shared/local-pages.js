import { lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { normalizeRoute } from './routes.js';

/**
 * The pages of a site that exists as files: a hand-written site, or what a static site generator
 * built. Generate reads them instead of crawling, and the freshness check stats them to say which
 * twins are older than the page they came from.
 *
 * Node's `fs` and nothing else, on purpose. The home screen reads freshness on every repaint and is
 * bundled into all five packages, so this must never reach the extractor or jsdom.
 */

/**
 * @typedef {object} LocalPage
 * @property {string} file Path relative to the web root, with forward slashes on every platform.
 * @property {string} path Absolute path on disk.
 * @property {number} size Bytes.
 * @property {number} mtimeMs
 */

/**
 * @typedef {object} LocalPageList
 * @property {LocalPage[]} pages `index.html` first, then in path order.
 * @property {string[]} skipped One line per file that was found and deliberately not used.
 * @property {boolean} capped True when the folder held more pages than `maxPages`.
 */

/**
 * @typedef {object} ListOptions
 * @property {readonly string[]} [exclude] Route prefixes to leave out, the same `crawl.exclude` a
 *   crawl honours. A prefix matches a page by its file path or by its clean URL, so `/admin` leaves
 *   out `admin.html` and everything under `admin/`.
 * @property {number} [maxPages]
 * @property {readonly string[]} [skipDirs] Absolute directories never to enter, such as the
 *   internal directory when somebody put it inside the web root.
 */

const HTML_FILE = /\.html?$/i;

/**
 * Pages that exist so a host can serve them on an error, or so a search console can verify the
 * domain. Neither is content anybody wants an agent to read.
 */
const NOT_A_PAGE = /^(?:40\d|50\d|50x|offline|google[0-9a-f]{8,}|yandex_[0-9a-f]+|BingSiteAuth)\.html?$/i;

/** Far deeper than any real site, and shallow enough that a directory loop cannot run away. */
const MAX_DEPTH = 32;

/**
 * Every page under `webRoot`.
 *
 * Skipped without a word: anything starting with `.` (`.git`, `.env`, `.opengso`), anything starting
 * with `_` (`_next/`, `_includes/`, `_layout.html`: framework internals and template partials, never
 * a page on their own), `node_modules`, and symbolic links, which could lead out of the project.
 * Skipped with a line in `skipped`: error and verification pages.
 *
 * @param {string} webRoot
 * @param {ListOptions} [options]
 * @returns {LocalPageList}
 */
export function listLocalPages(webRoot, options = {}) {
  const base = resolve(webRoot);
  const exclude = (options.exclude ?? []).map((prefix) => normalizeRoute(prefix));
  const skipDirs = new Set((options.skipDirs ?? []).map((dir) => resolve(dir)));
  /** @type {string[]} */
  const skipped = [];
  /** @type {LocalPage[]} */
  const found = [];

  /**
   * @param {string} dir
   * @param {number} depth
   */
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    /** @type {string[]} */
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    // Code-unit order, so two machines list the same folder the same way whatever their locale.
    for (const name of names.sort()) {
      if (name.startsWith('.') || name.startsWith('_') || name === 'node_modules') continue;
      const path = join(dir, name);
      /** @type {import('node:fs').Stats} */
      let stats;
      try {
        stats = lstatSync(path);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        if (!skipDirs.has(path)) walk(path, depth + 1);
        continue;
      }
      if (!stats.isFile() || !HTML_FILE.test(name)) continue;
      const file = relative(base, path).split(sep).join('/');
      if (NOT_A_PAGE.test(name)) {
        skipped.push(`${file}: an error or verification page, not content - skipped.`);
        continue;
      }
      if (excluded(file, exclude)) continue;
      found.push({ file, path, size: stats.size, mtimeMs: stats.mtimeMs });
    }
  };
  walk(base, 0);

  found.sort((a, b) => rank(a.file) - rank(b.file) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const max = options.maxPages ?? Number.POSITIVE_INFINITY;
  return { pages: found.slice(0, max), skipped, capped: found.length > max };
}

/**
 * The URL path a static host serves a file at.
 *
 * An index file is always its folder: `index.html` is `/`, `blog/index.html` is `/blog`. Any other
 * page has two forms, and which one a site uses is a fact about the site, not the file: `about.html`
 * is `/about.html` in the `file` form, which every host answers to, and `/about` in the `clean` form,
 * which most hosts answer to as well and which many sites link to.
 *
 * Percent-encoded the way a URL carries it, because routes found by a crawl come from
 * `URL.pathname` and the two must name the same page the same way: `my page.html` is `/my%20page.html`.
 *
 * @param {string} file Relative to the web root, forward slashes.
 * @param {'file' | 'clean'} [form]
 * @returns {string}
 */
export function fileToRoute(file, form = 'clean') {
  const parts = file.split('/');
  const name = /** @type {string} */ (parts.pop());
  if (isIndexFile(name)) {
    // Nothing to add for the folder itself.
  } else if (form === 'clean') {
    parts.push(name.replace(HTML_FILE, ''));
  } else {
    parts.push(name);
  }
  // The three characters a URL parser would read as syntax rather than as part of a name. Everything
  // else, spaces and non-ASCII included, the parser encodes the way a browser would.
  const path = parts.map((part) => part.replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F')).join('/');
  return normalizeRoute(new URL(`/${path}`, 'http://pages.invalid').pathname);
}

/**
 * Whether a path names an HTML page, which is what lets `opengso generate site/about.html` mean
 * "this one page".
 *
 * @param {string} file
 * @returns {boolean}
 */
export function isHtmlFile(file) {
  return HTML_FILE.test(file);
}

/**
 * A path the way the person would type it from here: relative when it is below the working
 * directory, absolute otherwise, since `../../../../var/www` names nothing anybody recognises.
 *
 * @param {string} path
 * @returns {string}
 */
export function shownPath(path) {
  const rel = relative(process.cwd(), path);
  return rel === '' ? '.' : rel.startsWith('..') || isAbsolute(rel) ? path : rel;
}

/**
 * @param {string} name A file name, not a path.
 * @returns {boolean}
 */
export function isIndexFile(name) {
  return /^index\.html?$/i.test(name);
}

/**
 * @param {string} file
 * @param {readonly string[]} exclude
 * @returns {boolean}
 */
function excluded(file, exclude) {
  if (exclude.length === 0) return false;
  const forms = [normalizeRoute(`/${file}`), fileToRoute(file, 'clean')];
  return exclude.some((prefix) => forms.some((route) => route === prefix || route.startsWith(`${prefix === '/' ? '' : prefix}/`)));
}

/**
 * The home page first, so a capped run always keeps it, then the rest in path order.
 *
 * @param {string} file
 * @returns {number}
 */
function rank(file) {
  return isIndexFile(file) ? 0 : 1;
}
