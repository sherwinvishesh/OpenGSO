import { statSync } from 'node:fs';
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
  const loaded = loadConfig(projectRoot(args));
  // On stderr, so a --json run's output is the same with or without a stray key.
  for (const { key, suggestion } of loaded.unknownKeys ?? []) process.stderr.write(`${CONFIG_ERRORS.unknownConfigKey(key, suggestion)}\n`);
  return loaded;
}

/**
 * The project directory `--project` names, or the current one.
 *
 * A path that does not exist, or names a file, is a mistake on the command line and is said so
 * before anything is read or created: `generate` and `settings` used to create the folder, and
 * `test` silently read a config from nowhere.
 *
 * @param {Args} args
 * @returns {string} Absolute path of an existing directory.
 */
export function projectRoot(args) {
  const dir = args.str('project');
  if (!dir) return process.cwd();
  const root = resolve(process.cwd(), dir);
  /** @type {import('node:fs').Stats} */
  let stat;
  try {
    stat = statSync(root);
  } catch {
    throw new UsageError(ERRORS.projectMissing(dir));
  }
  if (!stat.isDirectory()) throw new UsageError(ERRORS.projectNotAFolder(dir));
  return root;
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
