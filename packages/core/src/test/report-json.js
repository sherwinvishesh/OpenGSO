/**
 * @import { ContentReview, QualityReview } from './quality.js'
 * @import { DiscoveryResult } from './discover.js'
 * @import { SuiteResult } from './suite.js'
 * @import { TestResult } from './run.js'
 */

/**
 * The machine-readable side of a test run: what `--json` prints and the dashboard API serves. Kept
 * apart from the terminal renderer so neither can pick up the other's formatting by accident.
 */

/**
 * Machine-readable output for `--json` and for the product website's local API.
 *
 * @param {TestResult} result
 * @returns {Record<string, unknown>}
 */
export function testJson(result) {
  return {
    url: result.url,
    score: result.score.value,
    earned: result.score.earned,
    possible: result.score.possible,
    twinUrl: result.twinUrl,
    framework: result.framework ? { id: result.framework.id, name: result.framework.name } : null,
    counts: result.score.counts,
    locked: result.score.locked,
    checks: result.checks.map((check) => ({
      id: check.id,
      title: check.title,
      category: check.category,
      importance: check.importance,
      weight: check.weight,
      earned: check.earned,
      price: check.price,
      status: check.status,
      reason: check.reason,
      detail: check.detail,
      fix: check.fix,
      lockedBy: check.lockedBy,
    })),
  };
}

/**
 * @typedef {object} JsonExtras
 * @property {QualityReview} [quality] A single-document review, from the older one-URL path.
 * @property {ContentReview} [content] The multi-document content pass.
 * @property {DiscoveryResult} [discovery]
 * @property {string} [mode]
 * @property {string} [contentSkipped]
 * @property {string} [contentError]
 */

/**
 * @param {TestResult | undefined} result
 * @param {JsonExtras} [extras]
 * @returns {string}
 */
export function toJson(result, extras = {}) {
  return JSON.stringify(
    {
      ...(result ? testJson(result) : {}),
      mode: extras.mode ?? (result ? 'structure' : 'content'),
      // Its own key, never merged into `score`: a deterministic audit and a model's opinion are
      // different kinds of claim, and a consumer should have to opt into reading the second.
      quality: extras.quality ?? null,
      content: extras.content ?? null,
      discovery: extras.discovery
        ? {
            documents: extras.discovery.twins.map((twin) => ({
              url: twin.url,
              pageUrl: twin.pageUrl ?? null,
              source: twin.source,
              bytes: twin.bytes,
              words: twin.words,
            })),
            rejected: extras.discovery.rejected,
            overCap: extras.discovery.overCap,
            sources: extras.discovery.sources,
          }
        : null,
      contentSkipped: extras.contentSkipped ?? null,
      contentError: extras.contentError ?? null,
    },
    null,
    2,
  );
}

/**
 * The whole suite as JSON, so `--json` says the same thing in every mode.
 *
 * @param {SuiteResult} result
 * @returns {string}
 */
export function suiteJson(result) {
  return toJson(result.structure, {
    mode: result.mode,
    content: result.content,
    discovery: result.discovery,
    contentSkipped: result.contentSkipped,
    contentError: result.contentError,
  });
}
