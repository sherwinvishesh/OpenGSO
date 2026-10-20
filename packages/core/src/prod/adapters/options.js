/**
 * The options every adapter that reads a project from disk takes: Next, Node, fetch and Vite. Types
 * only, in a module of their own so the packages can re-export them.
 */

/**
 * @import { MarkdownStore } from '../store.js'
 */

/**
 * @typedef {object} ProjectOptions
 * @property {string} [root] Project root - where opengeo.config.json, public/ and .opengeo/ live.
 *   Defaults to the working directory, which is where every framework's server starts.
 * @property {string} [publicDir]
 * @property {string} [internalDir]
 * @property {readonly string[]} [markdownRouting] Overrides the config file's
 *   `bots.markdownRouting`.
 * @property {string} [specVersion]
 * @property {boolean} [logStartup] Startup status logging is on by default and only ever runs once
 *   per process (§7).
 * @property {MarkdownStore} [store] Pre-built store, for tests or for a build-time-inlined manifest.
 * @property {boolean} [reload] Re-read the config and the twins when they change on disk, checked at
 *   most once a second. On by default outside production, so `opengeo generate` during a dev server
 *   shows up without a restart. Off in production, where a request stays a map lookup.
 */

export {};
