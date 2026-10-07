import { parseUrl } from '../shared/http.js';
import { ERRORS } from '../shared/errors.js';
import { gatherEvidence } from './evidence.js';
import { detectFrameworkFrom } from './framework.js';
import { runChecks } from './runner.js';
import { scoreChecks } from './score.js';

/**
 * @import { AiBot } from '../shared/bots.js'
 * @import { CheckResult } from './checks.js'
 * @import { Evidence } from './evidence.js'
 * @import { Framework } from './framework.js'
 * @import { Score } from './score.js'
 */

/**
 * One structural run: fetch the evidence once, score it, and hand back everything that was seen.
 *
 * Kept out of `index.js` so that module can be a pure barrel. `suite.js` calls this, and `index.js`
 * re-exports both, which is the only arrangement where nothing in `test/` imports its own barrel.
 */

/**
 * @typedef {object} TestResult
 * @property {string} url
 * @property {string} twinUrl
 * @property {CheckResult[]} checks
 * @property {Score} score
 * @property {Evidence} evidence
 * @property {Framework} [framework] Undefined when nothing matched. No check's result depends on this.
 */

/**
 * @typedef {object} TestOptions
 * @property {number} [timeoutMs]
 * @property {readonly AiBot[]} [bots] Built-ins plus the project's own crawlers, so A1 judges robots.txt against both.
 * @property {readonly string[]} [markdownRouting] The project's `bots.markdownRouting`, so B10 probes a crawler it routes.
 */

/**
 * @param {string} target
 * @param {TestOptions} [options]
 * @returns {Promise<TestResult>}
 */
export async function testUrl(target, options = {}) {
  const url = parseUrl(target);
  if (!url) throw new Error(ERRORS.invalidUrl(target));
  const evidence = await gatherEvidence(url, { timeoutMs: options.timeoutMs, bots: options.bots, markdownRouting: options.markdownRouting });
  return testEvidence(evidence);
}

/**
 * Split out so tests can score synthetic evidence without any network access.
 *
 * @param {Evidence} evidence
 * @returns {TestResult}
 */
export function testEvidence(evidence) {
  const checks = runChecks(evidence);
  return {
    url: evidence.target.toString(),
    twinUrl: evidence.twinUrl,
    framework: detectFrameworkFrom(evidence.html),
    checks,
    score: scoreChecks(checks),
    evidence,
  };
}
