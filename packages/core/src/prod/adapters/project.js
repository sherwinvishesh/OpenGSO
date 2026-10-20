import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveBots } from '../../shared/bots.js';
import { CONFIG_FILENAME, ConfigError, findConfigFile, loadConfig } from '../../shared/config.js';
import { CONFIG_ERRORS, STORE_ERRORS } from '../../shared/errors.js';
import { createProdHandler } from '../middleware.js';
import { logReloadStatus, logStartupStatus } from '../startup.js';
import { createFsStore, createMemoryStore } from '../store.js';

/**
 * @import { ProdContext, ProdDecision, RequestLike } from '../middleware.js'
 * @import { LoadedConfig } from '../../shared/config.js'
 * @import { ProjectOptions } from './options.js'
 */

/**
 * What every Node adapter shares: read the project once, decide each request from memory, and in
 * development notice when `opengso generate` or `opengso settings` changed something on disk.
 *
 * The Next, Node and fetch adapters differ only in how a request gets in and a response gets out.
 * Keeping the loading here is what stops them disagreeing about which config, which crawlers or
 * which twins a site has.
 */


/**
 * @param {ProjectOptions} [options]
 * @returns {(request: RequestLike) => ProdDecision}
 */
export function createProjectHandler(options = {}) {
  const root = options.root ?? process.cwd();
  let current = load(root, options, 'boot', new Map());
  const reload = options.store === undefined && (options.reload ?? process.env.NODE_ENV !== 'production');
  let checkedAt = Date.now();

  return function decide(request) {
    if (reload && Date.now() - checkedAt >= RELOAD_INTERVAL_MS) {
      checkedAt = Date.now();
      const seen = statsOf(current.watched);
      if (stampOf(current.watched, seen) !== current.stamp) current = reloaded(root, options, current, seen);
    }
    return current.handler(request);
  };
}

/** How stale a development server's twins can be after `opengso generate` writes new ones. */
const RELOAD_INTERVAL_MS = 1000;

/**
 * @typedef {object} Loaded
 * @property {(request: RequestLike) => ProdDecision} handler
 * @property {string[]} watched The config file and everything the store read, for the reload check.
 * @property {string} stamp
 */

/**
 * Build the handler from what is on disk now. At boot a config prod cannot use is logged and served
 * around rather than thrown: this runs at module scope in the user's server, so a throw would take
 * every page down with it. A broken config costs the site its markdown and nothing else.
 *
 * The stamp keeps the times `seen` before reading wherever it has one. A file rewritten while it was
 * being read then still differs from the stamp, and is read again on the next check instead of
 * being missed.
 *
 * @param {string} root
 * @param {ProjectOptions} options
 * @param {'boot' | 'reload'} when
 * @param {Map<string, string>} seen
 * @returns {Loaded}
 */
function load(root, options, when, seen) {
  const configFile = findConfigFile(root) ?? join(resolve(root), CONFIG_FILENAME);
  /** @type {LoadedConfig} */
  let loaded;
  try {
    loaded = loadConfig(root);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(CONFIG_ERRORS.prodFailedOpen(error.message));
    const handler = createProdHandler({ store: createMemoryStore([]), markdownRouting: [] });
    return { handler, watched: [configFile], stamp: stampOf([configFile], seen) };
  }
  // The directory the config was found in, which is not always the one the server started in: a
  // Vite app with `root: 'src'`, or a server started from a workspace package. publicDir and
  // internalDir are relative to the config, so they are resolved against it too.
  const projectRoot = loaded.root;
  const publicDir = options.publicDir ?? loaded.config.publicDir;
  const store =
    options.store ??
    createFsStore({ root: projectRoot, publicDir, internalDir: options.internalDir ?? loaded.config.internalDir });

  /** @type {ProdContext} */
  const ctx = {
    store,
    markdownRouting: options.markdownRouting ?? loaded.config.bots.markdownRouting,
    // Resolved once per load, like everything else here: a request must stay a map lookup (§7).
    bots: resolveBots(loaded.config.bots.custom),
    specVersion: options.specVersion,
  };

  if (options.logStartup !== false) {
    const status = { root: projectRoot, publicDir, store, bots: ctx.bots, routing: ctx.markdownRouting, unknownKeys: loaded.unknownKeys };
    if (when === 'boot') logStartupStatus(status);
    else logReloadStatus(status);
  }
  const watched = [configFile, ...(store.sources ?? [])];
  return { handler: createProdHandler(ctx), watched, stamp: stampOf(watched, seen) };
}

/**
 * A reload that fails for any reason other than the config keeps the twins that were already
 * loaded. A development server mid-save is the likeliest cause, and the next change retries.
 *
 * @param {string} root
 * @param {ProjectOptions} options
 * @param {Loaded} previous
 * @param {Map<string, string>} seen
 * @returns {Loaded}
 */
function reloaded(root, options, previous, seen) {
  try {
    return load(root, options, 'reload', seen);
  } catch (error) {
    console.error(STORE_ERRORS.reloadFailed(error instanceof Error ? error.message : String(error)));
    return { ...previous, stamp: stampOf(previous.watched, seen) };
  }
}

/**
 * @param {string[]} files
 * @returns {Map<string, string>}
 */
function statsOf(files) {
  return new Map(files.map((file) => [file, statOf(file)]));
}

/**
 * @param {string[]} files
 * @param {Map<string, string>} seen Times already taken, used in preference to the disk.
 * @returns {string}
 */
function stampOf(files, seen) {
  return files.map((file) => seen.get(file) ?? statOf(file)).join('|');
}

/**
 * A file's modification time and size. A missing file has a stamp too, so a manifest that appears
 * for the first time counts as a change.
 *
 * @param {string} file
 * @returns {string}
 */
function statOf(file) {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '-';
  }
}
