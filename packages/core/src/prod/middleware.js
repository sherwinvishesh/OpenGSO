import { AEO_SPEC_VERSION } from '../shared/version.js';
import { htmlHeaders, markdownHeaders, notAcceptableHeaders, NOT_ACCEPTABLE_BODY } from './headers.js';
import { classify } from './negotiate.js';

/**
 * @import { AiBot } from '../shared/bots.js'
 * @import { Classification } from './negotiate.js'
 * @import { MarkdownDoc, MarkdownStore } from './store.js'
 */

/**
 * The framework-agnostic heart of opengeo-prod (§7).
 *
 * It is a pure function over a request: no I/O, no AI, no API key, no per-request computation
 * beyond a map lookup. Everything a hosting target needs is in the returned decision, so each
 * adapter stays a few lines and nothing about a specific framework leaks in here.
 *
 * It rewrites, never redirects: the URL a visitor asked for is the URL that answers, with the same
 * substantive content in a different format.
 */

/**
 * @typedef {object} ProdContext
 * @property {MarkdownStore} store
 * @property {readonly string[]} markdownRouting Lever 1 (§7): which bots get markdown. Never a
 *   blocking list.
 * @property {readonly AiBot[]} [bots] The crawler catalogue to match User-Agents against, built-ins
 *   plus the project's own `bots.custom` entries. Omitted means the shipped list, which is what a
 *   hand-wired middleware with no config gets.
 * @property {string} [specVersion]
 */

/**
 * @typedef {object} RequestLike
 * @property {string} url
 * @property {string} [method]
 * @property {{ get(name: string): string | null }} headers
 */

/**
 * On a passthrough, `headers` are the ones the adapter must copy onto the host's own HTML response.
 *
 * @typedef {{ type: 'markdown'; response: Response; classification: Classification; doc: MarkdownDoc }
 *   | { type: 'not-acceptable'; response: Response; classification: Classification }
 *   | { type: 'passthrough'; headers: Record<string, string>; classification: Classification }} ProdDecision
 */

/** Paths prod never touches: static assets and framework internals. `.md` is the exception. */
const IGNORED_PREFIXES = ['/_next/', '/_nuxt/', '/_astro/', '/__nextjs', '/@vite/', '/node_modules/'];
const ASSET_EXTENSION = /\.[a-z0-9]{1,8}$/i;

/**
 * @param {RequestLike} request
 * @param {ProdContext} ctx
 * @returns {ProdDecision}
 */
export function handleRequest(request, ctx) {
  const url = new URL(request.url);
  const method = (request.method ?? 'GET').toUpperCase();
  const specVersion = ctx.specVersion ?? AEO_SPEC_VERSION;

  const classification = classify({
    pathname: url.pathname,
    userAgent: request.headers.get('user-agent'),
    accept: request.headers.get('accept'),
    markdownRouting: ctx.markdownRouting,
    bots: ctx.bots,
  });

  const doc = ctx.store.get(classification.route);

  // The extension test is a guess about what a path is, and the store is the answer: a route
  // generate wrote a twin for (`/blog/v1.2`) is a page, however its last segment looks.
  const isAsset =
    IGNORED_PREFIXES.some((prefix) => url.pathname.startsWith(prefix)) ||
    (ASSET_EXTENSION.test(url.pathname) && !url.pathname.endsWith('.md') && !doc);

  if (isAsset || (method !== 'GET' && method !== 'HEAD')) {
    return { type: 'passthrough', headers: {}, classification };
  }

  // Only a route with a twin is prod's to refuse. Everywhere else the application owns the URL, and
  // an API asking for JSON or an event stream asking for text/event-stream is none of our business.
  if (classification.serve === 'not-acceptable' && doc) {
    return {
      type: 'not-acceptable',
      classification,
      response: new Response(NOT_ACCEPTABLE_BODY, {
        status: 406,
        headers: notAcceptableHeaders(specVersion),
      }),
    };
  }

  if (classification.serve === 'markdown' && doc) {
    return {
      type: 'markdown',
      classification,
      doc,
      response: new Response(method === 'HEAD' ? null : doc.body, {
        status: 200,
        headers: markdownHeaders({
          tokens: doc.tokens,
          specVersion,
          lastUpdated: doc.lastUpdated,
          sourceHash: doc.sourceHash,
          selectedByUserAgent: !classification.explicitTwin && !classification.accept.prefersMarkdown,
        }),
      }),
    };
  }

  // No twin on disk: fall through to the real site rather than inventing one. An agent seeing the
  // normal HTML is a worse experience, never a broken one.
  return {
    type: 'passthrough',
    classification,
    headers: htmlHeaders({ route: classification.route, hasTwin: Boolean(doc), specVersion }),
  };
}

/**
 * Convenience wrapper for adapters that only care about "did prod answer this request".
 *
 * @param {ProdContext} ctx
 * @returns {(request: RequestLike) => ProdDecision}
 */
export function createProdHandler(ctx) {
  return (request) => handleRequest(request, ctx);
}
