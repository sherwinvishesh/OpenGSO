import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createAiEnhancer } from '../generate/ai.js';
import { readManifest } from '../generate/manifest.js';
import { generateSite } from '../generate/site.js';
import { DEFAULT_BOT, verifyProd } from '../prod/verify.js';
import { CONTENT_BANDS, STRUCTURAL_BANDS } from '../cli/tui/theme.js';
import { resolveAiCall } from '../shared/ai-call.js';
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
import { detectWebRoot, previewSite } from '../shared/site-probe.js';
import { CHECKS } from '../test/checks.js';
import { isTestMode, readHistory, recordRun, runTestSuite, scoreTrend, testJson } from '../test/index.js';

/**
 * @import { EnhanceInput, EnhanceOutput } from '../generate/generate.js'
 * @import { SiteProgress } from '../generate/site.js'
 * @import { CustomBotInput } from '../shared/bots.js'
 * @import { OpenGeoConfig } from '../shared/config.js'
 * @import { AiProvider, ProviderApi, ProviderAuth, ProviderInfo } from '../shared/providers.js'
 * @import { SitePreview, WebRootGuess } from '../shared/site-probe.js'
 * @import { CheckResult, Framework, History, HistoryEntry, Score, SuiteAi, SuiteProgress, TestMode, TestResult } from '../test/index.js'
 */

/**
 * Defined in `api-types.js` with every other shape the dashboard reads, and re-exported here.
 *
 * @typedef {import('../shared/api-types.js').ApiProgress} ApiProgress
 * @typedef {import('../shared/api-types.js').StructurePayload} StructurePayload
 * @typedef {import('../shared/api-types.js').StateResponse} StateResponse
 * @typedef {import('../shared/api-types.js').PreviewResponse} PreviewResponse
 */

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

/**
 * @typedef {object} ApiRequest
 * @property {string} method
 * @property {string} path
 * @property {unknown} body
 */

/**
 * @typedef {object} ApiResponse
 * @property {number} status
 * @property {unknown} body
 */

/**
 * @typedef {object} ApiOptions
 * @property {string} root Project root. Fixed for the lifetime of the server: the browser cannot ask
 *   for another.
 * @property {string} version
 * @property {string} packageName
 * @property {(event: ApiProgress) => void} [onProgress] Set by the transport for the `/stream`
 *   routes, absent everywhere else.
 *
 *   An endpoint that takes minutes has to be able to say so while it is still working, and the two
 *   that do already accept an `onProgress` from the CLI. This is the same callback, one hop further
 *   out, so the dashboard watches exactly what the terminal watches.
 * @property {AbortSignal} [signal] Aborted by the transport when the browser that asked goes away,
 *   so a closed tab stops the crawl and the paid calls instead of finishing for nobody.
 */

/**
 * @param {unknown} body
 * @returns {ApiResponse}
 */
const ok = (body) => ({ status: 200, body });
/**
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 * @returns {ApiResponse}
 */
const bad = (message, extra = {}) => ({
  status: 400,
  body: { error: message, ...extra },
});

/**
 * @param {ApiRequest} request
 * @param {ApiOptions} options
 * @returns {Promise<ApiResponse>}
 */
export async function handleApi(request, options) {
  const { method, path } = request;
  const route = `${method} ${path}`;

  switch (route) {
    case 'GET /api/state':
      return ok(readState(options));
    case 'GET /api/history':
      // Capped by the writer at 20 runs per URL and 200 overall, so there is no pagination to design here.
      return ok(readHistory(internalDirPath(loadConfig(options.root))));
    case 'GET /api/bots':
      // The resolved list, so the dashboard's crawler table shows a project's own agents beside
      // the shipped ones instead of quietly leaving them out of a list that looks complete.
      return ok({ bots: resolveBots(loadConfig(options.root).config.bots.custom) });
    case 'POST /api/config':
      return saveConfigPatch(request.body, options);
    case 'POST /api/preview':
      return await runPreview(request.body);
    // Each of these two answers on two paths. The handler is identical; `/stream` only tells the
    // transport to hold the response open and forward `options.onProgress` as it arrives, so a
    // script that wants one JSON object and a browser that wants narration run the same code.
    case 'POST /api/test':
    case 'POST /api/test/stream':
      return await exclusive('test', options.root, () => runTest(request.body, options));
    case 'POST /api/generate':
    case 'POST /api/generate/stream':
      return await exclusive('generate', options.root, () => runGenerate(request.body, options));
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

/** The runs in flight, as `kind:root`. */
const running = new Set();

/**
 * One run of each kind per project at a time.
 *
 * Two generates would race each other for the manifest, and two tests pay for the same content
 * review twice. A second tab, or a double click before the button disables, used to start both.
 *
 * @param {'test' | 'generate'} kind
 * @param {string} root
 * @param {() => Promise<ApiResponse>} run
 * @returns {Promise<ApiResponse>}
 */
async function exclusive(kind, root, run) {
  const key = `${kind}:${root}`;
  if (running.has(key)) return { status: 409, body: { error: ERRORS.runInProgress(kind) } };
  running.add(key);
  try {
    return await run();
  } finally {
    running.delete(key);
  }
}

// -- state ---------------------------------------------------------------------------------------

/**
 * @param {ApiOptions} options
 * @returns {StateResponse}
 */
function readState(options) {
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
    checkCount: CHECKS.length,
    bands: { structural: { ...STRUCTURAL_BANDS }, content: { ...CONTENT_BANDS } },
    defaultBot: DEFAULT_BOT,
  };
}

// -- config --------------------------------------------------------------------------------------

/**
 * @param {unknown} body
 * @param {ApiOptions} options
 * @returns {ApiResponse}
 */
function saveConfigPatch(body, options) {
  const shape = configPatchProblem(body);
  if (shape) return bad(shape);
  let patch = /** @type {Partial<OpenGeoConfig>} */ (body);

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
 *
 * @param {unknown} body
 * @returns {Promise<ApiResponse>}
 */
async function runPreview(body) {
  const input = /** @type {{ url?: string }} */ (body ?? {});
  const target = (input.url ?? '').trim();
  if (!parseUrl(target)) return bad(ERRORS.invalidUrl(target));
  return ok(/** @satisfies {PreviewResponse} */ ({ preview: await previewSite(target) }));
}

// -- test ----------------------------------------------------------------------------------------

/**
 * The three test modes, behind one endpoint (§8).
 *
 * The dashboard sends a mode rather than a pair of booleans because the modes are not independent:
 * `content` needs no structural run, `structure` must never make a paid call, and `full` is an
 * ordering, not a union. Everything below is `runTestSuite`, the same function the CLI calls.
 *
 * @param {unknown} body
 * @param {ApiOptions} options
 * @returns {Promise<ApiResponse>}
 */
async function runTest(body, options) {
  const input = /** @type {{
    url?: string;
    mode?: string;
    quality?: boolean; // The old boolean, still honoured: `quality: true` means the full run with the review.
    maxDocs?: number;
    timeoutMs?: number;
  }} */ (body ?? {});
  const loaded = loadConfig(options.root);
  const target = input.url || loaded.config.site;
  if (!parseUrl(target)) return bad(ERRORS.invalidUrl(target));

  /** @type {TestMode} */
  const mode = isTestMode(input.mode) ? input.mode : input.quality ? 'full' : 'structure';
  if (input.mode !== undefined && !isTestMode(input.mode)) {
    return bad(`Unknown test mode "${String(input.mode)}". Pick one of: full, structure, content.`);
  }

  /** @type {SuiteAi | undefined} */
  let ai;
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
    markdownRouting: loaded.config.bots.markdownRouting,
    ai,
    requireContent: mode === 'content',
    maxDocs: input.maxDocs,
    signal: options.signal,
    onProgress: options.onProgress ? (event) => options.onProgress?.(testFrame(event)) : undefined,
  });
  // The dashboard has nowhere to show this, so it goes to the terminal `opengeo start` is running in.
  recordRun(internalDir, result, { onWarning: (message) => process.stderr.write(`${message}\n`) });

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
 * A suite progress event, in the shape that survives a JSON frame.
 *
 * Only `structure-done` needs any work: the terminal takes the whole `TestResult` because it is
 * about to render a report from it, and a browser cannot be sent the evidence that report was
 * derived from. The other four pass through as they are.
 *
 * @param {SuiteProgress} event
 * @returns {ApiProgress}
 */
export function testFrame(event) {
  return event.phase === 'structure-done' ? { phase: 'structure-done', structure: structurePayload(event.result) } : event;
}

/**
 * The same four fields `runTest` flattens into its response, so a client merges one shape.
 *
 * @param {TestResult} result
 * @returns {StructurePayload}
 */
function structurePayload(result) {
  return {
    url: result.url,
    twinUrl: result.twinUrl,
    framework: result.framework,
    score: result.score,
    checks: result.checks,
  };
}

/**
 * A site progress event, flattened by one level.
 *
 * `SiteProgress` nests the crawl and generate payloads under a key named after the phase, which is
 * an awkward shape to switch on twice in a browser. Flattened here instead, and `phase` renamed to
 * `step` on the generate branch so the outer discriminant is not shadowed by an inner one.
 *
 * @param {SiteProgress} event
 * @returns {ApiProgress}
 */
export function generateFrame(event) {
  if (event.phase === 'crawl') return { phase: 'crawl', ...event.crawl };
  if (event.phase === 'generate') {
    const { phase, ...rest } = event.generate;
    return { phase: 'generate', step: phase, ...rest };
  }
  return { phase: 'files' };
}

/**
 * The previous runs of this URL, as the dashboard needs them.
 *
 * Deliberately the history from *before* this run: the client already has the new score in the same
 * response, and sending it twice would have the sparkline draw its last point at both ends.
 *
 * @param {History} history
 * @param {string} url
 * @returns {{ trend: number[]; previous: HistoryEntry | null }}
 */
function historyPayload(history, url) {
  const forUrl = history.entries.filter((entry) => entry.url === url && typeof entry.score === 'number');
  return { trend: scoreTrend(history, url), previous: forUrl.at(-1) ?? null };
}

// -- generate ------------------------------------------------------------------------------------

/**
 * @param {unknown} body
 * @param {ApiOptions} options
 * @returns {Promise<ApiResponse>}
 */
async function runGenerate(body, options) {
  const input = /** @type {{
    url?: string;
    tier?: 'free' | 'ai';
    single?: boolean;
    force?: boolean;
    skipSiteFiles?: boolean;
    maxPages?: number;
    maxDepth?: number;
  }} */ (body ?? {});
  const loaded = loadConfig(options.root);
  const target = input.url || loaded.config.site;
  if (!parseUrl(target)) return bad(ERRORS.invalidUrl(target));

  const tier = input.tier ?? loaded.config.generate.tier;
  /** @type {((enhanceInput: EnhanceInput) => Promise<EnhanceOutput>) | undefined} */
  let enhance;
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
    signal: options.signal,
    onProgress: options.onProgress ? (event) => options.onProgress?.(generateFrame(event)) : undefined,
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

/**
 * @param {unknown} body
 * @param {ApiOptions} options
 * @returns {Promise<ApiResponse>}
 */
async function runProdTest(body, options) {
  const input = /** @type {{ url?: string; bot?: string; timeoutMs?: number }} */ (body ?? {});
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
 *
 * @param {unknown} body
 * @param {ApiOptions} options
 * @returns {ApiResponse}
 */
function saveKey(body, options) {
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
    return bad(`Unknown API shape "${rawApi}". OpenGEO speaks three: anthropic, openai, gemini.`);
  }
  if (rawAuth && !isProviderAuth(rawAuth)) {
    return bad(`Unknown auth style "${rawAuth}". Use one of: bearer, x-api-key, x-goog-api-key, none.`);
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
    const saved = readCredentials(options.root);
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
  /** @type {Partial<OpenGeoConfig['ai']>} */
  const ai = { provider, model, baseUrl: baseUrl || undefined };
  if (api) ai.api = api;
  if (auth) ai.auth = auth;
  saveConfig(options.root, mergeConfig(loaded.config, { ai: /** @type {OpenGeoConfig['ai']} */ (ai) }));

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

// -- generated files -----------------------------------------------------------------------------

/**
 * Show the reader the bytes an agent would receive, straight off disk, with no re-rendering.
 *
 * @param {unknown} body
 * @param {ApiOptions} options
 * @returns {ApiResponse}
 */
function readFileRoute(body, options) {
  const input = /** @type {{ path?: string }} */ (body ?? {});
  const relative = (input.path ?? '').trim();
  if (!relative) return bad('Expected a path relative to the public directory.');
  const content = readGeneratedFile(options.root, relative);
  if (content === undefined) return { status: 404, body: { error: `There is no generated file at ${relative}.` } };
  return ok({ path: relative, content });
}

const GENERATED_FILE = /^(md\/.+\.md|(robots\.txt|llms\.txt|sitemap\.xml)(\.opengeo-proposed)?)$/;

// -- shared --------------------------------------------------------------------------------------

/**
 * One place that answers "can we make an AI call, and to what".
 *
 * The endpoint overrides travel with the credentials because they are half the address: a key
 * without the gateway it belongs to points at the wrong host, which is the one failure mode §11
 * cares about most.
 *
 * @param {string} root
 * @param {OpenGeoConfig} config
 * @param {string} feature
 * @returns {SuiteAi | { error: string }}
 */
function resolveCredentials(root, config, feature) {
  if (isCI()) return { error: ERRORS.ciBlocked(feature) };
  const resolved = resolveAiCall(root, config);
  if ('error' in resolved) return resolved;
  if ('missing' in resolved) return { error: ERRORS.noApiKey(feature) };
  const { keySource: _source, ...ai } = resolved.call;
  return ai;
}

/**
 * Read a generated file so the dashboard can show what is actually on disk.
 *
 * The path comes from a browser, so it is confined to the public directory the same way the static
 * server confines asset paths: resolve first, then refuse anything that did not stay inside. The
 * separator matters - without it, a sibling directory named `public-old` would pass a bare
 * `startsWith`.
 *
 * Staying inside is necessary and not enough. A web root holds whatever the project put there, so
 * on top of it the name has to be one generate writes: a twin under `md/`, or one of the three site
 * files and its proposed copy. No dotfile anywhere in the path, whatever directory it is in.
 *
 * @param {string} root
 * @param {string} relativePath
 * @returns {string | undefined}
 */
export function readGeneratedFile(root, relativePath) {
  if (!GENERATED_FILE.test(relativePath) || relativePath.split('/').some((part) => part.startsWith('.'))) {
    return undefined;
  }
  const loaded = loadConfig(root);
  const base = publicDirPath(loaded);
  const path = resolve(base, relativePath);
  if (path !== base && !path.startsWith(base + sep)) return undefined;
  return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined;
}
