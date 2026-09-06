import type { CheckResult } from './checks.js';

/**
 * The 0-100 score (§5).
 *
 * No letter grade, no tier label - deliberately. Checks that cannot apply to this target (HSTS on
 * localhost) are dropped from the denominator instead of counting as failures, so a local dev run
 * and a production run are both honest numbers rather than one being permanently capped.
 *
 * Two statuses are outside the denominator, for different reasons. `na` is out because the question
 * does not apply here and never will. `locked` is out because the question cannot be *asked* yet:
 * with no markdown twin there is nothing to inspect for a Content-Type on, and charging thirteen
 * separate failures for one missing file would take a site from 80 to 38 for a single fix. What the
 * score does instead is carry those points as a number the report can show: `locked.points` is what
 * comes into play the moment the prerequisite passes.
 */
export interface Score {
  value: number;
  earned: number;
  possible: number;
  counts: { pass: number; partial: number; fail: number; locked: number; na: number };
  /**
   * Points lost, per check, for the fix prompt and the ranked footer.
   *
   * A partial contributes its shortfall rather than its weight, so a check worth 4 that earned 2
   * appears here as 2. That is what makes the "do this next" list a genuine ranking: the two points
   * still available from a partial should not outrank the ten behind a check that earned nothing.
   */
  lost: Array<{ id: string; points: number }>;
  /** What is waiting behind a failed prerequisite. `count` is zero on a healthy run. */
  locked: { count: number; points: number; unlockedBy: string[] };
}

export function scoreChecks(results: readonly CheckResult[]): Score {
  let earned = 0;
  let possible = 0;
  const counts = { pass: 0, partial: 0, fail: 0, locked: 0, na: 0 };
  const lost: Score['lost'] = [];
  const lockedIds = new Set<string>();
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
  return {
    value,
    earned: Math.round(earned),
    possible,
    counts,
    lost,
    locked: { count: counts.locked, points: lockedPoints, unlockedBy: [...lockedIds] },
  };
}
