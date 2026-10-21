import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './fs.js';
import { dirname, join, resolve, sep } from 'node:path';
import { DEFAULT_MARKDOWN_ROUTING } from './bots.js';
import { CONFIG_ERRORS } from './errors.js';
import { frameworkWebRoot } from './web-root.js';
import { siteBaseOf } from './routes.js';
import { editDistance } from './edit-distance.js';

/**
 * @import { CustomBotInput } from './bots.js'
 * @import { AiProvider, ProviderApi, ProviderAuth, ProviderOverrides } from './providers.js'
 */

/**
 * Defined in `api-types.js` with every other shape the dashboard reads, and re-exported here.
 *
 * @typedef {import('./api-types.js').OpenGsoConfig} OpenGsoConfig
 */

// Types only, and deliberately: `prod` loads the config on every boot, and a value import from the
// catalogue would drag twelve provider endpoints and twelve key variable names into a bundle whose
// whole promise is that it contains no AI code. `check:bundles` fails the build if that happens
// again. Callers that need PROVIDERS, providerInfo or DEFAULT_MODELS import './providers.js'.

export const CONFIG_FILENAME = 'opengso.config.json';

/**
 * @param {string} [site]
 * @returns {OpenGsoConfig}
 */
export function defaultConfig(site = 'http://localhost:3000') {
  return {
    site,
    publicDir: 'public',
    internalDir: '.opengso',
    extraRoutes: [],
    crawl: { maxPages: 200, maxDepth: 4, exclude: [] },
    generate: { tier: 'free', minWords: 40 },
    bots: { markdownRouting: [...DEFAULT_MARKDOWN_ROUTING], blocked: [], custom: [] },
    // Written out rather than read from the catalogue, for the bundling reason above. It is not
    // free-floating: providers.test.js asserts it still matches providerInfo('anthropic').
    ai: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  };
}

/**
 * @typedef {object} LoadedConfig
 * @property {OpenGsoConfig} config
 * @property {string} root Absolute path of the project root (the directory holding
 *   opengso.config.json, or cwd).
 * @property {string} [path] Absolute path of the config file, if one was found on disk.
 * @property {boolean} exists
 * @property {string} [webRootWhy] Set when `publicDir` came from the framework in package.json
 *   rather than the default, because there is no config file or the file does not name it, saying
 *   why, for the one line that tells the user where their files went.
 * @property {Array<{ key: string; suggestion?: string }>} [unknownKeys] Keys in the file OpenGSO does
 *   not read, from `unknownConfigKeys`. Absent when there are none.
 */

/**
 * Walk up from `startDir` looking for opengso.config.json, but never past the project.
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
 * A config file or patch OpenGSO will not use. The message is written for the person who has to fix
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
  if (!path) {
    // No config file: the framework's own web root, so that a first `opengso generate` on a
    // SvelteKit app writes to static/ rather than a public/ nothing serves, and test and prod, which
    // load the same way, look for the twins where generate put them.
    const root = resolve(startDir);
    const framework = frameworkWebRoot(root);
    const config = defaultConfig();
    if (!framework || framework.dir === config.publicDir) return { config, root, exists: false };
    return { config: { ...config, publicDir: framework.dir }, root, exists: false, webRootWhy: framework.why };
  }
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(CONFIG_ERRORS.unreadable(path, error instanceof Error ? error.message : String(error)));
  }
  const shape = configPatchProblem(raw);
  if (shape) throw new ConfigError(shape);
  const patch = /** @type {ConfigPatch} */ (raw);
  let config = mergeConfig(defaultConfig(), patch);
  // A hand-written file that names an origin and nothing else still gets the framework's folder:
  // the default public/ is one SvelteKit never serves, and VitePress serves docs/public/.
  const framework = patch.publicDir === undefined ? frameworkWebRoot(dirname(path)) : undefined;
  const webRootWhy = framework && framework.dir !== config.publicDir ? framework.why : undefined;
  if (framework && webRootWhy) config = { ...config, publicDir: framework.dir };
  const problem = projectDirProblem(dirname(path), config);
  if (problem) throw new ConfigError(problem);
  const unknownKeys = unknownConfigKeys(raw);
  return {
    config,
    root: dirname(path),
    path,
    exists: true,
    ...(webRootWhy ? { webRootWhy } : {}),
    ...(unknownKeys.length ? { unknownKeys } : {}),
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** @param {unknown} value */
const isAiParams = (value) =>
  isObject(value) && Object.keys(value).every((key) => !(/** @type {readonly string[]} */ (RESERVED_AI_PARAMS)).includes(key));
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
  return (url.protocol === 'http:' || url.protocol === 'https:') && !url.search && !url.hash && !url.username;
};
/**
 * @param {number} min
 * @param {number} max
 * @returns {(value: unknown) => boolean}
 */
const whole = (min, max) => (value) =>
  Number.isInteger(value) && /** @type {number} */ (value) >= min && /** @type {number} */ (value) <= max;

/**
 * Request-body fields `ai.params` may not set, because the request is built around them: the model,
 * the page itself, and a stream the wire code does not read. Exported so the wire skips the same
 * names the loader refuses.
 */
export const RESERVED_AI_PARAMS = /** @type {const} */ (['model', 'messages', 'system', 'contents', 'systemInstruction', 'stream']);

/**
 * Every field a patch may set, with what it has to be. The bounds are wide on purpose: they are there
 * to catch a typo like a `maxPages` of 1e12, which removes the cap on a large site, and nothing more.
 * `opengso-prod` loads this file on boot and never crawls, so a tight bound here would be a way to
 * take a site down over a setting prod does not even read. `ai.provider`
 * is only checked for being a string here, because naming the providers would mean importing the
 * catalogue into a module `opengso-prod` loads; the catalogue refuses an unknown one when it is used.
 *
 * @type {Array<[section: string | undefined, key: string, expected: string, ok: (value: unknown) => boolean]>}
 */
const FIELD_RULES = [
  [undefined, 'site', 'a URL string', isString],
  [undefined, 'publicOrigin', 'an http(s) address like "https://example.com", or "https://user.github.io/repo" for a site in a folder of its host', isHttpOrigin],
  [undefined, 'publicDir', 'a folder name', isString],
  [undefined, 'internalDir', 'a folder name', isString],
  [undefined, 'extraRoutes', 'a list of paths', isStringList],
  ['crawl', 'maxPages', 'a whole number from 1 to 100000', whole(1, 100_000)],
  ['crawl', 'maxDepth', 'a whole number from 0 to 100', whole(0, 100)],
  ['crawl', 'exclude', 'a list of path prefixes', isStringList],
  ['generate', 'tier', '"free" or "ai"', (value) => value === 'free' || value === 'ai'],
  ['generate', 'minWords', 'a whole number from 0 to 100000', whole(0, 100_000)],
  ['generate', 'source', '"url" or "files"', (value) => value === 'url' || value === 'files'],
  ['bots', 'markdownRouting', 'a list of crawler names', isStringList],
  ['bots', 'blocked', 'a list of crawler names', isStringList],
  ['bots', 'custom', 'a list of crawlers', Array.isArray],
  ['ai', 'provider', 'a provider id', isString],
  ['ai', 'model', 'a model id', isString],
  ['ai', 'baseUrl', 'a URL string', isString],
  ['ai', 'api', 'an API shape', isString],
  ['ai', 'auth', 'an auth style', isString],
  ['ai', 'headers', 'an object of header names to string values', (value) => isObject(value) && Object.values(value).every(isString)],
  ['ai', 'params', `an object of extra request fields, without ${RESERVED_AI_PARAMS.join(', ')}`, isAiParams],
];

/**
 * Why a config file or an API patch is not one OpenGSO can use, or nothing if it is. Only the fields
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

/** Keys a config may hold that no rule above checks: an editor's schema pointer. */
const UNCHECKED_KEYS = ['$schema'];

/** @param {string} name */
const squash = (name) => name.toLowerCase().replace(/[-_]/g, '');

/**
 * The keys of a config that OpenGSO does not read, each with the key it was probably meant to be.
 *
 * `configPatchProblem` leaves these alone so that a config written by a newer version still loads,
 * which also means a `publicdir` or a `crawl.maxpages` is ignored without a word and the run
 * quietly uses the default. This is what says so. A suggestion is only made for a key within a
 * couple of edits of one that exists in the same place, ignoring case, dashes and underscores, or
 * for the end of one, since the flags are `--depth` and `--max-pages` and the fields `maxDepth` and
 * `maxPages`.
 *
 * @param {unknown} raw
 * @returns {Array<{ key: string; suggestion?: string }>}
 */
export function unknownConfigKeys(raw) {
  if (!isObject(raw)) return [];
  /** @type {Map<string | undefined, string[]>} */
  const known = new Map([[undefined, [...UNCHECKED_KEYS, 'crawl', 'generate', 'bots', 'ai']]]);
  for (const [section, key] of FIELD_RULES) known.set(section, [...(known.get(section) ?? []), key]);
  /** @type {Array<{ key: string; suggestion?: string }>} */
  const unknown = [];
  for (const [section, names] of known) {
    const holder = section === undefined ? raw : raw[section];
    if (!isObject(holder)) continue;
    for (const key of Object.keys(holder)) {
      if (names.includes(key)) continue;
      const wanted = squash(key);
      const near = names
        .map((name) => ({ name, distance: wanted.length >= 4 && squash(name).endsWith(wanted) ? 0 : editDistance(wanted, squash(name)) }))
        .filter(({ name, distance }) => distance <= Math.min(2, Math.floor(name.length / 3)))
        .sort((a, b) => a.distance - b.distance)[0];
      const path = (/** @type {string} */ name) => (section ? `${section}.${name}` : name);
      unknown.push({ key: path(key), ...(near ? { suggestion: path(near.name) } : {}) });
    }
  }
  return unknown;
}

/**
 * Why `publicDir` or `internalDir` would put OpenGSO outside the project, or nothing if both are fine.
 *
 * Generate writes into both, the dashboard reads out of the first, and the project root holds `.env`.
 * A web root of `.` once let the dashboard hand the API key to anybody who asked for `.env`, and
 * `/etc` let it read the host's files. Strictly inside, never equal: the root is where the key lives.
 *
 * @param {string} root
 * @param {Pick<OpenGsoConfig, 'publicDir' | 'internalDir'>} config
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
 * @param {OpenGsoConfig} config
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
 * `Partial<OpenGsoConfig>` was the old signature and it lied. It made every section all-or-nothing
 * while the merge below has always accepted a fragment of one, so the honest types had to be
 * written out by hand for a config file, an API patch and a settings screen to say the same thing.
 *
 * @typedef {Partial<Omit<OpenGsoConfig, 'crawl' | 'generate' | 'bots' | 'ai'>> & {
 *   crawl?: Partial<OpenGsoConfig['crawl']>;
 *   generate?: Partial<OpenGsoConfig['generate']>;
 *   bots?: Partial<OpenGsoConfig['bots']>;
 *   ai?: Partial<OpenGsoConfig['ai']>;
 * }} ConfigPatch
 */

/**
 * Shallow-per-section merge, so a partial config file only overrides what it actually names.
 *
 * @param {OpenGsoConfig} base
 * @param {ConfigPatch} patch
 * @returns {OpenGsoConfig}
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
 * `baseUrl`, `api`, `auth`, `headers` and `params` describe one specific endpoint. Carrying them
 * across a change of provider would point a freshly entered OpenAI key at whatever host the previous
 * `custom` provider named, which is exactly the mistake §11 exists to prevent, or send one vendor's
 * flags to another that refuses them. Changing the provider therefore clears them unless the same
 * patch restates them.
 *
 * @param {OpenGsoConfig['ai']} base
 * @param {Partial<OpenGsoConfig['ai']> | undefined} patch
 * @returns {OpenGsoConfig['ai']}
 */
function mergeAi(base, patch) {
  if (!patch) return { ...base };
  /** @type {OpenGsoConfig['ai']} */
  const merged = { ...base, ...patch };
  if (patch.provider && patch.provider !== base.provider) {
    // The old provider's model id means nothing to the new one. Blank reads as "the provider's own
    // default" everywhere a model is resolved; the catalogue holding it cannot be imported here.
    if (patch.model === undefined) merged.model = '';
    if (patch.baseUrl === undefined) delete merged.baseUrl;
    if (patch.api === undefined) delete merged.api;
    if (patch.auth === undefined) delete merged.auth;
    if (patch.headers === undefined) delete merged.headers;
    if (patch.params === undefined) delete merged.params;
  }
  return merged;
}

/**
 * The endpoint overrides a project's config carries, in the shape the provider catalogue wants.
 *
 * @param {Pick<OpenGsoConfig, 'ai'>} config
 * @returns {ProviderOverrides}
 */
export function providerOverridesOf(config) {
  return { baseUrl: config.ai.baseUrl, api: config.ai.api, auth: config.ai.auth, headers: config.ai.headers, params: config.ai.params };
}

/**
 * The address generated URLs are built on: `publicOrigin` when the project sets one, with the folder
 * it may name (`https://user.github.io/repo`), otherwise the origin that was crawled.
 *
 * @param {Pick<OpenGsoConfig, 'publicOrigin'>} config
 * @param {string} crawled
 * @returns {string}
 */
export function publicOriginOf(config, crawled) {
  return config.publicOrigin ? siteBaseOf(config.publicOrigin) : new URL(crawled).origin;
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
