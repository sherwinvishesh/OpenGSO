import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createAiEnhancer } from '../generate/ai.js';
import type { EnhanceInput, EnhanceOutput } from '../generate/generate.js';
import { readManifest } from '../generate/manifest.js';
import { generateSite } from '../generate/site.js';
import { verifyProd } from '../prod/verify.js';
import type { CustomBotInput } from '../shared/bots.js';
import { normalizeCustomBot, resolveBots } from '../shared/bots.js';
import type { OpenGeoConfig } from '../shared/config.js';
import {
  CONFIG_FILENAME,
  internalDirPath,
  loadConfig,
  mergeConfig,
  providerOverridesOf,
  publicDirPath,
  saveConfig,
} from '../shared/config.js';
import type { AiProvider, ProviderApi, ProviderAuth, ProviderInfo, ProviderOverrides } from '../shared/providers.js';
import { AI_PROVIDERS, DEFAULT_MODELS, PROVIDERS, isAiProvider, providerInfo } from '../shared/providers.js';
import {
  BASE_URL_VAR,
  ENV_FILENAME,
  KEY_VAR,
  MODEL_VAR,
  PROVIDER_VAR,
  ensureEnvGitignored,
  isCI,
  readCredentials,
  writeEnvVars,
} from '../shared/env.js';
import { ERRORS } from '../shared/errors.js';
import { parseUrl } from '../shared/http.js';
import type { SitePreview, WebRootGuess } from '../shared/site-probe.js';
import { detectWebRoot, previewSite } from '../shared/site-probe.js';
import type { History, HistoryEntry, SuiteAi, TestMode } from '../test/index.js';
import { isTestMode, readHistory, recordRun, runTestSuite, scoreTrend, testJson } from '../test/index.js';

/**
 * The local JSON API behind `opengeo start` (§8).
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
    case 'GET /api/history':
      // Capped at 20 runs by the writer, so there is no pagination to design here.
      return ok(readHistory(internalDirPath(loadConfig(options.root))));
    case 'GET /api/bots':
      // The resolved list, so the dashboard's crawler table shows a project's own agents beside
      // the shipped ones instead of quietly leaving them out of a list that looks complete.
      return ok({ bots: resolveBots(loadConfig(options.root).config.bots.custom) });
    case 'POST /api/config':
      return saveConfigPatch(request.body, options);
    case 'POST /api/preview':
      return await runPreview(request.body);
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
  /**
   * Where generated files probably belong, worked out from the project rather than asked.
   *
   * Part of the state rather than its own endpoint because it is a fact about the directory the
   * server was pointed at, known before anybody types anything, and onboarding needs it on the
   * first screen. `found: false` means nothing pointed anywhere and the usual answer is being
   * offered for want of better, which is worth saying differently in the UI.
   */
  webRoot: WebRootGuess;
  providers: AiProvider[];
  defaultModels: Record<AiProvider, string>;
  /**
   * The full catalogue, so the dashboard renders real names and "get a key" links instead of a
   * dropdown of lowercase ids, and knows which entries need an endpoint typed in.
   */
  providerCatalog: ProviderInfo[];
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
    providerCatalog: [...PROVIDERS],
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
    webRoot: detectWebRoot(loaded.root),
  };
}

// -- config --------------------------------------------------------------------------------------

function saveConfigPatch(body: unknown, options: ApiOptions): ApiResponse {
  let patch = body as Partial<OpenGeoConfig> | null;
  if (!patch || typeof patch !== 'object') return bad('Expected a config object.');

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
  const configPath = saveConfig(options.root, next);
  return ok({ config: next, configPath });
}

/** Returns the cleaned list, or a message explaining why the whole patch was refused. */
function normalizeCustomList(input: unknown): CustomBotInput[] | string {
  if (!Array.isArray(input)) return 'bots.custom must be a list of crawlers.';
  const builtIn = new Set(resolveBots(undefined).map((bot) => bot.name.toLowerCase()));
  const seen = new Set<string>();
  const cleaned: CustomBotInput[] = [];

  for (const entry of input) {
    const bot = normalizeCustomBot(entry as CustomBotInput);
    if (!bot) return 'Every custom crawler needs a name.';
    const key = bot.name.toLowerCase();
    if (builtIn.has(key)) return `${bot.name} is already one of the crawlers OpenGEO ships with.`;
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

// -- preview -------------------------------------------------------------------------------------

export interface PreviewResponse {
  preview: SitePreview;
}

/**
 * What is at that URL, asked while somebody is still typing it (§8).
 *
 * Onboarding's first field used to be a string the server validated and forgot. One fetch turns it
 * into an answer: the site is up or it is not, this is what is serving it, the content is in the
 * HTML or it is waiting on JavaScript, and a twin may already be being served. All four are things
 * the person filling in the field would otherwise discover after their first generate.
 *
 * The failure mode is the point. An unreachable site comes back 200 with `ok: false` and a reason,
 * not as an API error, because "we could not reach it" is a finding about the site rather than a
 * fault in the request, and onboarding must not stall on a diagnostic. Only an unparseable URL is
 * a 400, and that one is the user's next keystroke away from being fixed.
 */
async function runPreview(body: unknown): Promise<ApiResponse> {
  const input = (body ?? {}) as { url?: string };
  const target = (input.url ?? '').trim();
  if (!parseUrl(target)) return bad(ERRORS.invalidUrl(target));
  return ok({ preview: await previewSite(target) } satisfies PreviewResponse);
}

// -- test ----------------------------------------------------------------------------------------

/**
 * The three test modes, behind one endpoint (§8).
 *
 * The dashboard sends a mode rather than a pair of booleans because the modes are not independent:
 * `content` needs no structural run, `structure` must never make a paid call, and `full` is an
 * ordering, not a union. Everything below is `runTestSuite`, the same function the CLI calls.
 */
async function runTest(body: unknown, options: ApiOptions): Promise<ApiResponse> {
  const input = (body ?? {}) as {
    url?: string;
    mode?: string;
    /** The old boolean, still honoured: `quality: true` means the full run with the review. */
    quality?: boolean;
    maxDocs?: number;
    timeoutMs?: number;
  };
  const loaded = loadConfig(options.root);
  const target = input.url || loaded.config.site;
  if (!parseUrl(target)) return bad(ERRORS.invalidUrl(target));

  const mode: TestMode = isTestMode(input.mode) ? input.mode : input.quality ? 'full' : 'structure';
  if (input.mode !== undefined && !isTestMode(input.mode)) {
    return bad(`Unknown test mode "${String(input.mode)}". Pick one of: full, structure, content.`);
  }

  let ai: SuiteAi | undefined;
  if (mode !== 'structure') {
    const built = resolveCredentials(options.root, loaded.config, 'the content review');
    // A missing key is not a 400 here. The suite reports it in the response body, in the same shape
    // the CLI prints it, so the dashboard can show a report with one section explaining itself.
    if (!('error' in built)) ai = built;
  }

  // Read before the run and returned alongside it, so the dashboard can draw the same delta and
  // sparkline the CLI headline does without a second round trip.
  const internalDir = internalDirPath(loaded);
  const before = readHistory(internalDir);

  const result = await runTestSuite(target, {
    mode,
    timeoutMs: input.timeoutMs,
    bots: resolveBots(loaded.config.bots.custom),
    ai,
    requireContent: mode === 'content',
    maxDocs: input.maxDocs,
  });
  recordRun(internalDir, result);

  return ok({
    mode: result.mode,
    url: result.url,
    history: historyPayload(before, result.url),
    // Flattened for the dashboard's existing Test view, which reads these at the top level.
    ...(result.structure
      ? {
          twinUrl: result.structure.twinUrl,
          framework: result.structure.framework,
          score: result.structure.score,
          checks: result.structure.checks,
        }
      : {}),
    structure: result.structure ? testJson(result.structure) : null,
    // Its own key for the same reason it is its own section in the CLI: a model's opinion must
    // never be mistaken for part of the 0-100 number.
    content: result.content ?? null,
    discovery: result.discovery
      ? {
          documents: result.discovery.twins.map((twin) => ({
            url: twin.url,
            pageUrl: twin.pageUrl ?? null,
            source: twin.source,
            bytes: twin.bytes,
            words: twin.words,
          })),
          rejected: result.discovery.rejected,
          overCap: result.discovery.overCap,
          sources: result.discovery.sources,
        }
      : null,
    contentSkipped: result.contentSkipped ?? null,
    contentError: result.contentError ?? null,
  });
}

/**
 * The previous runs of this URL, as the dashboard needs them.
 *
 * Deliberately the history from *before* this run: the client already has the new score in the same
 * response, and sending it twice would have the sparkline draw its last point at both ends.
 */
function historyPayload(history: History, url: string): { trend: number[]; previous: HistoryEntry | null } {
  const forUrl = history.entries.filter((entry) => entry.url === url && typeof entry.score === 'number');
  return { trend: scoreTrend(history, url), previous: forUrl.at(-1) ?? null };
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
    const built = resolveCredentials(options.root, loaded.config, "generate's AI tier");
    if ('error' in built) return bad(built.error, { needsKey: true });
    enhance = createAiEnhancer(built);
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
    const result = await verifyProd(target, {
      bot: input.bot,
      bots: resolveBots(loaded.config.bots.custom),
      timeoutMs: input.timeoutMs,
    });
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
 *
 * The endpoint fields go to two different places on purpose. `baseUrl` is an address, not a secret,
 * so it is saved in `opengeo.config.json` where it can be committed and shared with the team; the
 * key stays in `.env`. A provider marked keyless (a model server on this machine) is allowed to save
 * with no key at all, because demanding a placeholder would be theatre.
 */
function saveKey(body: unknown, options: ApiOptions): ApiResponse {
  const input = (body ?? {}) as {
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    api?: string;
    auth?: string;
  };
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
    return bad(`Unknown API shape "${rawApi}". OpenGEO speaks three: anthropic, openai, gemini.`);
  }
  if (rawAuth && !isProviderAuth(rawAuth)) {
    return bad(`Unknown auth style "${rawAuth}". Use one of: bearer, x-api-key, x-goog-api-key, none.`);
  }
  const api: ProviderApi | undefined = isProviderApi(rawApi) ? rawApi : undefined;
  const auth: ProviderAuth | undefined = isProviderAuth(rawAuth) ? rawAuth : undefined;

  const endpoint = baseUrl || (info.userDefined ? '' : info.baseUrl);
  if (!endpoint) return bad(ERRORS.providerIncomplete(provider, ['ai.baseUrl']));

  const model = input.model?.trim() || info.defaultModel;
  if (!model) return bad(ERRORS.providerIncomplete(provider, ['ai.model']));

  const keyless = info.keyless || auth === 'none';
  if (!apiKey && !keyless) return bad('No key was provided, so nothing was written.');

  const gitignore = ensureEnvGitignored(options.root);
  const vars: Record<string, string> = { [PROVIDER_VAR]: provider, [MODEL_VAR]: model };
  if (apiKey) vars[KEY_VAR] = apiKey;
  if (baseUrl) vars[BASE_URL_VAR] = baseUrl;
  const envPath = writeEnvVars(options.root, vars);

  const loaded = loadConfig(options.root);
  const ai: Partial<OpenGeoConfig['ai']> = { provider, model };
  if (baseUrl) ai.baseUrl = baseUrl;
  if (api) ai.api = api;
  if (auth) ai.auth = auth;
  saveConfig(options.root, mergeConfig(loaded.config, { ai: ai as OpenGeoConfig['ai'] }));

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

function isProviderApi(value: string): value is ProviderApi {
  return value === 'anthropic' || value === 'openai' || value === 'gemini';
}

function isProviderAuth(value: string): value is ProviderAuth {
  return value === 'bearer' || value === 'x-api-key' || value === 'x-goog-api-key' || value === 'none';
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

/**
 * One place that answers "can we make an AI call, and to what".
 *
 * The endpoint overrides travel with the credentials because they are half the address: a key
 * without the gateway it belongs to points at the wrong host, which is the one failure mode §11
 * cares about most.
 */
function resolveCredentials(root: string, config: OpenGeoConfig, feature: string): SuiteAi | { error: string } {
  if (isCI()) return { error: ERRORS.ciBlocked(feature) };
  const credentials = readCredentials(root);
  const provider = credentials?.provider ?? config.ai.provider;
  // A local model server needs no key, so "nothing in .env" is not the same as "cannot run".
  if (!credentials && !providerInfo(provider).keyless) return { error: ERRORS.noApiKey(feature) };

  const overrides: ProviderOverrides = { ...providerOverridesOf(config) };
  if (credentials?.baseUrl) overrides.baseUrl = credentials.baseUrl;

  return {
    provider,
    model: credentials?.model || config.ai.model || DEFAULT_MODELS[provider],
    apiKey: credentials?.apiKey ?? '',
    overrides,
  };
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
