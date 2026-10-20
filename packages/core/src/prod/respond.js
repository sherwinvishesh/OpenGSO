import { PROD_ERRORS } from '../shared/errors.js';

/**
 * @import { ProdDecision, RequestLike } from './middleware.js'
 */

/**
 * Getting prod's answer onto a `Response`, for every runtime that speaks fetch: Hono, SvelteKit's
 * `handle`, Astro's `onRequest`, React Router and Remix, Nitro, Bun, Deno and the edge.
 *
 * Pure, like the rest of the edge entry: no `node:` import, nothing that reads a disk.
 */

/**
 * The `next` a framework hands its middleware: run the rest of the app and give back its response.
 * Called with no arguments, because some frameworks treat an argument as a rewrite.
 *
 * @typedef {() => Response | Promise<Response>} FetchNext
 */

/**
 * @typedef {(request: RequestLike, next: FetchNext) => Promise<Response>} FetchMiddleware
 */

/**
 * Merge one of prod's passthrough headers into the value the application already set.
 *
 * `Vary` and `Link` are lists, and replacing either drops something the application meant:
 * `Vary: Accept-Encoding` from its compression, a preload in `Link`. Every other header prod sets
 * is its own, so it is set outright.
 *
 * @param {string} name
 * @param {string | null | undefined} existing
 * @param {string} value
 * @returns {string}
 */
export function mergeHeaderValue(name, existing, value) {
  if (!existing) return value;
  const lower = name.toLowerCase();
  if (lower === 'vary') {
    const tokens = existing
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean);
    // `Vary: *` already says the response depends on everything.
    if (tokens.includes('*')) return existing;
    const have = new Set(tokens.map((token) => token.toLowerCase()));
    const added = value
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token && !have.has(token.toLowerCase()));
    return added.length > 0 ? [...tokens, ...added].join(', ') : existing;
  }
  if (lower === 'link') return existing.includes(value) ? existing : `${existing}, ${value}`;
  return value;
}

/**
 * Add prod's passthrough headers to the application's own response.
 *
 * A response from `fetch()` or `Response.redirect()` has headers that cannot be changed, which is
 * what an edge function proxying to its static assets usually holds, so that one is copied first.
 * A 101 is never copied: a WebSocket upgrade does not survive it.
 *
 * @template {Response | undefined} T
 * @param {T} response
 * @param {Record<string, string>} headers
 * @returns {T}
 */
export function withPassthroughHeaders(response, headers) {
  const entries = Object.entries(headers);
  if (!response || entries.length === 0 || response.status === 101) return response;
  try {
    setAll(response.headers, entries);
    return response;
  } catch {
    // Immutable. Copied below.
  }
  try {
    const copy = new Response(response.body, response);
    setAll(copy.headers, entries);
    return /** @type {T} */ (copy);
  } catch {
    return response;
  }
}

/**
 * @param {Headers} target
 * @param {Array<[string, string]>} entries
 */
function setAll(target, entries) {
  for (const [name, value] of entries) target.set(name, mergeHeaderValue(name, target.get(name), value));
}

/**
 * Turn a decision function into fetch-style middleware: answer with markdown or a 406 when prod
 * owns the request, otherwise run the app and add the passthrough headers to what it returned.
 *
 * A request prod cannot decide goes to the app untouched. A twin is never worth a failed page.
 *
 * @param {(request: RequestLike) => ProdDecision} decide
 * @returns {FetchMiddleware}
 */
export function fetchMiddleware(decide) {
  let reported = false;
  return async function openGeoFetchMiddleware(request, next) {
    /** @type {ProdDecision} */
    let decision;
    try {
      decision = decide(request);
    } catch (error) {
      if (!reported) {
        reported = true;
        console.error(PROD_ERRORS.requestFailedOpen(error instanceof Error ? error.message : String(error)));
      }
      return next();
    }
    if (decision.type !== 'passthrough') return decision.response;
    return withPassthroughHeaders(await next(), decision.headers);
  };
}
