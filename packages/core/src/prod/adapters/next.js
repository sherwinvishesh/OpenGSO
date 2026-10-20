import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveBots } from '../../shared/bots.js';
import { CONFIG_FILENAME, ConfigError, findConfigFile, loadConfig } from '../../shared/config.js';
import { CONFIG_ERRORS, STORE_ERRORS } from '../../shared/errors.js';
import { createProdHandler } from '../middleware.js';
import { logReloadStatus, logStartupStatus } from '../startup.js';
import { createFsStore, createMemoryStore } from '../store.js';

/**
 * @import { ProdContext, ProdDecision, RequestLike } from '../middleware.js'
 * @import { MarkdownStore } from '../store.js'
 * @import { LoadedConfig } from '../../shared/config.js'
 */

/**
 * Next.js adapter (§19: one thin adapter per hosting target).
 *
 * Deliberately does not import anything from `next`. The user's own proxy.ts owns the two
 * Next-specific lines; keeping `next` out of opengeo-prod's dependency graph is what lets the same
 * package sit in a Netlify function or a plain Node server without dragging a framework along.
 *
 * Requires the Node.js runtime, because it reads the generated files from disk. Next 16's proxy.ts
 * always has it, and refuses a `runtime` option. Next 15's middleware.ts has to ask for it:
 *
 *   export const config = { runtime: 'nodejs', matcher: [...] };
 *
 * Known upstream limitation: Next's app-page runtime calls `res.setHeader('vary', ...)` while
 * rendering, which replaces the `Vary: Accept` this adapter hands back for the HTML response.
 * Markdown responses are unaffected. Verified on 16.3.4 and 16.3.8; see examples/nextjs-demo/README.md.
 */

/**
 * @typedef {object} NextAdapterOptions
 * @property {string} [root] Project root - where opengeo.config.json, public/ and .opengeo/ live.
 * @property {string} [publicDir]
 * @property {string} [internalDir]
 * @property {readonly string[]} [markdownRouting] Overrides the config file's
 *   `bots.markdownRouting`.
 * @property {string} [specVersion]
 * @property {boolean} [logStartup] Startup status logging is on by default and only ever runs once
 *   per process (§7).
 * @property {MarkdownStore} [store] Pre-built store, for tests or for a build-time-inlined manifest.
 * @property {boolean} [reload] Re-read the config and the twins when they change on disk, checked at
 *   most once a second. On by default outside production, so `opengeo generate` during `next dev`
 *   shows up without a restart. Off in production, where a request stays a map lookup.
 */

/**
 * @typedef {object} NextMiddlewareResult
 * @property {Response} [response] Present when prod answered the request itself: markdown, or a
 *   406.
 * @property {Record<string, string>} headers Headers to copy onto the host's own HTML response
 *   when prod did not answer.
 * @property {ProdDecision} decision
 */

/**
 * @param {NextAdapterOptions} [options]
 * @returns {(request: RequestLike) => NextMiddlewareResult} Declared rather than inferred: the
 *   fail-open branch below returns a different function, and an inferred union drops `response`
 *   from the published types, which breaks every `const { response } = opengeo(request)`.
 */
export function createNextMiddleware(options = {}) {
  const root = options.root ?? process.cwd();
  let current = load(root, options, 'boot', new Map());
  const reload = options.store === undefined && (options.reload ?? process.env.NODE_ENV !== 'production');
  let checkedAt = Date.now();

  /**
   * @param {RequestLike} request
   * @returns {NextMiddlewareResult}
   */
  return function openGeoNextMiddleware(request) {
    if (reload && Date.now() - checkedAt >= RELOAD_INTERVAL_MS) {
      checkedAt = Date.now();
      const seen = statsOf(current.watched);
      if (stampOf(current.watched, seen) !== current.stamp) current = reloaded(root, options, current, seen);
    }
    const decision = current.handler(request);
    if (decision.type === 'passthrough') return { headers: decision.headers, decision };
    return { response: decision.response, headers: {}, decision };
  };
}

/** How stale a development server's twins can be after `opengeo generate` writes new ones. */
const RELOAD_INTERVAL_MS = 1000;

/**
 * @typedef {object} Loaded
 * @property {(request: RequestLike) => ProdDecision} handler
 * @property {string[]} watched The config file and everything the store read, for the reload check.
 * @property {string} stamp
 */

/**
 * Build the handler from what is on disk now. At boot a config prod cannot use is logged and served
 * around rather than thrown: this runs at module scope in the user's proxy.ts, so a throw would take
 * every page down with it. A broken config costs the site its markdown and nothing else.
 *
 * The stamp keeps the times `seen` before reading wherever it has one. A file rewritten while it was
 * being read then still differs from the stamp, and is read again on the next check instead of
 * being missed.
 *
 * @param {string} root
 * @param {NextAdapterOptions} options
 * @param {'boot' | 'reload'} when
 * @param {Map<string, string>} seen
 * @returns {Loaded}
 */
function load(root, options, when, seen) {
  const configFile = findConfigFile(root) ?? join(resolve(root), CONFIG_FILENAME);
  /** @type {LoadedConfig} */
  let loaded;
  try {
    loaded = loadConfig(root);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(CONFIG_ERRORS.prodFailedOpen(error.message));
    const handler = createProdHandler({ store: createMemoryStore([]), markdownRouting: [] });
    return { handler, watched: [configFile], stamp: stampOf([configFile], seen) };
  }
  const publicDir = options.publicDir ?? loaded.config.publicDir;
  const store =
    options.store ??
    createFsStore({ root, publicDir, internalDir: options.internalDir ?? loaded.config.internalDir });

  /** @type {ProdContext} */
  const ctx = {
    store,
    markdownRouting: options.markdownRouting ?? loaded.config.bots.markdownRouting,
    // Resolved once per load, like everything else here: a request must stay a map lookup (§7).
    bots: resolveBots(loaded.config.bots.custom),
    specVersion: options.specVersion,
  };

  if (options.logStartup !== false) {
    const status = { root, publicDir, store, bots: ctx.bots };
    if (when === 'boot') logStartupStatus(status);
    else logReloadStatus(status);
  }
  const watched = [configFile, ...(store.sources ?? [])];
  return { handler: createProdHandler(ctx), watched, stamp: stampOf(watched, seen) };
}

/**
 * A reload that fails for any reason other than the config keeps the twins that were already
 * loaded. A development server mid-save is the likeliest cause, and the next change retries.
 *
 * @param {string} root
 * @param {NextAdapterOptions} options
 * @param {Loaded} previous
 * @param {Map<string, string>} seen
 * @returns {Loaded}
 */
function reloaded(root, options, previous, seen) {
  try {
    return load(root, options, 'reload', seen);
  } catch (error) {
    console.error(STORE_ERRORS.reloadFailed(error instanceof Error ? error.message : String(error)));
    return { ...previous, stamp: stampOf(previous.watched, seen) };
  }
}

/**
 * @param {string[]} files
 * @returns {Map<string, string>}
 */
function statsOf(files) {
  return new Map(files.map((file) => [file, statOf(file)]));
}

/**
 * @param {string[]} files
 * @param {Map<string, string>} seen Times already taken, used in preference to the disk.
 * @returns {string}
 */
function stampOf(files, seen) {
  return files.map((file) => seen.get(file) ?? statOf(file)).join('|');
}

/**
 * A file's modification time and size. A missing file has a stamp too, so a manifest that appears
 * for the first time counts as a change.
 *
 * @param {string} file
 * @returns {string}
 */
function statOf(file) {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '-';
  }
}

/**
 * Copy prod's passthrough headers onto a NextResponse (or any Headers-bearing response).
 *
 * @param {{ headers: { set(name: string, value: string): void } }} target
 * @param {Record<string, string>} headers
 * @returns {void}
 */
export function applyPassthroughHeaders(target, headers) {
  for (const [name, value] of Object.entries(headers)) target.headers.set(name, value);
}
