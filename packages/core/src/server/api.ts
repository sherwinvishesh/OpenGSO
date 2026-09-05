import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createAiEnhancer } from '../generate/ai.js';
import type { EnhanceInput, EnhanceOutput } from '../generate/generate.js';
import { readManifest } from '../generate/manifest.js';
import { generateSite } from '../generate/site.js';
import { verifyProd } from '../prod/verify.js';
import { AI_BOTS } from '../shared/bots.js';
import type { AiProvider, OpenGeoConfig } from '../shared/config.js';
import {
  AI_PROVIDERS,
  CONFIG_FILENAME,
  DEFAULT_MODELS,
  internalDirPath,
  loadConfig,
  mergeConfig,
  publicDirPath,
  saveConfig,
} from '../shared/config.js';
import { ENV_FILENAME, KEY_VAR, MODEL_VAR, PROVIDER_VAR, ensureEnvGitignored, isCI, readCredentials, writeEnvVars } from '../shared/env.js';
import { ERRORS } from '../shared/errors.js';
import { parseUrl } from '../shared/http.js';
import { testUrl } from '../test/index.js';
import { reviewQuality } from '../test/quality.js';

/**
 * The local JSON API behind `opengeo start` (idea.md §8).
 *
 * Every endpoint is a thin wrapper over the exact function the CLI calls. That is the whole design
 * constraint: the dashboard must never become a second implementation of the pipeline, because two
 * implementations means two sets of bugs and only one of them gets tested.
 *
 * Nothing here reaches the network except the calls the user explicitly triggered, and the API key
 * is never included in a response. `GET /api/state` reports that a key exists, which provider it
 * belongs to and which file it came from - never the value.
 */

export interface ApiRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface ApiOptions {
  /** Project root. Fixed for the lifetime of the server: the browser cannot ask for another. */
  root: string;
  version: string;
  packageName: string;
}

const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const bad = (message: string, extra: Record<string, unknown> = {}): ApiResponse => ({
  status: 400,
  body: { error: message, ...extra },
});

export async function handleApi(request: ApiRequest, options: ApiOptions): Promise<ApiResponse> {
  const { method, path } = request;
  const route = `${method} ${path}`;

  switch (route) {
    case 'GET /api/state':
      return ok(readState(options));
    case 'GET /api/bots':
      return ok({ bots: AI_BOTS });
    case 'POST /api/config':
      return saveConfigPatch(request.body, options);
    case 'POST /api/test':
      return await runTest(request.body, options);
    case 'POST /api/generate':
      return await runGenerate(request.body, options);
    case 'POST /api/prod-test':
      return await runProdTest(request.body, options);
    case 'POST /api/key':
      return saveKey(request.body, options);
    case 'POST /api/file':
      return readFileRoute(request.body, options);
    default:
      return { status: 404, body: { error: `No such endpoint: ${route}` } };
  }
}

// -- state ---------------------------------------------------------------------------------------

export interface StateResponse {
  root: string;
  configPath: string;
  configExists: boolean;
  config: OpenGeoConfig;
  version: string;
  packageName: string;
  /** Presence only. The value never crosses this boundary, not even to localhost. */
  key: { present: boolean; provider?: AiProvider; model?: string; source?: string; path: string };
  ci: boolean;
  providers: AiProvider[];
  defaultModels: Record<AiProvider, string>;
  manifest?: {
    generatedAt: string;
    site: string;
    pages: Array<{ route: string; title: string; tokens: number; lastUpdated: string; tier: string }>;
  };
  publicDir: string;
  internalDir: string;
}

function readState(options: ApiOptions): StateResponse {
  const loaded = loadConfig(options.root);
  const credentials = readCredentials(options.root);
  // readManifest returns an empty manifest rather than undefined when nothing has been generated,
  // and that empty one carries a `generatedAt` of right now. Reporting it would tell the dashboard
  // a project was generated seconds ago when in fact it never has been, so it is dropped here.
  const read = readManifest(internalDirPath(loaded));
  const manifest = Object.keys(read.pages).length > 0 ? read : undefined;

  return {
    root: loaded.root,
    configPath: join(loaded.root, CONFIG_FILENAME),
    configExists: loaded.exists,
    config: loaded.config,
    version: options.version,
    packageName: options.packageName,
    key: {
      present: Boolean(credentials),
      provider: credentials?.provider,
      model: credentials?.model,
      source: credentials?.source,
      path: join(loaded.root, ENV_FILENAME),
    },
    ci: isCI(),
    providers: AI_PROVIDERS,
    defaultModels: DEFAULT_MODELS,
    manifest: manifest
      ? {
          generatedAt: manifest.generatedAt,
          site: manifest.site,
          pages: Object.values(manifest.pages).map((page) => ({
            route: page.route,
            title: page.title,
            tokens: page.tokens,
            lastUpdated: page.lastUpdated,
            tier: page.tier,
          })),
        }
      : undefined,
    publicDir: publicDirPath(loaded),
    internalDir: internalDirPath(loaded),
  };
}

// -- config --------------------------------------------------------------------------------------

function saveConfigPatch(body: unknown, options: ApiOptions): ApiResponse {
  const patch = body as Partial<OpenGeoConfig> | null;
  if (!patch || typeof patch !== 'object') return bad('Expected a config object.');

  if (patch.site !== undefined && !parseUrl(patch.site)) return bad(ERRORS.invalidUrl(String(patch.site)));

  const loaded = loadConfig(options.root);
  const next = mergeConfig(loaded.config, patch);
  const configPath = saveConfig(options.root, next);
  return ok({ config: next, configPath });
}

// -- test ----------------------------------------------------------------------------------------

async function runTest(body: unknown, options: ApiOptions): Promise<ApiResponse> {
  const input = (body ?? {}) as { url?: string; quality?: boolean; timeoutMs?: number };
  const loaded = loadConfig(options.root);
  const target = input.url || loaded.config.site;
  if (!parseUrl(target)) return bad(ERRORS.invalidUrl(target));

  const result = await testUrl(target, { timeoutMs: input.timeoutMs });

  // The quality review is a separate object in the response for the same reason it is a separate
  // section in the CLI: it must never be mistaken for part of the 0-100 number.
  let quality: unknown;
  let qualityError: string | undefined;
  if (input.quality) {
    const built = resolveCredentials(options.root, loaded.config.ai.provider, loaded.config.ai.model, 'test --quality');
    const markdown = result.evidence.twin.body.trim();
    if ('error' in built) qualityError = built.error;
    else if (!markdown) {
      qualityError = `There is no markdown at ${result.twinUrl} to review. Fix the failing B checks first, then try again.`;
    } else {
      try {
        quality = await reviewQuality(
          { url: result.twinUrl, markdown },
          { provider: built.provider, model: built.model, apiKey: built.apiKey },
        );
      } catch (error) {
        qualityError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  return ok({
    url: result.url,
    twinUrl: result.twinUrl,
    framework: result.framework,
    score: result.score,
    checks: result.checks,
    quality,
    qualityError,
  });
}

// -- generate ------------------------------------------------------------------------------------

async function runGenerate(body: unknown, options: ApiOptions): Promise<ApiResponse> {
  const input = (body ?? {}) as {
    url?: string;
    tier?: 'free' | 'ai';
    single?: boolean;
    force?: boolean;
    skipSiteFiles?: boolean;
    maxPages?: number;
    maxDepth?: number;
  };
  const loaded = loadConfig(options.root);
  const target = input.url || loaded.config.site;
  if (!parseUrl(target)) return bad(ERRORS.invalidUrl(target));

  const tier = input.tier ?? loaded.config.generate.tier;
  let enhance: ((enhanceInput: EnhanceInput) => Promise<EnhanceOutput>) | undefined;
  if (tier === 'ai') {
    const built = resolveCredentials(options.root, loaded.config.ai.provider, loaded.config.ai.model, "generate's AI tier");
    if ('error' in built) return bad(built.error, { needsKey: true });
    enhance = createAiEnhancer({ provider: built.provider, model: built.model, apiKey: built.apiKey });
  }

  const result = await generateSite({
    target,
    loaded,
    tier,
    force: input.force,
    single: input.single,
    maxPages: input.maxPages,
    maxDepth: input.maxDepth,
    skipSiteFiles: input.skipSiteFiles,
    enhance,
  });

  return ok({
    site: result.site,
    durationMs: result.durationMs,
    pages: result.generate.pages,
    files: result.files,
    warnings: result.warnings,
    publicDir: result.generate.publicDir,
  });
}

// -- prod test -----------------------------------------------------------------------------------

async function runProdTest(body: unknown, options: ApiOptions): Promise<ApiResponse> {
  const input = (body ?? {}) as { url?: string; bot?: string; timeoutMs?: number };
  const loaded = loadConfig(options.root);
  const target = input.url || loaded.config.site;
  if (!parseUrl(target)) return bad(ERRORS.invalidUrl(target));

  try {
    const result = await verifyProd(target, { bot: input.bot, timeoutMs: input.timeoutMs });
    return ok(result);
  } catch (error) {
    return bad(error instanceof Error ? error.message : String(error));
  }
}

// -- key -----------------------------------------------------------------------------------------

/**
 * Writing a key is the one destructive thing this API does, so it follows setup's ordering exactly:
 * `.gitignore` first, then `.env`. The key is written to `.env` and never to the config file, and
 * the response says where it went without ever echoing it back.
 */
function saveKey(body: unknown, options: ApiOptions): ApiResponse {
  const input = (body ?? {}) as { provider?: string; apiKey?: string; model?: string };
  if (!input.provider || !AI_PROVIDERS.includes(input.provider as AiProvider)) {
    return bad(ERRORS.unknownProvider(String(input.provider), AI_PROVIDERS));
  }
  const apiKey = (input.apiKey ?? '').trim();
  if (!apiKey) return bad('No key was provided, so nothing was written.');

  const provider = input.provider as AiProvider;
  const model = input.model?.trim() || DEFAULT_MODELS[provider];

  const gitignore = ensureEnvGitignored(options.root);
  const envPath = writeEnvVars(options.root, { [PROVIDER_VAR]: provider, [KEY_VAR]: apiKey, [MODEL_VAR]: model });

  const loaded = loadConfig(options.root);
  saveConfig(options.root, mergeConfig(loaded.config, { ai: { provider, model } }));

  return ok({
    provider,
    model,
    envPath,
    gitignorePath: gitignore.path,
    gitignoreAdded: gitignore.added,
  });
}

// -- generated files -----------------------------------------------------------------------------

/** Show the reader the bytes an agent would receive, straight off disk, with no re-rendering. */
function readFileRoute(body: unknown, options: ApiOptions): ApiResponse {
  const input = (body ?? {}) as { path?: string };
  const relative = (input.path ?? '').trim();
  if (!relative) return bad('Expected a path relative to the public directory.');
  const content = readGeneratedFile(options.root, relative);
  if (content === undefined) return { status: 404, body: { error: `There is no generated file at ${relative}.` } };
  return ok({ path: relative, content });
}

// -- shared --------------------------------------------------------------------------------------

interface ResolvedCredentials {
  provider: AiProvider;
  model: string;
  apiKey: string;
}

function resolveCredentials(
  root: string,
  configProvider: AiProvider,
  configModel: string,
  feature: string,
): ResolvedCredentials | { error: string } {
  if (isCI()) return { error: ERRORS.ciBlocked(feature) };
  const credentials = readCredentials(root);
  if (!credentials) return { error: ERRORS.noApiKey(feature) };
  const provider = credentials.provider ?? configProvider;
  return { provider, model: credentials.model || configModel || DEFAULT_MODELS[provider], apiKey: credentials.apiKey };
}

/**
 * Read a generated file so the dashboard can show what is actually on disk.
 *
 * The path comes from a browser, so it is confined to the public directory the same way the static
 * server confines asset paths: resolve first, then refuse anything that did not stay inside. The
 * separator matters - without it, a sibling directory named `public-old` would pass a bare
 * `startsWith`.
 */
export function readGeneratedFile(root: string, relativePath: string): string | undefined {
  const loaded = loadConfig(root);
  const base = publicDirPath(loaded);
  const path = resolve(base, relativePath);
  if (path !== base && !path.startsWith(base + sep)) return undefined;
  return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined;
}
