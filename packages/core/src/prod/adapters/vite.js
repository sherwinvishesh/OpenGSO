import { createNodeMiddleware } from './node.js';

/**
 * @import { NodeMiddleware } from './node.js'
 * @import { ProjectOptions } from './options.js'
 */

/**
 * The Vite plugin, for `vite` and `vite preview`: vanilla sites, and React, Vue, Svelte, Solid,
 * Preact and Lit apps. It imports nothing from `vite`; it is the object Vite expects, with the two
 * server hooks and nothing for the build.
 *
 * A built single-page app is static files, so in production the twins are served wherever those
 * files are, at their `.md` URLs, and serving them to crawlers at the page's own URL is a job for
 * the host's edge (see `createEdgeMiddleware`). This plugin makes the dev server and `vite preview`
 * behave the way that production setup will, so `opengso test` against localhost measures it.
 */

/**
 * @typedef {object} ViteServerLike
 * @property {{ root: string }} config
 * @property {{ use(middleware: NodeMiddleware): unknown }} middlewares
 */

/**
 * @typedef {object} OpenGsoVitePlugin
 * @property {string} name
 * @property {(server: ViteServerLike) => void} configureServer
 * @property {(server: ViteServerLike) => void} configurePreviewServer
 */

/**
 * Registered directly rather than returned from the hook, so it runs ahead of Vite's own
 * middlewares: before the SPA fallback answers a page URL with index.html, and before the static
 * server answers a `.md` URL without the headers a twin carries.
 *
 * @param {ProjectOptions} [options]
 * @returns {OpenGsoVitePlugin}
 */
export function opengso(options = {}) {
  return {
    name: 'opengso',
    configureServer(server) {
      server.middlewares.use(createNodeMiddleware({ root: server.config.root, reload: true, ...options }));
    },
    configurePreviewServer(server) {
      server.middlewares.use(createNodeMiddleware({ root: server.config.root, ...options }));
    },
  };
}

export default opengso;
