import { mergeHeaderValue } from '../respond.js';
import { createProjectHandler } from './project.js';

/**
 * @import { ProdDecision, RequestLike } from '../middleware.js'
 * @import { ProjectOptions } from './options.js'
 */

/**
 * Next.js adapter (§19: one thin adapter per hosting target).
 *
 * Deliberately does not import anything from `next`. The user's own proxy.ts owns the two
 * Next-specific lines; keeping `next` out of omnigeo-prod's dependency graph is what lets the same
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
 * Everything the other Node adapters take: where the project is, and whether to reload it in
 * development. Kept as its own name because it is in the published types.
 *
 * @typedef {ProjectOptions} NextAdapterOptions
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
 * @returns {(request: RequestLike) => NextMiddlewareResult} Declared rather than inferred, so
 *   `response` stays in the published types and `const { response } = omnigeo(request)` checks.
 */
export function createNextMiddleware(options = {}) {
  const decide = createProjectHandler(options);

  /**
   * @param {RequestLike} request
   * @returns {NextMiddlewareResult}
   */
  return function omniGeoNextMiddleware(request) {
    const decision = decide(request);
    if (decision.type === 'passthrough') return { headers: decision.headers, decision };
    return { response: decision.response, headers: {}, decision };
  };
}

/**
 * Copy prod's passthrough headers onto a NextResponse (or any Headers-bearing response). `Vary` and
 * `Link` are added to whatever the response already lists rather than replacing it.
 *
 * @param {{ headers: { set(name: string, value: string): void; get?(name: string): string | null } }} target
 * @param {Record<string, string>} headers
 * @returns {void}
 */
export function applyPassthroughHeaders(target, headers) {
  for (const [name, value] of Object.entries(headers)) {
    target.headers.set(name, mergeHeaderValue(name, target.headers.get?.(name), value));
  }
}
