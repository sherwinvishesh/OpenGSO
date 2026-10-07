/** @import { CheckResult } from './checks.js' */

/**
 * The 0-100 score (§5).
 *
 * No letter grade, no tier label - deliberately. Checks that cannot apply to this target (HSTS on
 * localhost) are dropped from the denominator instead of counting as failures, so a local dev run
 * and a production run are both honest numbers rather than one being permanently capped.
 *
 * Two statuses are outside the denominator, for different reasons. `na` is out because the question
 * does not apply here and never will. `locked` is out because the question cannot be *asked* yet:
 * with no markdown twin there is nothing to inspect for a Content-Type on, and charging B1 plus
 * twelve more failures for one missing file would take a site from 80 to 38 for a single fix. What the
 * score does instead is carry those points as a number the report can show: `locked.points` is what
 * comes into play the moment the prerequisite passes.
 *
 * @typedef {object} Score
 * @property {number} value
 * @property {number} earned
 * @property {number} possible
 * @property {{ pass: number; partial: number; fail: number; locked: number; na: number }} counts
 * @property {Array<{ id: string; points: number }>} lost Points lost, per check, for the fix prompt and the ranked footer.
 *
 *   A partial contributes its shortfall rather than its weight, so a check worth 4 that earned 2
 *   appears here as 2. That is what makes the "do this next" list a genuine ranking: the two points
 *   still available from a partial should not outrank the ten behind a check that earned nothing.
 * @property {{ count: number; points: number; gain: number; unlockedBy: string[] }} locked What is waiting behind a failed prerequisite.
 *   `count` is zero on a healthy run. `points` is check weight; `gain` is the most it could add to the 0-100 headline once the
 *   blocker passes, on top of what the blocker itself adds.
 */

/**
 * @param {readonly CheckResult[]} results
 * @returns {Score}
 */
export function scoreChecks(results) {
  let earned = 0;
  let possible = 0;
  const counts = { pass: 0, partial: 0, fail: 0, locked: 0, na: 0 };
  /** @type {Score['lost']} */
  const lost = [];
  /** @type {Set<string>} */
  const lockedIds = new Set();
  let lockedPoints = 0;

  for (const result of results) {
    if (result.status === 'na') {
      counts.na += 1;
      continue;
    }
    if (result.status === 'locked') {
      counts.locked += 1;
      lockedPoints += result.weight;
      if (result.lockedBy) lockedIds.add(result.lockedBy);
      continue;
    }

    possible += result.weight;
    earned += result.earned;

    if (result.status === 'pass') {
      counts.pass += 1;
      continue;
    }
    counts[result.status === 'partial' ? 'partial' : 'fail'] += 1;
    lost.push({ id: result.id, points: result.weight - result.earned });
  }

  // Rounded once, at the end. Rounding each check's contribution first would let a page of
  // near-misses round its way to a score it did not earn.
  const value = possible === 0 ? 0 : Math.round((earned / possible) * 100);
  /** @type {Score} */
  const score = {
    value,
    earned: Math.round(earned),
    possible,
    counts,
    lost,
    locked: { count: counts.locked, points: lockedPoints, gain: 0, unlockedBy: [...lockedIds] },
  };
  // Measured from where the blocker's own fix leaves the score, since nothing is unlocked before it
  // passes. Otherwise the block and the blocker's line each claim the same points.
  const blocker = lost.filter((entry) => lockedIds.has(entry.id)).reduce((sum, entry) => sum + entry.points, 0);
  score.locked.gain = lockedPoints === 0 ? 0 : Math.max(0, scoreGain(score, blocker, lockedPoints) - scoreGain(score, blocker));
  return score;
}

/**
 * How far the 0-100 headline moves if `recovered` check weight is earned back and `unlocked` locked
 * weight comes into the denominator, all of it passing.
 *
 * Check weights total 122 and the headline is out of 100, so a weight is not a score point: a fix
 * printed as "+10" against a 78/100 headline moved it by 15. Every price the report shows goes
 * through here, so there is one currency. It is the change in the rounded headline, floored at 1 so
 * a real gain never reads as "+0" when rounding happens to swallow it.
 *
 * @param {Score} score
 * @param {number} recovered
 * @param {number} [unlocked]
 * @returns {number}
 */
export function scoreGain(score, recovered, unlocked = 0) {
  if (recovered <= 0 && unlocked <= 0) return 0;
  // `score.earned` is rounded for display; the unrounded figure is the denominator minus what is lost.
  const earned = score.possible - score.lost.reduce((sum, entry) => sum + entry.points, 0);
  const possible = score.possible + unlocked;
  const after = possible === 0 ? 0 : Math.round(((earned + recovered + unlocked) / possible) * 100);
  return Math.max(1, after - score.value);
}

/**
 * Price every fail and partial in score points, and rewrite the "(+N)" its `fix` carries to match.
 *
 * The checks write their price as a weight, because a check cannot know the denominator. Once the
 * run is scored it can be said in the headline's unit. A locked check's price is dropped: it is worth
 * nothing until its blocker passes, and the blocker's own line carries what unlocking it is worth.
 *
 * @param {readonly CheckResult[]} checks
 * @param {Score} score
 * @returns {CheckResult[]}
 */
export function priceFixes(checks, score) {
  return checks.map((check) => {
    if (check.status !== 'fail' && check.status !== 'partial') {
      return check.fix ? { ...check, fix: check.fix.replace(PRICE, '') } : check;
    }
    const price = scoreGain(score, check.weight - check.earned);
    return { ...check, price, fix: check.fix?.replace(PRICE, ` (+${price})`) };
  });
}

/** The price a check writes into its `fix`, in check weight, until `priceFixes` restates it. */
const PRICE = /\s*\(\+\d+\)/g;
