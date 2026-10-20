import { verifyProd } from '../prod/verify.js';
import { resolveBots } from '../shared/bots.js';
import { internalDirPath, loadConfig } from '../shared/config.js';
import { ERRORS } from '../shared/errors.js';
import { parseUrl } from '../shared/http.js';
import { previewSite } from '../shared/site-probe.js';
import { fixPromptOptions, fixPromptSet, isTestMode, readHistory, recordRun, runTestSuite, scoreTrend, testJson } from '../test/index.js';
import { ok, bad, resolveCredentials } from './api-shared.js';

/**
 * @import { History, HistoryEntry, SuiteAi, SuiteProgress, TestMode, TestResult } from '../test/index.js'
 * @import { ApiProgress, StructurePayload, PreviewResponse } from '../shared/api-types.js'
 * @import { OpenGeoConfig } from '../shared/config.js'
 * @import { ApiOptions, ApiResponse } from './api-shared.js'
 */

/** The probing routes: the site preview, a test run and a prod test. */

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
export async function runPreview(body) {
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
export async function runTest(body, options) {
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
    return bad(ERRORS.unknownTestMode(String(input.mode)));
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
    publicOrigin: loaded.config.publicOrigin,
    ai,
    requireContent: mode === 'content',
    maxDocs: input.maxDocs,
    signal: options.signal,
    onProgress: options.onProgress ? (event) => options.onProgress?.(testFrame(event, loaded.config)) : undefined,
  });
  // The dashboard has nowhere to show this, so it goes to the terminal `opengeo start` is running in.
  recordRun(internalDir, result, { onWarning: (message) => process.stderr.write(`${message}\n`) });

  return ok({
    mode: result.mode,
    url: result.url,
    history: historyPayload(before, result.url),
    // Flattened for the dashboard's existing Test view, which reads these at the top level.
    ...(result.structure ? structurePayload(result.structure, loaded.config) : {}),
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
 * @param {OpenGeoConfig} [config] The project's, for the fix prompts to name its twin directory.
 *   Without one the frame carries no prompts.
 * @returns {ApiProgress}
 */
export function testFrame(event, config) {
  return event.phase === 'structure-done' ? { phase: 'structure-done', structure: structurePayload(event.result, config) } : event;
}

/**
 * The fields `runTest` flattens into its response, so a client merges one shape.
 *
 * The fix prompts ride along in the frame as well as the response, so the copy button works while
 * a content review is still running. They are built here, by the same function `--prompt` uses,
 * because a browser that assembled its own would be a second prompt to keep in step with the first.
 *
 * @param {TestResult} result
 * @param {OpenGeoConfig} [config]
 * @returns {StructurePayload}
 */
function structurePayload(result, config) {
  return {
    url: result.url,
    twinUrl: result.twinUrl,
    framework: result.framework,
    score: result.score,
    checks: result.checks,
    ...(config ? { prompts: fixPromptSet(result, fixPromptOptions(config, result.url)) } : {}),
  };
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

// -- prod test -----------------------------------------------------------------------------------

/**
 * @param {unknown} body
 * @param {ApiOptions} options
 * @returns {Promise<ApiResponse>}
 */
export async function runProdTest(body, options) {
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
