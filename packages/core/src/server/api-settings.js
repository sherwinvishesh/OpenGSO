import { join } from 'node:path';
import { checkFreshness } from '../generate/freshness.js';
import { readManifest } from '../generate/manifest.js';
import { DEFAULT_BOT } from '../prod/verify.js';
import { CONTENT_BANDS, STRUCTURAL_BANDS } from '../shared/render/theme.js';
import { normalizeCustomBot, resolveBots } from '../shared/bots.js';
import {
  CONFIG_FILENAME,
  configPatchProblem,
  internalDirPath,
  loadConfig,
  mergeConfig,
  projectDirProblem,
  publicDirPath,
  saveConfig,
} from '../shared/config.js';
import { AI_PROVIDERS, DEFAULT_MODELS, PROVIDERS, isAiProvider, providerInfo } from '../shared/providers.js';
import {
  BASE_URL_VAR,
  ENV_FILENAME,
  KEY_VAR,
  MODEL_VAR,
  PROVIDER_VAR,
  ensureEnvGitignored,
  envValueProblem,
  isCI,
  readCredentials,
  writeEnvVars,
} from '../shared/env.js';
import { ERRORS } from '../shared/errors.js';
import { parseUrl } from '../shared/http.js';
import { detectWebRoot } from '../shared/site-probe.js';
import { CHECKS } from '../test/checks.js';
import { ok, bad } from './api-shared.js';

/**
 * @import { CustomBotInput } from '../shared/bots.js'
 * @import { LoadedConfig, OpenGsoConfig } from '../shared/config.js'
 * @import { ProviderApi, ProviderAuth } from '../shared/providers.js'
 * @import { FreshnessReport, StateResponse } from '../shared/api-types.js'
 * @import { ApiOptions, ApiResponse } from './api-shared.js'
 */

/** The settings routes: reading the project state, patching the config and saving a key. */

// -- state ---------------------------------------------------------------------------------------

/**
 * @param {ApiOptions} options
 * @returns {StateResponse}
 */
export function readState(options) {
  const loaded = loadConfig(options.root);
  const credentials = readCredentials(options.root, loaded.config.ai);
  // readManifest returns an empty manifest rather than undefined when nothing has been generated,
  // and that empty one carries a `generatedAt` of right now. Reporting it would tell the dashboard
  // a project was generated seconds ago when in fact it never has been, so it is dropped here.
  const read = readManifest(internalDirPath(loaded));
  const manifest = Object.keys(read.pages).length > 0 ? read : undefined;

  return {
    root: loaded.root,
    configPath: join(loaded.root, CONFIG_FILENAME),
    configExists: loaded.exists,
    // A blank model means the provider's default, and the forms need the id itself to prefill.
    config: loaded.config.ai.model
      ? loaded.config
      : { ...loaded.config, ai: { ...loaded.config.ai, model: DEFAULT_MODELS[loaded.config.ai.provider] ?? '' } },
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
    providerCatalog: [...PROVIDERS],
    manifest: manifest
      ? {
          generatedAt: manifest.generatedAt,
          site: manifest.site,
          source: manifest.source ?? 'url',
          pages: Object.values(manifest.pages).map((page) => ({
            route: page.route,
            title: page.title,
            tokens: page.tokens,
            lastUpdated: page.lastUpdated,
            tier: page.tier,
            file: page.file,
            ...(page.sourceFile ? { sourceFile: page.sourceFile } : {}),
          })),
        }
      : undefined,
    publicDir: publicDirPath(loaded),
    internalDir: internalDirPath(loaded),
    ...freshnessOf(loaded),
    webRoot: detectWebRoot(loaded.root),
    checkCount: CHECKS.length,
    bands: { structural: { ...STRUCTURAL_BANDS }, content: { ...CONTENT_BANDS } },
    defaultBot: DEFAULT_BOT,
  };
}

/**
 * The freshness report, as a spread, so a project that crawls carries no key at all. A folder that
 * cannot be read right now is the generate page's to report, not a reason for the whole dashboard
 * to fail to load.
 *
 * @param {LoadedConfig} loaded
 * @returns {{ freshness?: FreshnessReport }}
 */
function freshnessOf(loaded) {
  try {
    const freshness = checkFreshness(loaded);
    return freshness ? { freshness } : {};
  } catch {
    return {};
  }
}

// -- config --------------------------------------------------------------------------------------

/**
 * @param {unknown} body
 * @param {ApiOptions} options
 * @returns {ApiResponse}
 */
export function saveConfigPatch(body, options) {
  const shape = configPatchProblem(body);
  if (shape) return bad(shape);
  let patch = /** @type {Partial<OpenGsoConfig>} */ (body);

  // The key is in .env and goes wherever `ai` says. Only /api/key may move it, because it checks
  // the endpoint and takes the key in the same request; the dashboard never sends `ai` here.
  if ('ai' in patch) return bad(ERRORS.aiViaConfigRefused());

  if (patch.site !== undefined && !parseUrl(patch.site)) return bad(ERRORS.invalidUrl(String(patch.site)));

  // Custom crawlers arrive as free text from a form, so they are normalized here rather than
  // trusted. Anything that survives is a well-formed entry the prod middleware can match against.
  if (patch.bots?.custom !== undefined) {
    const cleaned = normalizeCustomList(patch.bots.custom);
    if (typeof cleaned === 'string') return bad(cleaned);
    patch = { ...patch, bots: { ...patch.bots, custom: cleaned } };
  }

  const loaded = loadConfig(options.root);
  const next = mergeConfig(loaded.config, patch);
  const problem = projectDirProblem(options.root, next);
  if (problem) return bad(problem);
  const configPath = saveConfig(options.root, next);
  return ok({ config: next, configPath });
}

/**
 * Returns the cleaned list, or a message explaining why the whole patch was refused.
 *
 * @param {unknown} input
 * @returns {CustomBotInput[] | string}
 */
function normalizeCustomList(input) {
  if (!Array.isArray(input)) return 'bots.custom must be a list of crawlers.';
  const builtIn = new Set(resolveBots(undefined).map((bot) => bot.name.toLowerCase()));
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {CustomBotInput[]} */
  const cleaned = [];

  for (const entry of input) {
    const bot = normalizeCustomBot(/** @type {CustomBotInput} */ (entry));
    if (!bot) return 'Every custom crawler needs a name.';
    const key = bot.name.toLowerCase();
    if (builtIn.has(key)) return `${bot.name} is already one of the crawlers OpenGSO ships with.`;
    if (seen.has(key)) return `${bot.name} is listed twice.`;
    seen.add(key);
    cleaned.push({
      name: bot.name,
      vendor: bot.vendor,
      uaPatterns: [...bot.uaPatterns],
      robotsToken: bot.robotsToken,
      kind: bot.kind,
      notes: bot.notes,
    });
  }
  return cleaned;
}

// -- key -----------------------------------------------------------------------------------------

/**
 * Writing a key is the one destructive thing this API does, so it follows setup's ordering exactly:
 * `.gitignore` first, then `.env`. The key is written to `.env` and never to the config file, and
 * the response says where it went without ever echoing it back.
 *
 * The endpoint fields go to two different places on purpose. `baseUrl` is an address, not a secret,
 * so it is saved in `opengso.config.json` where it can be committed and shared with the team; the
 * key stays in `.env`. A provider marked keyless (a model server on this machine) is allowed to save
 * with no key at all, because demanding a placeholder would be theatre.
 *
 * @param {unknown} body
 * @param {ApiOptions} options
 * @returns {ApiResponse}
 */
export function saveKey(body, options) {
  const input = /** @type {{
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    api?: string;
    auth?: string;
  }} */ (body ?? {});
  if (!input.provider || !isAiProvider(input.provider)) {
    return bad(ERRORS.unknownProvider(String(input.provider), AI_PROVIDERS));
  }

  const provider = input.provider;
  const info = providerInfo(provider);
  const apiKey = (input.apiKey ?? '').trim();
  const baseUrl = (input.baseUrl ?? '').trim();
  const rawApi = (input.api ?? '').trim();
  const rawAuth = (input.auth ?? '').trim();

  if (baseUrl && !parseUrl(baseUrl)) return bad(ERRORS.invalidUrl(baseUrl));
  if (rawApi && !isProviderApi(rawApi)) {
    return bad(ERRORS.unknownApiShape(rawApi));
  }
  if (rawAuth && !isProviderAuth(rawAuth)) {
    return bad(ERRORS.unknownAuthStyle(rawAuth));
  }
  /** @type {ProviderApi | undefined} */
  const api = isProviderApi(rawApi) ? rawApi : undefined;
  /** @type {ProviderAuth | undefined} */
  const auth = isProviderAuth(rawAuth) ? rawAuth : undefined;

  const endpoint = baseUrl || (info.userDefined ? '' : info.baseUrl);
  if (!endpoint) return bad(ERRORS.providerIncomplete(provider, ['ai.baseUrl']));

  const model = input.model?.trim() || info.defaultModel;
  if (!model) return bad(ERRORS.providerIncomplete(provider, ['ai.model']));

  const keyless = info.keyless || auth === 'none';
  if (!apiKey && !keyless) {
    // Blank means "keep the saved key", so changing the model does not mean retyping it. Only where
    // that key was already going, though: a new provider or endpoint would receive a key the user
    // pasted for somewhere else.
    const saved = readCredentials(options.root, { provider });
    if (!saved?.apiKey) return bad(ERRORS.keyMissing());
    if (saved.provider !== provider || (saved.baseUrl ?? '') !== baseUrl) return bad(ERRORS.keyNotKept(provider));
  }

  // No base URL means none, not "keep the last one": a gateway left in .env would get this key.
  /** @type {Record<string, string | undefined>} */
  const vars = {
    [PROVIDER_VAR]: provider,
    [MODEL_VAR]: model,
    [BASE_URL_VAR]: baseUrl || undefined,
  };
  if (apiKey) vars[KEY_VAR] = apiKey;
  // Checked here as well as in writeEnvVars so a refusal is a 400 that touched nothing on disk.
  const unwritable = envValueProblem(vars);
  if (unwritable) return bad(unwritable);

  const gitignore = ensureEnvGitignored(options.root);
  const envPath = writeEnvVars(options.root, vars);

  const loaded = loadConfig(options.root);
  /** @type {Partial<OpenGsoConfig['ai']>} */
  const ai = { provider, model, baseUrl: baseUrl || undefined };
  if (api) ai.api = api;
  if (auth) ai.auth = auth;
  saveConfig(options.root, mergeConfig(loaded.config, { ai: /** @type {OpenGsoConfig['ai']} */ (ai) }));

  return ok({
    provider,
    model,
    keyless: keyless && !apiKey,
    baseUrl: baseUrl || undefined,
    envPath,
    gitignorePath: gitignore.path,
    gitignoreAdded: gitignore.added,
  });
}

/**
 * @param {string} value
 * @returns {value is ProviderApi}
 */
function isProviderApi(value) {
  return value === 'anthropic' || value === 'openai' || value === 'gemini';
}

/**
 * @param {string} value
 * @returns {value is ProviderAuth}
 */
function isProviderAuth(value) {
  return value === 'bearer' || value === 'x-api-key' || value === 'x-goog-api-key' || value === 'none';
}
