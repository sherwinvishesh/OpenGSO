/**
 * The check catalogue (§5).
 *
 * Category A asks "can AI find and understand this site at all". Category B asks "is the markdown
 * twin actually being served correctly" - it is the same contract opengeo-prod implements in §7,
 * which is why both sides share the header constants in shared/version.ts.
 *
 * Weights are an implementation detail per §5, but the shape is fixed: required checks outweigh
 * recommended ones, and a check that cannot apply (HSTS on localhost) is marked n/a and dropped
 * from the denominator rather than silently scored as a failure.
 *
 * The table is calibrated, not guessed. Two properties are deliberate:
 *
 * 1. **B1 is the only double-digit check.** Serving the markdown twin is the one thing this whole
 *    toolkit exists for, so it is the single largest line in the scale and the first thing the
 *    report tells you to fix. Everything else is worth single digits, which means no individual
 *    header detail can sink a site that got the important things right.
 * 2. **A site that does the fundamentals well scores in the 80s without OpenGEO installed.** The
 *    checks any site can pass on its own - robots access, a sitemap, real content in the HTML, a
 *    fast first byte, no silent opt-out, HTTPS, an HTML page that still works for humans - carry
 *    most of the scale. Measured against the real web: anthropic.com and openai.com both land at
 *    80/100, which is the honest answer. They are well built and an agent can read them; what they
 *    do not have is the markdown layer, and that is exactly the 20 points they are missing.
 *
 * A scale where every good site scores 38 tells the user nothing. `tests/score.test.ts` pins both
 * properties so a future weight edit cannot quietly break the calibration.
 */

export type CheckCategory = 'A' | 'B';
export type CheckImportance = 'required' | 'recommended';
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
 * - `pass`   full weight earned.
 * - `partial` some of the weight earned, with a `fix` naming the rest.
 * - `fail`   nothing earned. Counted against the score, and the only status that fails a build.
 * - `locked` not measurable until `lockedBy` passes. Out of the denominator, like `na`, but
 *            unlike `na` it is worth points the user can go and unlock, and the report prices it.
 * - `na`     genuinely cannot apply here. HSTS on localhost. Out of the denominator forever.
 */
export type CheckStatus = 'pass' | 'partial' | 'fail' | 'locked' | 'na';

export interface CheckDefinition {
  id: string;
  category: CheckCategory;
  importance: CheckImportance;
  /** What the check verifies, in plain language. Shown in the CLI and the product website. */
  title: string;
  weight: number;
}

export interface CheckResult extends CheckDefinition {
  status: CheckStatus;
  /**
   * Points actually earned, from 0 to `weight`.
   *
   * `pass` is the full weight and `fail` is zero, so the binary checks need no thought. It exists
   * as its own field rather than being derived from the status because a partial has no other
   * place to put the number, and because the report has to be able to print "2 of 4" without
   * knowing which band produced it.
   */
  earned: number;
  /** The specific reason this check passed, failed, or did not apply. Never a generic string. */
  reason: string;
  /** Optional extra context: an observed header value, a measured number. */
  detail?: string;
  /**
   * The next step, for anything short of a pass.
   *
   * Written as an instruction and priced, e.g. "Add `Vary: Accept` to the HTML response too (+2)".
   * The report's ranked footer is built from these, which is why a `fix` that only restates the
   * problem is worse than none at all.
   */
  fix?: string;
  /** `locked` only: the id of the check that has to pass before this one can be measured. */
  lockedBy?: string;
}

export const CHECKS: readonly CheckDefinition[] = [
  // ---- A. General AI-discoverability -------------------------------------------------------
  { id: 'A1', category: 'A', importance: 'required', weight: 9, title: 'robots.txt exists and does not disallow known AI bots' },
  { id: 'A2', category: 'A', importance: 'recommended', weight: 3, title: 'llms.txt is present and valid' },
  { id: 'A3', category: 'A', importance: 'required', weight: 9, title: 'sitemap.xml is present and valid' },
  { id: 'A4', category: 'A', importance: 'recommended', weight: 2, title: 'Schema.org JSON-LD is present and parses' },
  { id: 'A5', category: 'A', importance: 'required', weight: 9, title: 'Real content is in the raw HTML, not only after JS runs' },
  { id: 'A6', category: 'A', importance: 'required', weight: 8, title: 'Time to first byte is fast enough for agent fetches' },
  { id: 'A7', category: 'A', importance: 'required', weight: 8, title: 'No noai / noimageai tag is silently blocking AI' },
  { id: 'A8', category: 'A', importance: 'required', weight: 9, title: 'Served over HTTPS with HSTS' },

  // ---- B. Implementation correctness ---------------------------------------------------------
  { id: 'B1', category: 'B', importance: 'required', weight: 10, title: 'Markdown twin URL is reachable and returns 2xx' },
  { id: 'B2', category: 'B', importance: 'required', weight: 5, title: 'Content-Type is exactly text/markdown; charset=utf-8' },
  { id: 'B3', category: 'B', importance: 'required', weight: 5, title: 'Markdown response body is non-empty' },
  { id: 'B4', category: 'B', importance: 'recommended', weight: 3, title: 'X-Markdown-Tokens is present and a positive integer' },
  { id: 'B5', category: 'B', importance: 'recommended', weight: 3, title: 'X-Content-Type-Options: nosniff is present' },
  { id: 'B6', category: 'B', importance: 'required', weight: 3, title: 'X-Robots-Tag on the twin includes noindex' },
  { id: 'B7', category: 'B', importance: 'required', weight: 4, title: 'Vary includes Accept, so CDNs cache the two formats separately' },
  { id: 'B8', category: 'B', importance: 'recommended', weight: 3, title: 'HTML response advertises the twin via Link rel="alternate"' },
  { id: 'B9', category: 'B', importance: 'required', weight: 6, title: 'Accept: text/markdown receives markdown, not HTML' },
  { id: 'B10', category: 'B', importance: 'required', weight: 6, title: 'A known AI bot User-Agent receives markdown without an Accept header' },
  { id: 'B11', category: 'B', importance: 'recommended', weight: 2, title: 'An Accept header excluding HTML and markdown returns 406' },
  { id: 'B12', category: 'B', importance: 'recommended', weight: 2, title: 'X-AEO-Version advertises the spec version implemented' },
  { id: 'B13', category: 'B', importance: 'required', weight: 9, title: 'The original HTML URL is still reachable and unaffected' },
  {
    id: 'B14',
    category: 'B',
    importance: 'required',
    weight: 4,
    title: 'The served markdown still matches the live page (no drift or staleness)',
  },
];

const BY_ID = new Map(CHECKS.map((c) => [c.id, c]));

export function checkDefinition(id: string): CheckDefinition {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown check id: ${id}`);
  return found;
}

export function pass(id: string, reason: string, detail?: string): CheckResult {
  const definition = checkDefinition(id);
  return { ...definition, status: 'pass', earned: definition.weight, reason, detail };
}

export function fail(id: string, reason: string, detail?: string, fix?: string): CheckResult {
  return { ...checkDefinition(id), status: 'fail', earned: 0, reason, detail, fix };
}

/**
 * Some of the way there.
 *
 * `earned` is clamped into `1..weight - 1` on purpose: a partial worth zero is a failure wearing a
 * friendlier word, and a partial worth full marks is a pass. Both would make the report's own
 * arithmetic ("2 of 4") read as nonsense, and the clamp means a rounding error in a ramp can never
 * produce either.
 */
export function partial(id: string, earned: number, reason: string, options: PartialOptions = {}): CheckResult {
  const definition = checkDefinition(id);
  const bounded = Math.min(definition.weight - 1, Math.max(1, Math.round(earned)));
  return { ...definition, status: 'partial', earned: bounded, reason, detail: options.detail, fix: options.fix };
}

export interface PartialOptions {
  detail?: string;
  fix?: string;
}

/**
 * Cannot be measured until something else is fixed.
 *
 * The twin cascade is the case this exists for: with no markdown twin at all, thirteen checks about
 * that twin's headers have nothing to inspect. Reporting them as thirteen separate failures would
 * charge the user thirteen times for one missing file; reporting them as `na` (what the code did
 * before) told the reader that a third of the audit simply did not matter. Locked says the true
 * thing: these are worth 45 points and one fix unlocks all of them.
 */
export function locked(id: string, by: string, reason: string, detail?: string): CheckResult {
  return { ...checkDefinition(id), status: 'locked', earned: 0, reason, detail, lockedBy: by };
}

export function na(id: string, reason: string, detail?: string): CheckResult {
  return { ...checkDefinition(id), status: 'na', earned: 0, reason, detail };
}

/**
 * A linear ramp between a floor and a target, in points.
 *
 * Used by the measured checks (word counts, TTFB, drift) where the honest answer is a number on a
 * continuum rather than a threshold. At or past `target` is the full weight; at or below `floor` is
 * zero; in between is proportional, and the caller decides whether zero means fail or partial.
 */
export function ramp(value: number, floor: number, target: number, weight: number): number {
  if (target === floor) return value >= target ? weight : 0;
  const ratio = (value - floor) / (target - floor);
  return Math.max(0, Math.min(weight, ratio * weight));
}
