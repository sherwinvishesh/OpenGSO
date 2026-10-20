import { DEFAULT_MARKDOWN_ROUTING, resolveBots } from '../../shared/bots.js';
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
 * The twins travel as data, in the module `opengeo prod data` writes after `opengeo generate`. It
 * carries the project's markdown routing and custom crawlers too, so the edge decides exactly what
 * a Node server reading `opengeo.config.json` would.
 */

/**
 * What `opengeo prod data` writes, and what a hand-written build step has to produce.
 *
 * @typedef {object} EdgeData
 * @property {StoreManifest} manifest `.opengeo/manifest.json`, as generate wrote it.
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
  const { data } = options;
  return fetchMiddleware(
    createProdHandler({
      store: createManifestStore(data),
      markdownRouting: options.markdownRouting ?? data.markdownRouting ?? DEFAULT_MARKDOWN_ROUTING,
      bots: resolveBots(data.customBots),
      specVersion: options.specVersion,
    }),
  );
}
