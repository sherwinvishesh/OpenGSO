import { PROD_ERRORS } from '../../shared/errors.js';
import { NOT_ACCEPTABLE_BODY } from '../headers.js';
import { mergeHeaderValue } from '../respond.js';
import { createProjectHandler } from './project.js';

/**
 * @import { ProdDecision, RequestLike } from '../middleware.js'
 * @import { ProjectOptions } from './options.js'
 */

/**
 * The Node adapter: `(req, res, next)` middleware, the shape Express, Connect, Polka, Vite's dev
 * and preview servers, Fastify through `@fastify/middie`, Nest, h3's `fromNodeMiddleware`, and the
 * Express servers Remix, React Router and Angular SSR generate all take.
 *
 * It answers a request itself only when prod owns it (a twin, or a 406 on a route that has one).
 * Everything else goes to `next()` with `Vary` and friends already on the response, so whatever the
 * app sends next carries them.
 *
 * The types are the few members it touches rather than `node:http`'s, so a framework's own request
 * and response objects fit without a cast.
 */

/**
 * @typedef {object} NodeRequestLike
 * @property {string} [url]
 * @property {string} [originalUrl] Express and Connect keep the full path here when a router is
 *   mounted below `/`, and twins are keyed by the full path.
 * @property {string} [method]
 * @property {Record<string, string | string[] | undefined>} headers
 */

/**
 * @typedef {object} NodeResponseLike
 * @property {number} statusCode
 * @property {boolean} [headersSent]
 * @property {(name: string, value: string) => unknown} setHeader
 * @property {(name: string) => unknown} getHeader
 * @property {(body?: string) => unknown} end
 */

/**
 * @typedef {(req: NodeRequestLike, res: NodeResponseLike, next?: (error?: unknown) => void) => true | undefined} NodeMiddleware
 *   Returns true when it answered the request itself, so a framework without `next` (Koa) knows not
 *   to send a second response. Otherwise it returns nothing at all, not false: h3's
 *   `fromNodeMiddleware`, which Nuxt and Nitro use, sends any value a middleware returns as the body.
 */

/**
 * @param {ProjectOptions} [options]
 * @returns {NodeMiddleware}
 */
export function createNodeMiddleware(options = {}) {
  const decide = createProjectHandler(options);
  let reported = false;

  return function openGsoNodeMiddleware(req, res, next) {
    /** @type {ProdDecision} */
    let decision;
    try {
      decision = decide(requestOf(req));
    } catch (error) {
      if (!reported) {
        reported = true;
        console.error(PROD_ERRORS.requestFailedOpen(error instanceof Error ? error.message : String(error)));
      }
      next?.();
      return undefined;
    }

    if (decision.type === 'passthrough') {
      if (!res.headersSent) {
        for (const [name, value] of Object.entries(decision.headers)) {
          res.setHeader(name, mergeHeaderValue(name, headerText(res.getHeader(name)), value));
        }
      }
      next?.();
      return undefined;
    }

    res.statusCode = decision.response.status;
    decision.response.headers.forEach((value, name) => {
      res.setHeader(name, value);
    });
    res.end(bodyOf(decision, req.method));
    return true;
  };
}

/**
 * The decision's body as a string, read from the store rather than the `Response`, because reading
 * a `Response` body is asynchronous and a Connect middleware has to answer now.
 *
 * @param {ProdDecision} decision
 * @param {string | undefined} method
 * @returns {string | undefined}
 */
function bodyOf(decision, method) {
  if ((method ?? 'GET').toUpperCase() === 'HEAD') return undefined;
  if (decision.type === 'not-acceptable') return NOT_ACCEPTABLE_BODY;
  if (decision.type === 'markdown' && decision.response.status === 200) return decision.doc.body;
  return undefined;
}

/**
 * Only the path decides anything, so the host is a placeholder rather than the `Host` header,
 * which is the client's to send and need not parse.
 *
 * @param {NodeRequestLike} req
 * @returns {RequestLike}
 */
function requestOf(req) {
  const target = req.originalUrl ?? req.url ?? '/';
  // `//a/b` is a valid request path and not a host; prefixing keeps it a path.
  const url = target.startsWith('/') ? `http://localhost${target}` : target;
  return {
    url,
    method: req.method,
    headers: { get: (name) => headerText(req.headers[name.toLowerCase()]) ?? null },
  };
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function headerText(value) {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value.join(', ') : String(value);
}
