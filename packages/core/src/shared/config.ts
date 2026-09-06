import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CustomBotInput } from './bots.js';
import { DEFAULT_MARKDOWN_ROUTING } from './bots.js';
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

export function loadConfig(startDir = process.cwd()): LoadedConfig {
  const path = findConfigFile(startDir);
  if (!path) return { config: defaultConfig(), root: resolve(startDir), exists: false };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ConfigPatch;
  return { config: mergeConfig(defaultConfig(), raw), root: dirname(path), path, exists: true };
}

export function saveConfig(root: string, config: OpenGeoConfig): string {
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
