import type { CheckResult } from './checks.js';

/**
 * The 0-100 score (§5).
 *
 * No letter grade, no tier label - deliberately. Checks that cannot apply to this target (HSTS on
 * localhost) are dropped from the denominator instead of counting as failures, so a local dev run
 * and a production run are both honest numbers rather than one being permanently capped.
 */
export interface Score {
  value: number;
  earned: number;
  possible: number;
  counts: { pass: number; fail: number; na: number };
  /** Points lost, per check, for the fix prompt. */
  lost: Array<{ id: string; points: number }>;
}

export function scoreChecks(results: readonly CheckResult[]): Score {
  let earned = 0;
  let possible = 0;
  const counts = { pass: 0, fail: 0, na: 0 };
  const lost: Score['lost'] = [];

  for (const result of results) {
    if (result.status === 'na') {
      counts.na += 1;
      continue;
    }
    possible += result.weight;
    if (result.status === 'pass') {
      counts.pass += 1;
      earned += result.weight;
    } else {
      counts.fail += 1;
      lost.push({ id: result.id, points: result.weight });
    }
  }

  const value = possible === 0 ? 0 : Math.round((earned / possible) * 100);
  return { value, earned, possible, counts, lost };
}
