import { collapseTwinCascade } from './cascade.js';
import {
  checkHttps,
  checkJsonLd,
  checkLlmsTxt,
  checkNoAi,
  checkRobots,
  checkSitemap,
  checkSsrExtractable,
  checkTtfb,
} from './checks-site.js';
import {
  checkAcceptNegotiation,
  checkAeoVersion,
  checkBotUaNegotiation,
  checkHtmlUnaffected,
  checkLinkAlternate,
  checkNosniff,
  checkNotAcceptable,
  checkTokensHeader,
  checkTwinContentType,
  checkTwinNoindex,
  checkTwinNonEmpty,
  checkTwinReachable,
  checkVaryAccept,
} from './checks-twin.js';
import { checkDrift } from './drift.js';
import { rawDocument } from './live-page.js';

/**
 * @import { CheckResult } from './checks.js'
 * @import { Evidence } from './evidence.js'
 */

/**
 * The checklist (§5), in report order.
 *
 * The checks live in checks-site.js (category A), checks-twin.js (B1 to B13) and drift.js (B14), and
 * cascade.js decides what a missing twin locks. Every check is pure over `Evidence`, so the whole
 * checklist can be unit-tested against synthetic responses with no network involved.
 */

export { SSR_FLOOR_WORDS, TTFB_FAST_MS, TTFB_SLOW_MS } from './checks-site.js';
export { SSR_MIN_WORDS } from './live-page.js';
export { TWIN_FLOOR_RATIO, TWIN_FULL_RATIO } from './checks-twin.js';
export { TWIN_LOCKED_IDS } from './cascade.js';

/**
 * @param {Evidence} evidence
 * @returns {CheckResult[]}
 */
export function runChecks(evidence) {
  const page = rawDocument(evidence);
  try {
    return runAll(evidence, page.get);
  } finally {
    page.close();
  }
}

/**
 * @param {Evidence} evidence
 * @param {() => Document} doc
 * @returns {CheckResult[]}
 */
function runAll(evidence, doc) {
  return collapseTwinCascade([
    checkRobots(evidence),
    checkLlmsTxt(evidence),
    checkSitemap(evidence),
    checkJsonLd(evidence, doc),
    checkSsrExtractable(evidence),
    checkTtfb(evidence),
    checkNoAi(evidence, doc),
    checkHttps(evidence),
    checkTwinReachable(evidence),
    checkTwinContentType(evidence),
    checkTwinNonEmpty(evidence),
    checkTokensHeader(evidence),
    checkNosniff(evidence),
    checkTwinNoindex(evidence),
    checkVaryAccept(evidence),
    checkLinkAlternate(evidence),
    checkAcceptNegotiation(evidence),
    checkBotUaNegotiation(evidence),
    checkNotAcceptable(evidence),
    checkAeoVersion(evidence),
    checkHtmlUnaffected(evidence),
    checkDrift(evidence),
  ], evidence);
}
