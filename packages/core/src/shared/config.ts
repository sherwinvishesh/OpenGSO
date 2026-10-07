import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { CustomBotInput } from './bots.js';
import { DEFAULT_MARKDOWN_ROUTING } from './bots.js';
import { CONFIG_ERRORS } from './errors.js';
import type { AiProvider, ProviderApi, ProviderAuth, ProviderOverrides } from './providers.js';

// Types only, and deliberately: `prod` loads the config on every boot, and a value import from the
// catalogue would drag twelve provider endpoints and twelve key variable names into a bundle whose
// whole promise is that it contains no AI code. `check:bundles` fails the build if that happens
// again. Callers that need PROVIDERS, providerInfo or DEFAULT_MODELS import './providers.js'.

export const CONFIG_FILENAME = 'opengeo.config.json';

export interface OpenGeoConfig {
  /** Base URL the project is generated/tested against. Also the default for a bare `opengeo test`. */
  site: string;
  /** Web root, relative to the project. Everything generate writes lands here (twins in `md/`). */
  publicDir: string;
  /** Bookkeeping that must NOT be web-served: the manifest and the content-hash cache. */
  internalDir: string;
  /** Routes the `<a href>` crawl can't reach. The escape hatch for §17's route-discovery ceiling. */
  extraRoutes: string[];
  crawl: {
    maxPages: number;
    maxDepth: number;
    /** Path prefixes to skip, in addition to the built-in asset/anchor filtering. */
    exclude: string[];
  };
  generate: {
    /** 'free' is algorithmic and needs no key. 'ai' is BYOK and local-machine-only. */
    tier: 'free' | 'ai';
    /** Below this word count an extracted page gets a low-content warning (§17 CSR ceiling). */
    minWords: number;
  };
  bots: {
    /**
     * Lever 1 (§7): which AI agents receive the markdown twin. Never blocks anyone - an unlisted
     * bot simply sees the normal site.
     */
    markdownRouting: string[];
    /**
     * Lever 2 (§7): a separate, opt-in list of bots to disallow in robots.txt. Empty by default;
     * blocking is never the default.
     */
    blocked: string[];
    /**
     * Crawlers this project knows about that OpenGEO's shipped list does not: an in-house agent, or
     * an AI product newer than the installed version. They behave exactly like built-in entries -
     * both levers apply to them - and naming one in `markdownRouting` is what turns it on.
     */
    custom: CustomBotInput[];
  };
  /**
   * Which AI tool `generate --tier ai` and `test --content` talk to.
   *
   * The four optional fields are the "bring your own provider" surface: name any endpoint that
   * speaks one of the three API shapes and OpenGEO will use it, with no code change and no wait for
   * a release. They are honoured for built-in providers too, because the usual reason to set
   * `baseUrl` is a company gateway mirroring a vendor's API rather than a brand-new vendor.
   */
  ai: {
    provider: AiProvider;
    model: string;
    /** Overrides the catalogue's endpoint. Required when provider is `custom`. */
    baseUrl?: string;
    /** Which wire format that endpoint speaks. Defaults to the provider's own. */
    api?: ProviderApi;
    /** How the key is attached. Defaults to the provider's own. `none` sends no key at all. */
    auth?: ProviderAuth;
    /** Extra request headers the endpoint needs, e.g. a gateway's tenant id. Never the key. */
    headers?: Record<string, string>;
  };
}

export function defaultConfig(site = 'http://localhost:3000'): OpenGeoConfig {
  return {
    site,
    publicDir: 'public',
    internalDir: '.opengeo',
    extraRoutes: [],
    crawl: { maxPages: 200, maxDepth: 4, exclude: [] },
    generate: { tier: 'free', minWords: 40 },
    bots: { markdownRouting: [...DEFAULT_MARKDOWN_ROUTING], blocked: [], custom: [] },
    // Written out rather than read from the catalogue, for the bundling reason above. It is not
    // free-floating: providers.test.ts asserts it still matches providerInfo('anthropic').
    ai: { provider: 'anthropic', model: 'claude-sonnet-5' },
  };
}

export interface LoadedConfig {
  config: OpenGeoConfig;
  /** Absolute path of the project root (the directory holding opengeo.config.json, or cwd). */
  root: string;
  /** Absolute path of the config file, if one was found on disk. */
  path?: string;
  exists: boolean;
}

/** Walk up from `startDir` looking for opengeo.config.json, stopping at the filesystem root. */
export function findConfigFile(startDir = process.cwd()): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * A config file or patch OpenGEO will not use. The message is written for the person who has to fix
 * it, so unlike an arbitrary exception it is safe to hand to the dashboard as it is.
 */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(startDir = process.cwd()): LoadedConfig {
  const path = findConfigFile(startDir);
  if (!path) return { config: defaultConfig(), root: resolve(startDir), exists: false };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(CONFIG_ERRORS.unreadable(path, error instanceof Error ? error.message : String(error)));
  }
  const shape = configPatchProblem(raw);
  if (shape) throw new ConfigError(shape);
  const config = mergeConfig(defaultConfig(), raw as ConfigPatch);
  const problem = projectDirProblem(dirname(path), config);
  if (problem) throw new ConfigError(problem);
  return { config, root: dirname(path), path, exists: true };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown) => typeof value === 'string';
const isStringList = (value: unknown) => Array.isArray(value) && value.every(isString);
const whole = (min: number, max: number) => (value: unknown) =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/**
 * Every field a patch may set, with what it has to be. The bounds are wide on purpose: they are there
 * to catch a typo like a `maxPages` of 1e12, which removes the cap on a large site, and nothing more.
 * `opengeo-prod` loads this file on boot and never crawls, so a tight bound here would be a way to
 * take a site down over a setting prod does not even read. `ai.provider`
 * is only checked for being a string here, because naming the providers would mean importing the
 * catalogue into a module `opengeo-prod` loads; the catalogue refuses an unknown one when it is used.
 */
const FIELD_RULES: Array<[section: string | undefined, key: string, expected: string, ok: (value: unknown) => boolean]> = [
  [undefined, 'site', 'a URL string', isString],
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
 */
export function configPatchProblem(patch: unknown): string | undefined {
  if (!isObject(patch)) return CONFIG_ERRORS.badField('The config', 'a JSON object', patch);
  for (const section of ['crawl', 'generate', 'bots', 'ai']) {
    if (patch[section] !== undefined && !isObject(patch[section])) {
      return CONFIG_ERRORS.badField(section, 'an object', patch[section]);
    }
  }
  for (const [section, key, expected, ok] of FIELD_RULES) {
    const holder = section ? (patch[section] as Record<string, unknown> | undefined) : patch;
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
 */
export function projectDirProblem(root: string, config: Pick<OpenGeoConfig, 'publicDir' | 'internalDir'>): string | undefined {
  const base = resolve(root);
  for (const field of ['publicDir', 'internalDir'] as const) {
    const value: unknown = config[field];
    const inside = typeof value === 'string' && value.trim() !== '' && resolve(base, value).startsWith(base + sep);
    if (!inside) return CONFIG_ERRORS.dirOutsideProject(field, value, base);
  }
  return undefined;
}

export function saveConfig(root: string, config: OpenGeoConfig): string {
  const problem = projectDirProblem(root, config);
  if (problem) throw new ConfigError(problem);
  const path = join(root, CONFIG_FILENAME);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * What a caller may hand to `mergeConfig`: any subset, down to a single field of a single section.
 *
 * `Partial<OpenGeoConfig>` was the old signature and it lied. It made every section all-or-nothing
 * while the merge below has always accepted a fragment of one, so the honest types had to be
 * written out by hand for a config file, an API patch and a settings screen to say the same thing.
 */
export interface ConfigPatch extends Partial<Omit<OpenGeoConfig, 'crawl' | 'generate' | 'bots' | 'ai'>> {
  crawl?: Partial<OpenGeoConfig['crawl']>;
  generate?: Partial<OpenGeoConfig['generate']>;
  bots?: Partial<OpenGeoConfig['bots']>;
  ai?: Partial<OpenGeoConfig['ai']>;
}

/** Shallow-per-section merge, so a partial config file only overrides what it actually names. */
export function mergeConfig(base: OpenGeoConfig, patch: ConfigPatch): OpenGeoConfig {
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
 */
function mergeAi(base: OpenGeoConfig['ai'], patch: Partial<OpenGeoConfig['ai']> | undefined): OpenGeoConfig['ai'] {
  if (!patch) return { ...base };
  const merged: OpenGeoConfig['ai'] = { ...base, ...patch };
  if (patch.provider && patch.provider !== base.provider) {
    if (patch.baseUrl === undefined) delete merged.baseUrl;
    if (patch.api === undefined) delete merged.api;
    if (patch.auth === undefined) delete merged.auth;
    if (patch.headers === undefined) delete merged.headers;
  }
  return merged;
}

/** The endpoint overrides a project's config carries, in the shape the provider catalogue wants. */
export function providerOverridesOf(config: Pick<OpenGeoConfig, 'ai'>): ProviderOverrides {
  return { baseUrl: config.ai.baseUrl, api: config.ai.api, auth: config.ai.auth, headers: config.ai.headers };
}

export function publicDirPath(loaded: Pick<LoadedConfig, 'root' | 'config'>): string {
  return resolve(loaded.root, loaded.config.publicDir);
}

export function internalDirPath(loaded: Pick<LoadedConfig, 'root' | 'config'>): string {
  return resolve(loaded.root, loaded.config.internalDir);
}
