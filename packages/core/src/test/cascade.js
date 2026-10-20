import { servesFile } from './checks-site.js';

/**
 * @import { CheckResult } from './checks.js'
 * @import { Evidence } from './evidence.js'
 */

/**
 * What a missing twin locks, and the one place that applies it (§5).
 */

/**
 * One missing twin costs one suggestion, not twelve (§5).
 *
 * Without this, a site that has simply never installed OmniGEO fails B1 and then fails eleven more
 * checks that are all restatements of the same fact: you cannot inspect the Content-Type of a
 * document that does not exist, and reporting that as eleven separate findings is not a
 * measurement, it is an echo.
 *
 * So when the twin URL does not answer, everything downstream of it becomes `locked` behind B1, and
 * the whole verdict on the markdown layer is carried by B1, the heaviest check in the table. The
 * twin layer is a set of suggestions, so none of this touches the 0-100; what it changes is the
 * report, which leads with one suggestion and says how many more apply once a twin is served,
 * instead of twelve findings about the same missing file. The cascade never locks a scored check.
 *
 * They leave as `locked`, not as `na`. That distinction is the entire difference between a report
 * that says "twelve things do not apply to you" and one that says "twelve more things become
 * measurable the moment you serve a single file". Only one of them tells the reader what to do next.
 *
 * A twin that exists but is wrong is a different situation and is still checked in full detail.
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
    // A locked check has nothing to fix yet: its blocker's fix is the step, and it carries the count.
    const { fix: _fix, price: _price, ...rest } = result;
    return {
      ...rest,
      status: /** @type {const} */ ('locked'),
      earned: 0,
      lockedBy: 'B1',
      reason: `No markdown twin at ${e.twinUrl}, so ${why}. The missing twin is reported once, on B1.`,
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
 * Every check the cascade can lock. All of them are suggestions: the cascade never touches a scored
 * check, which test-pillar.test.js holds it to.
 *
 * The report shows this list as one block, and docs.test.js adds up their weights to check the
 * number written in docs/checks.md is the number the code would actually produce.
 *
 * @type {readonly string[]}
 */
export const TWIN_LOCKED_IDS = [...Object.keys(LOCKED_ON_TWIN), ...Object.keys(LOCKED_ON_LIVE_URL)];
