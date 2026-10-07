import { ERRORS } from '../shared/errors.js';
import { parseUrl } from '../shared/http.js';
import { discoverTwins } from './discover.js';
import { reviewContent } from './quality.js';
import { testUrl } from './run.js';

/**
 * @import { AiBot } from '../shared/bots.js'
 * @import { AiProvider, ProviderOverrides } from '../shared/providers.js'
 * @import { ProviderFn } from '../shared/provider-call.js'
 * @import { DiscoveryResult } from './discover.js'
 * @import { ContentReview } from './quality.js'
 * @import { TestResult } from './run.js'
 */

/**
 * Defined in `api-types.js` with every other shape the dashboard reads, and re-exported here.
 *
 * @typedef {import('../shared/api-types.js').TestMode} TestMode
 */

/**
 * The three shapes a test run can take, and the single function that runs all of them.
 *
 * There are two genuinely different questions to ask about a site, and conflating them was the old
 * design's mistake:
 *
 * - **structure** is the deterministic audit. Is the twin reachable, is the content type right, does
 *   `Vary` include `Accept`. Free, offline-friendly, reproducible, and the only thing that produces
 *   the 0-100 score.
 * - **content** is the language model's read on the documents themselves. Is the product actually
 *   defined, are the words someone would search for present, is it specific. Costs money, needs a
 *   key, and is never reproducible to the decimal.
 * - **full** is both, in that order, because the second needs the first: the structural pass is what
 *   finds the documents. A run with no key still gets the structural half and a note saying why the
 *   content half did not happen, rather than an error where a report should be.
 *
 * The CLI and the dashboard both call this. Neither has its own copy of the sequencing, which is
 * why the two can never disagree about what "run the full test" means.
 */

/** @type {readonly TestMode[]} */
export const TEST_MODES = ['full', 'structure', 'content'];

/**
 * @param {unknown} value
 * @returns {value is TestMode}
 */
export function isTestMode(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (TEST_MODES).includes(value);
}

/**
 * Everything the content pass needs. Absent means it cannot run, which is a reportable state.
 *
 * @typedef {object} SuiteAi
 * @property {AiProvider} provider
 * @property {string} apiKey
 * @property {string} [model]
 * @property {ProviderOverrides} [overrides]
 * @property {ProviderFn} [call] Injectable so tests never touch the network.
 */

/**
 * @typedef {object} SuiteOptions
 * @property {TestMode} mode
 * @property {number} [timeoutMs]
 * @property {readonly AiBot[]} [bots] Built-ins plus the project's own crawlers, so A1 judges robots.txt against both.
 * @property {readonly string[]} [markdownRouting] The project's `bots.markdownRouting`, so B10 probes a crawler it routes.
 * @property {SuiteAi} [ai] Absent means the content pass reports "no key" instead of running.
 * @property {boolean} [requireContent] The caller asked for the content pass by name (`-q`, or the dashboard's own toggle). Turns a
 *   missing key from a note into a refusal, because silently doing less than was asked for is the
 *   one outcome nobody can debug.
 * @property {number} [maxDocs] How many documents get reviewed. Every one is a paid call.
 * @property {number} [maxFetch] How many candidate URLs discovery will fetch before giving up on a huge sitemap.
 * @property {(event: SuiteProgress) => void} [onProgress]
 * @property {AbortSignal} [signal] Aborted when the browser that asked for the run goes away. The
 *   paid pass checks it before it starts and between batches, and an abandoned run throws.
 * @property {Record<string, string | undefined>} [env] Overridable only so the CI guard itself is testable.
 */

/**
 * `structure-done` carries the finished structural result so a terminal can print the report the
 * moment it exists, rather than making the user watch a blank screen through a minute of paid AI calls.
 *
 * @typedef {{ phase: 'structure' }
 *   | { phase: 'structure-done'; result: TestResult }
 *   | { phase: 'discover' }
 *   | { phase: 'discovered'; documents: number }
 *   | { phase: 'review'; done: number; total: number; url: string }} SuiteProgress
 */

/**
 * @typedef {object} SuiteResult
 * @property {TestMode} mode
 * @property {string} url
 * @property {TestResult} [structure] Absent only in `content` mode, which never runs the checks.
 * @property {DiscoveryResult} [discovery]
 * @property {ContentReview} [content]
 * @property {string} [contentSkipped] Why the content pass did not run. A note, not a failure: in `full` mode this is the normal
 *   outcome for the majority of users, who have no key and did not ask for one.
 * @property {string} [contentError] The content pass was attempted and failed. Distinct from skipped, and worth an exit code.
 */

/**
 * @param {string} target
 * @param {SuiteOptions} options
 * @returns {Promise<SuiteResult>}
 */
export async function runTestSuite(target, options) {
  const url = parseUrl(target);
  if (!url) throw new Error(ERRORS.invalidUrl(target));

  const structure = options.mode === 'content' ? undefined : await runStructure(url, options);
  /** @type {SuiteResult} */
  const result = { mode: options.mode, url: url.toString(), structure };
  if (options.mode === 'structure') return result;

  // In `full` mode a missing key is expected and must not read as an error. In `content` mode the
  // user asked for exactly this one thing, so refusing loudly is the honest answer.
  if (!options.ai) {
    const message = ERRORS.noApiKey(options.mode === 'content' ? 'test --content' : 'the content review');
    if (options.mode === 'content' || options.requireContent) result.contentError = message;
    else result.contentSkipped = message;
    return result;
  }

  options.signal?.throwIfAborted();
  options.onProgress?.({ phase: 'discover' });
  const discovery = await discoverTwins(url, {
    timeoutMs: options.timeoutMs,
    evidence: structure?.evidence,
    maxFetch: options.maxFetch,
  });
  result.discovery = discovery;
  options.onProgress?.({ phase: 'discovered', documents: discovery.twins.length });

  if (discovery.twins.length === 0) {
    result.contentError = noDocuments(url, discovery);
    return result;
  }

  try {
    result.content = await reviewContent(discovery.twins, {
      provider: options.ai.provider,
      apiKey: options.ai.apiKey,
      model: options.ai.model,
      overrides: options.ai.overrides,
      call: options.ai.call,
      timeoutMs: options.timeoutMs,
      maxDocuments: options.maxDocs,
      env: options.env,
      signal: options.signal,
      onProgress: (done, total, reviewed) => options.onProgress?.({ phase: 'review', done, total, url: reviewed }),
    });
  } catch (error) {
    result.contentError = error instanceof Error ? error.message : String(error);
  }
  // Nobody is waiting for a report on a run they abandoned, and it must not be recorded as one,
  // including when the abort landed during the last batch and nothing was left to check it.
  options.signal?.throwIfAborted();
  // A review that produced nothing is a failed review, not an empty one, and in `content` mode it
  // has to reach the exit code.
  const documents = result.content?.documents ?? [];
  if (result.content?.halted) result.contentError = result.content.halted;
  else if (documents.length > 0 && documents.every((doc) => doc.error)) {
    result.contentError = ERRORS.contentReviewAllFailed(documents.length);
  }
  return result;
}

/**
 * @param {URL} url
 * @param {SuiteOptions} options
 * @returns {Promise<TestResult>}
 */
async function runStructure(url, options) {
  options.onProgress?.({ phase: 'structure' });
  const result = await testUrl(url.toString(), { timeoutMs: options.timeoutMs, bots: options.bots, markdownRouting: options.markdownRouting });
  options.onProgress?.({ phase: 'structure-done', result });
  return result;
}

/**
 * "Nothing to review" has several causes and the user can only act on the specific one, so the
 * message names what was tried and what came back rather than saying no markdown was found.
 *
 * @param {URL} url
 * @param {DiscoveryResult} discovery
 * @returns {string}
 */
function noDocuments(url, discovery) {
  const lines = [`No Markdown documents to review on ${url.origin}.`];
  if (discovery.rejected.length > 0) {
    lines.push('', 'Tried:');
    for (const item of discovery.rejected.slice(0, 5)) lines.push(`  ${item.url} - ${item.reason}`);
    if (discovery.rejected.length > 5) lines.push(`  ...and ${discovery.rejected.length - 5} more`);
  }
  lines.push(
    '',
    discovery.sources.llms || discovery.sources.sitemap
      ? 'The site publishes llms.txt or sitemap.xml, but none of the documents they point at came back as Markdown.'
      : 'The site publishes neither llms.txt nor sitemap.xml, so there was nothing to enumerate.',
    '',
    'Run `opengeo generate <url>` to write the twins first, then review them.',
  );
  return lines.join('\n');
}

/**
 * The exit code a suite result deserves. Structural failures decide it whenever there was one.
 *
 * @param {SuiteResult} result
 * @returns {number}
 */
export function suiteExitCode(result) {
  if (result.structure) return result.structure.score.counts.fail === 0 ? 0 : 1;
  return result.contentError ? 1 : 0;
}
