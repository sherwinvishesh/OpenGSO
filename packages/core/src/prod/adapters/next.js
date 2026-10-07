import { resolveBots } from '../../shared/bots.js';
import { ConfigError, loadConfig } from '../../shared/config.js';
import { CONFIG_ERRORS } from '../../shared/errors.js';
import { createProdHandler } from '../middleware.js';
import { logStartupStatus } from '../startup.js';
import { createFsStore, createMemoryStore } from '../store.js';

/**
 * @import { ProdContext, ProdDecision, RequestLike } from '../middleware.js'
 * @import { MarkdownStore } from '../store.js'
 * @import { LoadedConfig } from '../../shared/config.js'
 */

/**
 * Next.js adapter (§19: one thin adapter per hosting target).
 *
 * Deliberately does not import anything from `next`. The user's own middleware.ts owns the two
 * Next-specific lines; keeping `next` out of opengeo-prod's dependency graph is what lets the same
 * package sit in a Netlify function or a plain Node server without dragging a framework along.
 *
 * Requires the Node.js middleware runtime, because it reads the generated files from disk:
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
 */

/**
 * @typedef {object} NextMiddlewareResult
 * @property {Response} [response] Present when prod answered the request itself: markdown, or a
 *   406.
 * @property {Record<string, string>} headers Headers to copy onto the host's own HTML response
 *   when prod did not answer.
 * @property {ProdDecision} decision
 */

/** @param {NextAdapterOptions} [options] */
export function createNextMiddleware(options = {}) {
  const root = options.root ?? process.cwd();
  /** @type {LoadedConfig} */
  let loaded;
  try {
    loaded = loadConfig(root);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // This runs at module scope in the user's middleware.ts, so a throw here would take every page
    // down with it. A config prod cannot use costs the site its markdown and nothing else.
    console.error(CONFIG_ERRORS.prodFailedOpen(error.message));
    const passthrough = createProdHandler({ store: createMemoryStore([]), markdownRouting: [] });
    return function openGeoNextMiddleware(/** @type {RequestLike} */ request) {
      return { headers: {}, decision: passthrough(request) };
    };
  }
  const store =
    options.store ??
    createFsStore({
      root,
      publicDir: options.publicDir ?? loaded.config.publicDir,
      internalDir: options.internalDir ?? loaded.config.internalDir,
    });

  /** @type {ProdContext} */
  const ctx = {
    store,
    markdownRouting: options.markdownRouting ?? loaded.config.bots.markdownRouting,
    // Resolved once at boot, like everything else here: a request must stay a map lookup (§7).
    bots: resolveBots(loaded.config.bots.custom),
    specVersion: options.specVersion,
  };

  if (options.logStartup !== false) {
    logStartupStatus({ root, publicDir: options.publicDir ?? loaded.config.publicDir, store, bots: ctx.bots });
  }

  const handler = createProdHandler(ctx);

  /**
   * @param {RequestLike} request
   * @returns {NextMiddlewareResult}
   */
  return function openGeoNextMiddleware(request) {
    const decision = handler(request);
    if (decision.type === 'passthrough') return { headers: decision.headers, decision };
    return { response: decision.response, headers: {}, decision };
  };
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
