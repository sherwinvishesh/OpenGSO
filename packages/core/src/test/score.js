/** @import { CheckResult } from './checks.js' */

/**
 * The 0-100 score (§5), over the scored checks only.
 *
 * No letter grade, no tier label - deliberately. Three kinds of check stay outside the denominator,
 * for different reasons:
 *
 * - `na`, because the question does not apply here and never will (HSTS on localhost), so a local
 *   dev run and a production run are both honest numbers rather than one being permanently capped.
 * - `locked`, because it cannot be *asked* yet: with no markdown twin there is nothing to inspect for
 *   a Content-Type on, and charging for that would charge one missing file thirteen times.
 * - a suggestion, because it is a convention the best-read sites have not adopted either, so not
 *   having it is not a defect. Suggestions are counted on their own, adopted against open, so the
 *   report can say where the page stands on them without moving the number.
 *
 * @typedef {object} Score
 * @property {number} value
 * @property {number} earned
 * @property {number} possible Sum of the weights of the scored checks that returned pass, partial or fail.
 * @property {{ pass: number; partial: number; fail: number; locked: number; na: number }} counts Every check's verdict,
 *   scored or not, so the five add up to the whole catalogue.
 * @property {{ count: number; pass: number; partial: number; fail: number }} scored The scored checks by verdict, which
 *   is what the headline counts. `count` leaves out the ones that cannot apply here.
 * @property {Array<{ id: string; points: number }>} lost Weight lost, per scored check, for the fix prompt and the
 *   ranked footer.
 *
 *   A partial contributes its shortfall rather than its weight, so a check worth 4 that earned 2
 *   appears here as 2. That is what makes the "do this next" list a genuine ranking: the two points
 *   still available from a partial should not outrank the ten behind a check that earned nothing.
 * @property {{ count: number; adopted: number; open: number; locked: number }} suggestions Where the page stands on the
 *   conventions outside the score. `count` leaves out the ones that cannot apply here; `open` is a fail or a partial.
 * @property {{ count: number; unlockedBy: string[] }} locked What is waiting behind a failed prerequisite. `count` is
 *   zero on a healthy run.
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
  const suggestions = { count: 0, adopted: 0, open: 0, locked: 0 };
  const scored = { count: 0, pass: 0, partial: 0, fail: 0 };
  /** @type {Set<string>} */
  const lockedBy = new Set();

  for (const result of results) {
    counts[result.status] += 1;
    if (result.status === 'na') continue;
    if (result.status === 'locked') {
      if (result.lockedBy) lockedBy.add(result.lockedBy);
      if (!result.scored) {
        suggestions.count += 1;
        suggestions.locked += 1;
      }
      continue;
    }
    if (!result.scored) {
      suggestions.count += 1;
      if (result.status === 'pass') suggestions.adopted += 1;
      else suggestions.open += 1;
      continue;
    }
    possible += result.weight;
    earned += result.earned;
    scored.count += 1;
    scored[result.status] += 1;
    if (result.status !== 'pass') lost.push({ id: result.id, points: result.weight - result.earned });
  }

  // Rounded once, at the end. Rounding each check's contribution first would let a page of
  // near-misses round its way to a score it did not earn.
  const value = possible === 0 ? 0 : Math.round((earned / possible) * 100);
  return {
    value,
    earned: Math.round(earned),
    possible,
    counts,
    scored,
    lost,
    suggestions,
    locked: { count: counts.locked, unlockedBy: [...lockedBy] },
  };
}

/**
 * How far the 0-100 headline moves if `recovered` check weight is earned back, all of it passing.
 *
 * The scored weights total 61 and the headline is out of 100, so a weight is not a score point: a
 * fix printed as "+9" against an 85/100 headline moves it by 15. Every price the report shows goes
 * through here, so there is one currency. It is the change in the rounded headline, floored at 1 so
 * a real gain never reads as "+0" when rounding happens to swallow it.
 *
 * @param {Score} score
 * @param {number} recovered
 * @returns {number}
 */
export function scoreGain(score, recovered) {
  if (recovered <= 0) return 0;
  // `score.earned` is rounded for display; the unrounded figure is the denominator minus what is lost.
  const earned = score.possible - score.lost.reduce((sum, entry) => sum + entry.points, 0);
  const after = score.possible === 0 ? 0 : Math.round(((earned + recovered) / score.possible) * 100);
  return Math.max(1, after - score.value);
}

/** The price a check writes into its `fix`, in check weight, until `priceFixes` restates it. */
const PRICE = /\s*\(\+\d+\)/g;

/**
 * A fix line without the "(+N)" price it carries.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripPrice(text) {
  return text.replace(PRICE, '');
}

/**
 * Price every scored fail and partial in score points, and rewrite the "(+N)" its `fix` carries to
 * match.
 *
 * The checks write their price as a weight, because a check cannot know the denominator. Once the
 * run is scored it can be said in the headline's unit. A suggestion keeps its fix and loses its
 * price, since adopting it moves no score. A locked check loses it too: nothing can be said about it
 * until its blocker passes.
 *
 * @param {readonly CheckResult[]} checks
 * @param {Score} score
 * @returns {CheckResult[]}
 */
export function priceFixes(checks, score) {
  return checks.map((check) => {
    if (!check.scored || (check.status !== 'fail' && check.status !== 'partial')) {
      return check.fix ? { ...check, fix: stripPrice(check.fix) } : check;
    }
    const price = scoreGain(score, check.weight - check.earned);
    return { ...check, price, fix: check.fix?.replace(PRICE, ` (+${price})`) };
  });
}

/**
 * A check that fell short and is not part of the score: a convention the page could adopt.
 *
 * @param {Pick<CheckResult, 'scored' | 'status'>} check
 * @returns {boolean}
 */
export function isSuggestion(check) {
  return !check.scored && (check.status === 'fail' || check.status === 'partial');
}

/**
 * Suggestions that failed on a twin the site already serves.
 *
 * Not a convention waiting to be adopted: the site adopted it, and what agents are sent is wrong (a
 * twin gone stale, a header that went missing). It stays outside the score like every suggestion, so
 * the headline does not move, but the report, the fix prompt and the dashboard put it first and say
 * what it is rather than filing it with the ideas for standing out. `--strict` fails a build on it.
 *
 * @param {readonly CheckResult[]} checks
 * @returns {CheckResult[]}
 */
export function twinFaults(checks) {
  if (!checks.some((check) => check.id === 'B1' && check.status === 'pass')) return [];
  return checks.filter((check) => isSuggestion(check) && check.status === 'fail' && check.category === 'B');
}

/**
 * Open suggestions, twin faults first and then heaviest first, so a broken twin is never ranked
 * below a header the site has yet to add.
 *
 * @param {readonly CheckResult[]} checks
 * @returns {CheckResult[]}
 */
export function rankedSuggestions(checks) {
  const faults = new Set(twinFaults(checks).map((check) => check.id));
  return checks
    .filter(isSuggestion)
    .sort((a, b) => Number(faults.has(b.id)) - Number(faults.has(a.id)) || b.weight - a.weight);
}

/**
 * One entry in the "do this next" list.
 *
 * @typedef {object} FixStep
 * @property {string} id
 * @property {number} points Score points recovered. Zero for a suggestion.
 * @property {number} recovered Check weight recovered, so the steps left over can be priced together.
 * @property {string} text The check's fix, without its price, since the list prints the price as its own column.
 * @property {number} unlocks How many locked checks this one makes measurable.
 * @property {boolean} [suggestion]
 * @property {boolean} [fault] A suggestion failing on a twin the site already serves (`twinFaults`).
 */

/**
 * What to do next: the scored fixes ranked by score points recovered, most first, then the open
 * suggestions: a twin already served but failing first, then by weight, so the markdown twin (the
 * one that unlocks the rest) leads them.
 *
 * Every step is returned and the renderer decides how many to show. The terminal report, the fix
 * prompt and the dashboard all rank from here, so they cannot disagree about what comes first.
 *
 * @param {readonly CheckResult[]} checks
 * @param {Score} score
 * @returns {FixStep[]}
 */
export function fixSteps(checks, score) {
  const byId = new Map(checks.map((check) => [check.id, check]));
  /** @param {string} id */
  const unlocks = (id) => (score.locked.unlockedBy.includes(id) ? score.locked.count : 0);

  /** @type {FixStep[]} */
  const fixes = score.lost.map((entry) => {
    const check = byId.get(entry.id);
    return {
      id: entry.id,
      points: scoreGain(score, entry.points),
      recovered: entry.points,
      text: stripPrice(check?.fix ?? check?.title ?? entry.id),
      unlocks: unlocks(entry.id),
    };
  });
  fixes.sort((a, b) => b.points - a.points);

  const faults = new Set(twinFaults(checks).map((check) => check.id));
  /** @type {FixStep[]} */
  const suggestions = rankedSuggestions(checks).map((check) => {
    const count = unlocks(check.id);
    let text = stripPrice(check.fix ?? check.title);
    if (count > 0) text = `${text} That also makes ${count} more suggestion${count === 1 ? '' : 's'} measurable.`;
    return { id: check.id, points: 0, recovered: 0, text, unlocks: count, suggestion: true, ...(faults.has(check.id) ? { fault: true } : {}) };
  });

  return [...fixes, ...suggestions];
}

/**
 * Whether a run should fail the build.
 *
 * By default only a scored check that failed outright does: a partial is half the work genuinely
 * done, and a suggestion is a convention most good sites have not adopted, so neither is a broken
 * build. `strict` adds every open suggestion that failed, for a project that has adopted the
 * markdown layer and wants CI to notice the day it stops being served.
 *
 * @param {readonly CheckResult[]} checks
 * @param {{ strict?: boolean }} [options]
 * @returns {boolean}
 */
export function failsBuild(checks, options = {}) {
  return checks.some((check) => check.status === 'fail' && (check.scored || options.strict === true));
}
