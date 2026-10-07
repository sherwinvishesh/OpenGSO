import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './fs.js';
import { dirname, join, resolve, sep } from 'node:path';
import { DEFAULT_MARKDOWN_ROUTING } from './bots.js';
import { CONFIG_ERRORS } from './errors.js';

/**
 * @import { CustomBotInput } from './bots.js'
 * @import { AiProvider, ProviderApi, ProviderAuth, ProviderOverrides } from './providers.js'
 */

/**
 * Defined in `api-types.js` with every other shape the dashboard reads, and re-exported here.
 *
 * @typedef {import('./api-types.js').OpenGeoConfig} OpenGeoConfig
 */

// Types only, and deliberately: `prod` loads the config on every boot, and a value import from the
// catalogue would drag twelve provider endpoints and twelve key variable names into a bundle whose
// whole promise is that it contains no AI code. `check:bundles` fails the build if that happens
// again. Callers that need PROVIDERS, providerInfo or DEFAULT_MODELS import './providers.js'.

export const CONFIG_FILENAME = 'opengeo.config.json';

/**
 * @param {string} [site]
 * @returns {OpenGeoConfig}
 */
export function defaultConfig(site = 'http://localhost:3000') {
  return {
    site,
    publicDir: 'public',
    internalDir: '.opengeo',
    extraRoutes: [],
    crawl: { maxPages: 200, maxDepth: 4, exclude: [] },
    generate: { tier: 'free', minWords: 40 },
    bots: { markdownRouting: [...DEFAULT_MARKDOWN_ROUTING], blocked: [], custom: [] },
    // Written out rather than read from the catalogue, for the bundling reason above. It is not
    // free-floating: providers.test.js asserts it still matches providerInfo('anthropic').
    ai: { provider: 'anthropic', model: 'claude-sonnet-5' },
  };
}

/**
 * @typedef {object} LoadedConfig
 * @property {OpenGeoConfig} config
 * @property {string} root Absolute path of the project root (the directory holding
 *   opengeo.config.json, or cwd).
 * @property {string} [path] Absolute path of the config file, if one was found on disk.
 * @property {boolean} exists
 */

/**
 * Walk up from `startDir` looking for opengeo.config.json, but never past the project.
 *
 * The project ends at the repository root (the nearest directory holding `.git`), so a workspace
 * package in a monorepo still finds the config beside the root `package.json`. Outside a repository,
 * as on a server that was deployed without `.git`, it ends at the nearest `package.json`. With
 * neither, only `startDir` itself is checked. Walking all the way to `/` meant a stray config in a
 * home directory or a parent checkout silently became this project's config.
 *
 * @param {string} [startDir]
 * @returns {string | undefined}
 */
export function findConfigFile(startDir = process.cwd()) {
  const start = resolve(startDir);
  const boundary = findUp(start, '.git') ?? findUp(start, 'package.json') ?? start;
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    if (dir === boundary || dirname(dir) === dir) return undefined;
  }
}

/**
 * The nearest directory at or above `start` that holds `name`.
 *
 * @param {string} start
 * @param {string} name
 * @returns {string | undefined}
 */
function findUp(start, name) {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, name))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * A config file or patch OpenGEO will not use. The message is written for the person who has to fix
 * it, so unlike an arbitrary exception it is safe to hand to the dashboard as it is.
 */
export class ConfigError extends Error {
  /** @override */
  name = 'ConfigError';
}

/**
 * @param {string} [startDir]
 * @returns {LoadedConfig}
 */
export function loadConfig(startDir = process.cwd()) {
  const path = findConfigFile(startDir);
  if (!path) return { config: defaultConfig(), root: resolve(startDir), exists: false };
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(CONFIG_ERRORS.unreadable(path, error instanceof Error ? error.message : String(error)));
  }
  const shape = configPatchProblem(raw);
  if (shape) throw new ConfigError(shape);
  const config = mergeConfig(defaultConfig(), /** @type {ConfigPatch} */ (raw));
  const problem = projectDirProblem(dirname(path), config);
  if (problem) throw new ConfigError(problem);
  return { config, root: dirname(path), path, exists: true };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** @param {unknown} value */
const isString = (value) => typeof value === 'string';
/** @param {unknown} value */
const isStringList = (value) => Array.isArray(value) && value.every(isString);
/**
 * An origin and nothing more: generate resolves every route against it, so a path here would be
 * silently dropped rather than honoured.
 *
 * @param {unknown} value
 */
const isHttpOrigin = (value) => {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.pathname === '/' && !url.search && !url.hash && !url.username;
};
/**
 * @param {number} min
 * @param {number} max
 * @returns {(value: unknown) => boolean}
 */
const whole = (min, max) => (value) =>
  Number.isInteger(value) && /** @type {number} */ (value) >= min && /** @type {number} */ (value) <= max;

/**
 * Every field a patch may set, with what it has to be. The bounds are wide on purpose: they are there
 * to catch a typo like a `maxPages` of 1e12, which removes the cap on a large site, and nothing more.
 * `opengeo-prod` loads this file on boot and never crawls, so a tight bound here would be a way to
 * take a site down over a setting prod does not even read. `ai.provider`
 * is only checked for being a string here, because naming the providers would mean importing the
 * catalogue into a module `opengeo-prod` loads; the catalogue refuses an unknown one when it is used.
 *
 * @type {Array<[section: string | undefined, key: string, expected: string, ok: (value: unknown) => boolean]>}
 */
const FIELD_RULES = [
  [undefined, 'site', 'a URL string', isString],
  [undefined, 'publicOrigin', 'an http(s) origin like "https://example.com"', isHttpOrigin],
  [undefined, 'publicDir', 'a folder name', isString],
  [undefined, 'internalDir', 'a folder name', isString],
  [undefined, 'extraRoutes', 'a list of paths', isStringList],
  ['crawl', 'maxPages', 'a whole number from 1 to 100000', whole(1, 100_000)],
  ['crawl', 'maxDepth', 'a whole number from 0 to 100', whole(0, 100)],
  ['crawl', 'exclude', 'a list of path prefixes', isStringList],
  ['generate', 'tier', '"free" or "ai"', (value) => value === 'free' || value === 'ai'],
  ['generate', 'minWords', 'a whole number from 0 to 100000', whole(0, 100_000)],
  ['bots', 'markdownRouting', 'a list of crawler names', isStringList],
  ['bots', 'blocked', 'a list of crawler names', isStringList],
  ['bots', 'custom', 'a list of crawlers', Array.isArray],
  ['ai', 'provider', 'a provider id', isString],
  ['ai', 'model', 'a model id', isString],
  ['ai', 'baseUrl', 'a URL string', isString],
  ['ai', 'api', 'an API shape', isString],
  ['ai', 'auth', 'an auth style', isString],
  ['ai', 'headers', 'an object of header names to string values', (value) => isObject(value) && Object.values(value).every(isString)],
];

/**
 * Why a config file or an API patch is not one OpenGEO can use, or nothing if it is. Only the fields
 * present are checked, so a patch of one field is fine; unknown fields are left alone, so a config
 * written by a newer version still loads. Directory confinement is `projectDirProblem`'s job.
 *
 * @param {unknown} patch
 * @returns {string | undefined}
 */
export function configPatchProblem(patch) {
  if (!isObject(patch)) return CONFIG_ERRORS.badField('The config', 'a JSON object', patch);
  for (const section of ['crawl', 'generate', 'bots', 'ai']) {
    if (patch[section] !== undefined && !isObject(patch[section])) {
      return CONFIG_ERRORS.badField(section, 'an object', patch[section]);
    }
  }
  for (const [section, key, expected, ok] of FIELD_RULES) {
    const holder = section ? /** @type {Record<string, unknown> | undefined} */ (patch[section]) : patch;
    const value = holder?.[key];
    if (value !== undefined && !ok(value)) return CONFIG_ERRORS.badField(section ? `${section}.${key}` : key, expected, value);
  }
  return undefined;
}

/**
 * Why `publicDir` or `internalDir` would put OpenGEO outside the project, or nothing if both are fine.
 *
 * Generate writes into both, the dashboard reads out of the first, and the project root holds `.env`.
 * A web root of `.` once let the dashboard hand the API key to anybody who asked for `.env`, and
 * `/etc` let it read the host's files. Strictly inside, never equal: the root is where the key lives.
 *
 * @param {string} root
 * @param {Pick<OpenGeoConfig, 'publicDir' | 'internalDir'>} config
 * @returns {string | undefined}
 */
export function projectDirProblem(root, config) {
  const base = resolve(root);
  for (const field of /** @type {const} */ (['publicDir', 'internalDir'])) {
    /** @type {unknown} */
    const value = config[field];
    const inside = typeof value === 'string' && value.trim() !== '' && resolve(base, value).startsWith(base + sep);
    if (!inside) return CONFIG_ERRORS.dirOutsideProject(field, value, base);
  }
  return undefined;
}

/**
 * @param {string} root
 * @param {OpenGeoConfig} config
 * @returns {string}
 */
export function saveConfig(root, config) {
  const problem = projectDirProblem(root, config);
  if (problem) throw new ConfigError(problem);
  const path = join(root, CONFIG_FILENAME);
  writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

/**
 * What a caller may hand to `mergeConfig`: any subset, down to a single field of a single section.
 *
 * `Partial<OpenGeoConfig>` was the old signature and it lied. It made every section all-or-nothing
 * while the merge below has always accepted a fragment of one, so the honest types had to be
 * written out by hand for a config file, an API patch and a settings screen to say the same thing.
 *
 * @typedef {Partial<Omit<OpenGeoConfig, 'crawl' | 'generate' | 'bots' | 'ai'>> & {
 *   crawl?: Partial<OpenGeoConfig['crawl']>;
 *   generate?: Partial<OpenGeoConfig['generate']>;
 *   bots?: Partial<OpenGeoConfig['bots']>;
 *   ai?: Partial<OpenGeoConfig['ai']>;
 * }} ConfigPatch
 */

/**
 * Shallow-per-section merge, so a partial config file only overrides what it actually names.
 *
 * @param {OpenGeoConfig} base
 * @param {ConfigPatch} patch
 * @returns {OpenGeoConfig}
 */
export function mergeConfig(base, patch) {
  return {
    ...base,
    ...patch,
    crawl: { ...base.crawl, ...(patch.crawl ?? {}) },
    generate: { ...base.generate, ...(patch.generate ?? {}) },
    bots: { ...base.bots, ...(patch.bots ?? {}) },
    ai: mergeAi(base.ai, patch.ai),
  };
}

/**
 * The `ai` block is the one section a shallow merge gets wrong.
 *
 * `baseUrl`, `api`, `auth` and `headers` describe one specific endpoint. Carrying them across a
 * change of provider would point a freshly entered OpenAI key at whatever host the previous
 * `custom` provider named, which is exactly the mistake §11 exists to prevent. Changing the
 * provider therefore clears them unless the same patch restates them.
 *
 * @param {OpenGeoConfig['ai']} base
 * @param {Partial<OpenGeoConfig['ai']> | undefined} patch
 * @returns {OpenGeoConfig['ai']}
 */
function mergeAi(base, patch) {
  if (!patch) return { ...base };
  /** @type {OpenGeoConfig['ai']} */
  const merged = { ...base, ...patch };
  if (patch.provider && patch.provider !== base.provider) {
    // The old provider's model id means nothing to the new one. Blank reads as "the provider's own
    // default" everywhere a model is resolved; the catalogue holding it cannot be imported here.
    if (patch.model === undefined) merged.model = '';
    if (patch.baseUrl === undefined) delete merged.baseUrl;
    if (patch.api === undefined) delete merged.api;
    if (patch.auth === undefined) delete merged.auth;
    if (patch.headers === undefined) delete merged.headers;
  }
  return merged;
}

/**
 * The endpoint overrides a project's config carries, in the shape the provider catalogue wants.
 *
 * @param {Pick<OpenGeoConfig, 'ai'>} config
 * @returns {ProviderOverrides}
 */
export function providerOverridesOf(config) {
  return { baseUrl: config.ai.baseUrl, api: config.ai.api, auth: config.ai.auth, headers: config.ai.headers };
}

/**
 * The origin generated URLs should name: `publicOrigin` when the project sets one, otherwise the
 * origin that was crawled.
 *
 * @param {Pick<OpenGeoConfig, 'publicOrigin'>} config
 * @param {string} crawled
 * @returns {string}
 */
export function publicOriginOf(config, crawled) {
  return new URL(config.publicOrigin ?? crawled).origin;
}

/**
 * Whether a URL is on this machine, so nobody the generated files are for could follow it.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isLoopbackUrl(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * @param {Pick<LoadedConfig, 'root' | 'config'>} loaded
 * @returns {string}
 */
export function publicDirPath(loaded) {
  return resolve(loaded.root, loaded.config.publicDir);
}

/**
 * @param {Pick<LoadedConfig, 'root' | 'config'>} loaded
 * @returns {string}
 */
export function internalDirPath(loaded) {
  return resolve(loaded.root, loaded.config.internalDir);
}
