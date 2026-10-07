import { servesFile } from './checks-site.js';

/**
 * @import { CheckResult } from './checks.js'
 * @import { Evidence } from './evidence.js'
 */

/**
 * What a missing twin locks, and the one place that applies it (§5).
 */

/**
 * One missing twin costs one check, not twelve (§5).
 *
 * Without this, a site that has simply never installed OpenGEO fails B1 and then fails eleven more
 * checks that are all restatements of the same fact: you cannot inspect the Content-Type of a
 * document that does not exist, and reporting that as eleven separate defects is not a measurement,
 * it is an echo. It also wrecks the scale. anthropic.com and openai.com are well-built sites that
 * an agent can read perfectly well, and the uncollapsed scorer put both at 38/100, which tells the
 * reader nothing except that the number is not to be trusted.
 *
 * So when the twin URL does not answer, everything downstream of it leaves the denominator and the
 * whole verdict on the markdown layer is carried by B1, the heaviest check in the table. Those two
 * sites now score 80: the fundamentals are all there, the markdown layer is not, and the gap
 * between them is one line in the report instead of twelve.
 *
 * They leave as `locked`, not as `na`. That distinction is the entire difference between a report
 * that says "twelve things do not apply to you" and one that says "twelve things worth 46
 * points are waiting behind a single missing file". The arithmetic is identical; only one of them
 * tells the reader what to do next.
 *
 * A twin that exists but is wrong is a different situation and is still scored in full detail.
 *
 * @param {CheckResult[]} results
 * @param {Evidence} e
 * @returns {CheckResult[]}
 */
export function collapseTwinCascade(results, e) {
  if (servesFile(e.twin)) return results;

  return results.map((result) => {
    const why = LOCKED_ON_TWIN[result.id] ?? (result.status === 'pass' ? undefined : LOCKED_ON_LIVE_URL[result.id]);
    if (!why) return result;
    return {
      ...result,
      status: /** @type {const} */ ('locked'),
      earned: 0,
      lockedBy: 'B1',
      reason: `No markdown twin at ${e.twinUrl}, so ${why}. The missing twin is scored once, on B1.`,
      // What the live site actually said is worth keeping: an AI crawler getting a 403 is a real
      // finding even though it is not this check's to score.
      detail: result.id in LOCKED_ON_LIVE_URL ? result.detail ?? result.reason : result.detail,
    };
  });
}

// Read off the twin response itself. With no twin there is nothing to read, pass or fail: B5
// "passing" because a 404 page happened to carry nosniff is noise, not a point earned.
/** @type {Record<string, string>} */
const LOCKED_ON_TWIN = {
  B2: 'there is no twin response whose Content-Type could be checked',
  B3: 'there is no twin body to measure',
  B4: 'there is no twin response to carry a token count',
  B5: 'there is no twin response to carry the header',
  B6: 'there is no twin response to keep out of the search index',
  B12: 'there is no markdown response to advertise a spec version on',
  B14: 'there is no twin that could have drifted',
};

// Probed against the live URL. These can genuinely succeed without a `.md` twin - a site can wire
// Accept negotiation at the same URL - so a pass is kept and anything short of one is locked. A
// partial is locked too: kept in the denominator, a `Vary: Accept` on the HTML alone cost the site
// points it would not have lost by sending nothing.
/** @type {Record<string, string>} */
const LOCKED_ON_LIVE_URL = {
  B7: 'there are not two formats for a CDN to cache apart',
  B8: 'there is no twin for the HTML page to advertise',
  B9: 'there is no markdown representation to negotiate for',
  B10: 'there is no markdown to route a crawler to',
  B11: 'a site serving one format has nothing to refuse',
};

/**
 * Every check the cascade can take out of the denominator.
 *
 * The report prices this list as one block, and docs.test.js adds up their weights to check the
 * number written in docs/checks.md is the number the code would actually produce.
 *
 * @type {readonly string[]}
 */
export const TWIN_LOCKED_IDS = [...Object.keys(LOCKED_ON_TWIN), ...Object.keys(LOCKED_ON_LIVE_URL)];
