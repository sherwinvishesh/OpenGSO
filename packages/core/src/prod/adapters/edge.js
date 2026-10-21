import { DEFAULT_MARKDOWN_ROUTING, resolveBots } from '../../shared/bots.js';
import { PROD_ERRORS } from '../../shared/errors.js';
import { createManifestStore } from '../manifest-store.js';
import { createProdHandler } from '../middleware.js';
import { fetchMiddleware } from '../respond.js';

/**
 * @import { CustomBotInput } from '../../shared/bots.js'
 * @import { StoreManifest } from '../manifest-store.js'
 * @import { FetchMiddleware } from '../respond.js'
 */

/**
 * The edge adapter: Cloudflare Workers and Pages Functions, Vercel and Netlify edge functions, Deno
 * Deploy, and anything else with `Request` and `Response` but no disk.
 *
 * The twins travel as data, in the module `opengso prod data` writes after `opengso generate`. It
 * carries the project's markdown routing and custom crawlers too, so the edge decides exactly what
 * a Node server reading `opengso.config.json` would.
 */

/**
 * What `opengso prod data` writes, and what a hand-written build step has to produce.
 *
 * @typedef {object} EdgeData
 * @property {StoreManifest} manifest `.opengso/manifest.json`, as generate wrote it.
 * @property {Record<string, string>} contents Every twin's text, keyed by the manifest's `file`.
 * @property {readonly string[]} [markdownRouting] `bots.markdownRouting` from the config.
 * @property {readonly CustomBotInput[]} [customBots] `bots.custom` from the config.
 */

/**
 * @typedef {object} EdgeMiddlewareOptions
 * @property {EdgeData} data
 * @property {readonly string[]} [markdownRouting] Overrides the routing carried in `data`.
 * @property {string} [specVersion]
 */

/**
 * Built once per isolate, at module scope, so a request is a lookup and nothing else.
 *
 * @param {EdgeMiddlewareOptions} options
 * @returns {FetchMiddleware}
 */
export function createEdgeMiddleware(options) {
  const data = options?.data;
  const wrong = notEdgeData(data);
  if (wrong) throw new TypeError(PROD_ERRORS.edgeDataNotData(wrong));
  return fetchMiddleware(
    createProdHandler({
      store: createManifestStore(data),
      markdownRouting: options.markdownRouting ?? data.markdownRouting ?? DEFAULT_MARKDOWN_ROUTING,
      bots: resolveBots(data.customBots),
      specVersion: options.specVersion,
    }),
  );
}

/**
 * What is wrong with `data`, in a few words, or nothing.
 *
 * The mistake this catches is an import that went wrong: a named import of the module's default
 * export arrives as undefined, and a namespace import as an object whose only key is `default`.
 * Without the check both failed as "Cannot read properties of undefined (reading 'manifest')".
 *
 * @param {unknown} data
 * @returns {string | undefined}
 */
function notEdgeData(data) {
  if (data === undefined) return 'undefined';
  if (data === null || typeof data !== 'object') return `a ${data === null ? 'null' : typeof data}`;
  const record = /** @type {Record<string, unknown>} */ (data);
  if ('default' in record && !('manifest' in record)) return 'the whole module instead of its default export';
  const manifest = record.manifest;
  if (manifest === null || typeof manifest !== 'object') return 'an object with no manifest';
  const pages = /** @type {Record<string, unknown>} */ (manifest).pages;
  if (pages === null || typeof pages !== 'object') return 'a manifest with no pages table';
  if (record.contents === null || typeof record.contents !== 'object') return 'an object with no contents';
  return undefined;
}
