/**
 * The check catalogue (§5).
 *
 * Category A asks "can AI find and understand this site at all". Category B asks "is the markdown
 * twin actually being served correctly" - it is the same contract opengeo-prod implements in §7,
 * which is why both sides share the header constants in shared/version.js.
 *
 * Every check runs and every check is reported, but only seven of them are **scored**: A1, A3, A5,
 * A6, A7, A8 and B13, which together weigh 61. They are what an AI agent needs from a page today,
 * and the 0-100 is computed over them alone. The other fifteen (llms.txt, JSON-LD and the whole
 * markdown twin layer) are **suggestions**: run, reported, given a fix and counted as adopted or
 * open, but never part of the score.
 *
 * The reason is calibration against the real web. The sites agents read most easily, anthropic.com
 * and openai.com among them, serve no llms.txt, no JSON-LD and no markdown twin. A scale that
 * charges them for that is measuring adoption of a convention, not whether an agent can read the
 * page, and it tells a site that is already readable that it is broken. So:
 *
 * 1. **A site that does what the leading AI sites do scores 100.** Robots access, a sitemap, real
 *    content in the HTML, a fast first byte, no silent opt-out, HTTPS with HSTS, and an HTML page
 *    that still works for humans. Only a scored check that fails or half-passes moves it below.
 * 2. **The conventions are where a site sets itself apart, and the report says so.** The suggestion
 *    count ("3 of 15 adopted") is the second number on every report, and serving a twin with
 *    `opengeo generate` and `opengeo prod` is what takes it to 15.
 * 3. **B1 is still the only double-digit weight.** Among suggestions the weight only orders them,
 *    so the markdown twin, the one that unlocks twelve more, always leads the list.
 *
 * `tests/test-pillar.test.js` pins all three so a future weight edit cannot quietly break them.
 */

/** @typedef {'A' | 'B'} CheckCategory */
/** @typedef {'required' | 'recommended'} CheckImportance */
/**
 * What a check concluded.
 *
 * `partial` and `locked` were added because the two-state version was lying by omission. A site
 * that serves HTTPS without HSTS is not in the same state as one served over plain HTTP, and a
 * check that cannot run *yet* because a prerequisite failed is not the same as a check that can
 * never apply to this target. Both used to collapse into `fail` and `na` respectively, and both
 * collapses cost the reader the only information they wanted: how close am I, and what do I do
 * first.
 *
 * - `pass`   full weight earned. On a suggestion, it means the page has adopted it.
 * - `partial` some of the weight earned, with a `fix` naming the rest.
 * - `fail`   nothing earned. On a scored check this is the only status that fails a build; on a
 *            suggestion it is a convention the page has not adopted, which `--strict` also fails.
 * - `locked` not measurable until `lockedBy` passes. Out of the denominator, like `na`, but
 *            unlike `na` it is something the user can go and unlock, and the report says how.
 * - `na`     genuinely cannot apply here. HSTS on localhost. Out of the denominator forever.
 *
 * @typedef {'pass' | 'partial' | 'fail' | 'locked' | 'na'} CheckStatus
 */

/**
 * Every check id in the catalogue. Spelled out so a table keyed by id (the fix prompt's remedies)
 * is a `Record<CheckId, string>`, and a check added without an entry is a type error, not a gap.
 *
 * @typedef {'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7' | 'A8' | 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B6' | 'B7' | 'B8' | 'B9' | 'B10' | 'B11' | 'B12' | 'B13' | 'B14'} CheckId
 */

/**
 * @typedef {object} CheckDefinition
 * @property {string} id
 * @property {CheckCategory} category
 * @property {CheckImportance} importance OpenGEO's original label, kept for reference and for the docs. `scored`
 *   is what decides whether the check counts toward the 0-100.
 * @property {boolean} scored Whether the check is part of the score. The scored seven are what an agent needs from a page
 *   today; the rest are suggestions, conventions the best-read sites have not adopted either. A suggestion is run and
 *   reported like any other check, and its weight only orders it among the other suggestions.
 * @property {string} title What the check verifies, in plain language. Shown in the CLI and the product website.
 * @property {number} weight
 */

/**
 * What a check adds to its definition once it has run. Kept as its own type only so each field can
 * carry its comment: JSDoc has no `extends`, and a comment cannot sit inside an inline type.
 *
 * @typedef {object} CheckOutcome
 * @property {CheckStatus} status
 * @property {number} earned Points actually earned, from 0 to `weight`.
 *
 *   `pass` is the full weight and `fail` is zero, so the binary checks need no thought. It exists
 *   as its own field rather than being derived from the status because a partial has no other
 *   place to put the number, and because the report has to be able to print "2 of 4" without
 *   knowing which band produced it.
 * @property {string} reason The specific reason this check passed, failed, or did not apply. Never a generic string.
 * @property {string} [detail] Optional extra context: an observed header value, a measured number.
 * @property {string} [fix] The next step, for anything short of a pass.
 *
 *   Written as an instruction and priced, e.g. "Add `Vary: Accept` to the HTML response too (+2)". The
 *   price is stripped from a suggestion's fix once the run is scored.
 *   The report's ranked footer is built from these, which is why a `fix` that only restates the
 *   problem is worse than none at all.
 * @property {number} [price] Score points (of 100) this check would add if it passed. Set on a scored fail or partial
 *   once the run is scored, because a check's weight is out of 61 and is not the headline's unit. A suggestion has no
 *   price: adopting it moves no score.
 * @property {string} [lockedBy] `locked` only: the id of the check that has to pass before this one can be measured.
 */

/** @typedef {CheckDefinition & CheckOutcome} CheckResult */

// Narrowed to CheckId here, so an id in the table that the union does not name fails the typecheck.
/** @type {readonly (CheckDefinition & { id: CheckId })[]} */
export const CHECKS = [
  // ---- A. General AI-discoverability -------------------------------------------------------
  { id: 'A1', category: 'A', scored: true, importance: 'required', weight: 9, title: 'robots.txt exists and does not disallow known AI bots' },
  { id: 'A2', category: 'A', scored: false, importance: 'recommended', weight: 3, title: 'llms.txt is present and valid' },
  { id: 'A3', category: 'A', scored: true, importance: 'required', weight: 9, title: 'sitemap.xml is present and valid' },
  { id: 'A4', category: 'A', scored: false, importance: 'recommended', weight: 2, title: 'Schema.org JSON-LD is present and parses' },
  { id: 'A5', category: 'A', scored: true, importance: 'required', weight: 9, title: 'Real content is in the raw HTML, not only after JS runs' },
  { id: 'A6', category: 'A', scored: true, importance: 'required', weight: 8, title: 'Time to first byte is fast enough for agent fetches' },
  { id: 'A7', category: 'A', scored: true, importance: 'required', weight: 8, title: 'No noai / noimageai tag is silently blocking AI' },
  { id: 'A8', category: 'A', scored: true, importance: 'required', weight: 9, title: 'Served over HTTPS with HSTS' },

  // ---- B. Implementation correctness ---------------------------------------------------------
  { id: 'B1', category: 'B', scored: false, importance: 'required', weight: 10, title: 'Markdown twin URL is reachable and returns 2xx' },
  { id: 'B2', category: 'B', scored: false, importance: 'required', weight: 5, title: 'Content-Type is exactly text/markdown; charset=utf-8' },
  { id: 'B3', category: 'B', scored: false, importance: 'required', weight: 5, title: 'Markdown response body is non-empty' },
  { id: 'B4', category: 'B', scored: false, importance: 'recommended', weight: 3, title: 'X-Markdown-Tokens is present and a positive integer' },
  { id: 'B5', category: 'B', scored: false, importance: 'recommended', weight: 3, title: 'X-Content-Type-Options: nosniff is present' },
  { id: 'B6', category: 'B', scored: false, importance: 'required', weight: 3, title: 'X-Robots-Tag on the twin includes noindex' },
  { id: 'B7', category: 'B', scored: false, importance: 'required', weight: 4, title: 'Vary includes Accept, so CDNs cache the two formats separately' },
  { id: 'B8', category: 'B', scored: false, importance: 'recommended', weight: 3, title: 'HTML response advertises the twin via Link rel="alternate"' },
  { id: 'B9', category: 'B', scored: false, importance: 'required', weight: 6, title: 'Accept: text/markdown receives markdown, not HTML' },
  { id: 'B10', category: 'B', scored: false, importance: 'required', weight: 6, title: 'A known AI bot User-Agent receives markdown without an Accept header' },
  { id: 'B11', category: 'B', scored: false, importance: 'recommended', weight: 2, title: 'An Accept header excluding HTML and markdown returns 406' },
  { id: 'B12', category: 'B', scored: false, importance: 'recommended', weight: 2, title: 'X-AEO-Version advertises the spec version implemented' },
  { id: 'B13', category: 'B', scored: true, importance: 'required', weight: 9, title: 'The original HTML URL is still reachable and unaffected' },
  {
    id: 'B14',
    category: 'B',
    scored: false,
    importance: 'required',
    weight: 4,
    title: 'The served markdown still matches the live page (no drift or staleness)',
  },
];

/** @type {Map<string, CheckDefinition>} */
const BY_ID = new Map(CHECKS.map((c) => [c.id, c]));

/**
 * @param {string} id
 * @returns {CheckDefinition}
 */
export function checkDefinition(id) {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown check id: ${id}`);
  return found;
}

/**
 * @param {string} id
 * @param {string} reason
 * @param {string} [detail]
 * @returns {CheckResult}
 */
export function pass(id, reason, detail) {
  const definition = checkDefinition(id);
  return { ...definition, status: 'pass', earned: definition.weight, reason, detail };
}

/**
 * @param {string} id
 * @param {string} reason
 * @param {string} [detail]
 * @param {string} [fix]
 * @returns {CheckResult}
 */
export function fail(id, reason, detail, fix) {
  return { ...checkDefinition(id), status: 'fail', earned: 0, reason, detail, fix };
}

/**
 * Some of the way there.
 *
 * `earned` is clamped into `1..weight - 1` on purpose: a partial worth zero is a failure wearing a
 * friendlier word, and a partial worth full marks is a pass. Both would make the report's own
 * arithmetic ("2 of 4") read as nonsense, and the clamp means a rounding error in a ramp can never
 * produce either.
 *
 * A `(+N)` price in `fix` is restated from the clamped value for the same reason: a caller pricing
 * from its own unclamped ramp would otherwise print "(+0)" next to a check that still owes a point.
 *
 * @param {string} id
 * @param {number} earned
 * @param {string} reason
 * @param {PartialOptions} [options]
 * @returns {CheckResult}
 */
export function partial(id, earned, reason, options = {}) {
  const definition = checkDefinition(id);
  const bounded = Math.min(definition.weight - 1, Math.max(1, Math.round(earned)));
  const fix = options.fix?.replace(/\(\+\d+\)/g, `(+${definition.weight - bounded})`);
  return { ...definition, status: 'partial', earned: bounded, reason, detail: options.detail, fix };
}

/**
 * @typedef {object} PartialOptions
 * @property {string} [detail]
 * @property {string} [fix]
 */

/**
 * Cannot be measured until something else is fixed.
 *
 * The twin cascade is the case this exists for: with no markdown twin at all, twelve checks about
 * that twin have nothing to inspect. Reporting them as twelve more failures would charge the user
 * thirteen times for one missing file; reporting them as `na` (what the code did before) told the
 * reader that a third of the audit simply did not matter. Locked says the true thing: these are
 * twelve suggestions, and one fix makes every one of them measurable.
 *
 * @param {string} id
 * @param {string} by
 * @param {string} reason
 * @param {string} [detail]
 * @returns {CheckResult}
 */
export function locked(id, by, reason, detail) {
  return { ...checkDefinition(id), status: 'locked', earned: 0, reason, detail, lockedBy: by };
}

/**
 * @param {string} id
 * @param {string} reason
 * @param {string} [detail]
 * @returns {CheckResult}
 */
export function na(id, reason, detail) {
  return { ...checkDefinition(id), status: 'na', earned: 0, reason, detail };
}

/**
 * A linear ramp between a floor and a target, in points.
 *
 * Used by the measured checks (word counts, TTFB, drift) where the honest answer is a number on a
 * continuum rather than a threshold. At or past `target` is the full weight; at or below `floor` is
 * zero; in between is proportional, and the caller decides whether zero means fail or partial.
 *
 * @param {number} value
 * @param {number} floor
 * @param {number} target
 * @param {number} weight
 * @returns {number}
 */
export function ramp(value, floor, target, weight) {
  if (target === floor) return value >= target ? weight : 0;
  const ratio = (value - floor) / (target - floor);
  return Math.max(0, Math.min(weight, ratio * weight));
}
