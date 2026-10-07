import { resolve } from 'node:path';
import { loadConfig } from '../shared/config.js';
import { ERRORS } from '../shared/errors.js';
import { parseUrl } from '../shared/http.js';

/**
 * @import { LoadedConfig } from '../shared/config.js'
 * @import { Args } from './args.js'
 */

/**
 * Resolving "which project am I operating on" in one place, so `generate`, `settings` and `start`
 * all agree on where `opengeo.config.json`, `public/` and `.opengeo/` live.
 *
 * @param {Args} args
 * @returns {LoadedConfig}
 */
export function resolveProject(args) {
  const dir = args.str('project');
  return loadConfig(dir ? resolve(process.cwd(), dir) : process.cwd());
}

/**
 * The URL to work against: the positional argument if given, otherwise `site` from the config.
 * Never a source directory (§1) - OpenGEO always looks at what the site actually serves.
 *
 * @param {Args} args
 * @param {LoadedConfig} loaded
 * @param {string} command
 * @returns {URL}
 */
export function resolveTarget(args, loaded, command) {
  const raw = args.positionals[0] ?? (loaded.exists ? loaded.config.site : undefined);
  if (!raw) throw new Error(ERRORS.missingUrl(command));
  const url = parseUrl(raw);
  if (!url) throw new Error(ERRORS.invalidUrl(raw));
  return url;
}
