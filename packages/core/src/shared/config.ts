import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CustomBotInput } from './bots.js';
import { DEFAULT_MARKDOWN_ROUTING } from './bots.js';

export const CONFIG_FILENAME = 'opengeo.config.json';

export type AiProvider = 'anthropic' | 'openai' | 'gemini';
export const AI_PROVIDERS: AiProvider[] = ['anthropic', 'openai', 'gemini'];

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
  ai: {
    provider: AiProvider;
    model: string;
  };
}

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
};

export function defaultConfig(site = 'http://localhost:3000'): OpenGeoConfig {
  return {
    site,
    publicDir: 'public',
    internalDir: '.opengeo',
    extraRoutes: [],
    crawl: { maxPages: 200, maxDepth: 4, exclude: [] },
    generate: { tier: 'free', minWords: 40 },
    bots: { markdownRouting: [...DEFAULT_MARKDOWN_ROUTING], blocked: [], custom: [] },
    ai: { provider: 'anthropic', model: DEFAULT_MODELS.anthropic },
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
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<OpenGeoConfig>;
  return { config: mergeConfig(defaultConfig(), raw), root: dirname(path), path, exists: true };
}

export function saveConfig(root: string, config: OpenGeoConfig): string {
  const path = join(root, CONFIG_FILENAME);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return path;
}

/** Shallow-per-section merge, so a partial config file only overrides what it actually names. */
export function mergeConfig(base: OpenGeoConfig, patch: Partial<OpenGeoConfig>): OpenGeoConfig {
  return {
    ...base,
    ...patch,
    crawl: { ...base.crawl, ...(patch.crawl ?? {}) },
    generate: { ...base.generate, ...(patch.generate ?? {}) },
    bots: { ...base.bots, ...(patch.bots ?? {}) },
    ai: { ...base.ai, ...(patch.ai ?? {}) },
  };
}

export function publicDirPath(loaded: Pick<LoadedConfig, 'root' | 'config'>): string {
  return resolve(loaded.root, loaded.config.publicDir);
}

export function internalDirPath(loaded: Pick<LoadedConfig, 'root' | 'config'>): string {
  return resolve(loaded.root, loaded.config.internalDir);
}
