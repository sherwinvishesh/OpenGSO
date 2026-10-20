import { resolve } from 'node:path';
import { loadConfig } from '../shared/config.js';
import { CONFIG_ERRORS, ERRORS } from '../shared/errors.js';
import { parseUrl } from '../shared/http.js';
import { UsageError } from './args.js';

/**
 * @import { LoadedConfig } from '../shared/config.js'
 * @import { Args } from './args.js'
 */

/**
 * Resolving "which project am I operating on" in one place, so `generate`, `settings` and `start`
 * all agree on where `opengso.config.json`, `public/` and `.opengso/` live.
 *
 * @param {Args} args
 * @returns {LoadedConfig}
 */
export function resolveProject(args) {
  const dir = args.str('project');
  const loaded = loadConfig(dir ? resolve(process.cwd(), dir) : process.cwd());
  // On stderr, so a --json run's output is the same with or without a stray key.
  for (const { key, suggestion } of loaded.unknownKeys ?? []) process.stderr.write(`${CONFIG_ERRORS.unknownConfigKey(key, suggestion)}\n`);
  return loaded;
}

/**
 * The URL to work against: the positional argument if given, otherwise `site` from the config.
 * Never a source directory (§1): test and prod judge what the site actually serves. Generate is the
 * one command that also reads a folder of HTML files, and it decides that before calling this.
 *
 * @param {Args} args
 * @param {LoadedConfig} loaded
 * @param {string} command
 * @returns {URL}
 */
export function resolveTarget(args, loaded, command) {
  const raw = args.positionals[0] ?? (loaded.exists ? loaded.config.site : undefined);
  if (!raw) throw new UsageError(ERRORS.missingUrl(command));
  const url = parseUrl(raw);
  if (!url) throw new UsageError(ERRORS.invalidUrl(raw));
  return url;
}
