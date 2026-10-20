import { fetchMiddleware } from '../respond.js';
import { createProjectHandler } from './project.js';

/**
 * @import { FetchMiddleware } from '../respond.js'
 * @import { ProjectOptions } from './options.js'
 */

/**
 * The fetch adapter for servers that run on Node (or Bun, or Deno with npm support) and hand their
 * middleware a `Request`: Hono, SvelteKit's `handle` hook, Astro's `onRequest`, React Router and
 * Remix middleware, SolidStart, Nitro. It reads the project from disk like the Node adapter does;
 * a runtime with no disk wants `createEdgeMiddleware` instead.
 *
 *   const opengso = createFetchMiddleware();
 *   export const handle = ({ event, resolve }) => opengso(event.request, () => resolve(event));
 */

/**
 * @param {ProjectOptions} [options]
 * @returns {FetchMiddleware}
 */
export function createFetchMiddleware(options = {}) {
  return fetchMiddleware(createProjectHandler(options));
}
