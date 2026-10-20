import { c, SYM, heading, terminalSafe } from '../shared/log.js';
import { adoptionMeter, meter, sparkline } from '../shared/render/meters.js';
import { PALETTE, scoreInk, bandColour, contentBand, ink } from '../shared/render/theme.js';
import { BODY_INDENT, fg, indentWrapped, terminalWidth, wrap as wrapText } from '../shared/render/paint.js';
import { deltaFor, relativeAge, scoreTrend } from '../shared/history.js';
import { areaWeight, qualityBand } from './quality.js';
import { fixSteps, isSuggestion, scoreGain } from './score.js';

// The JSON side lives in its own file; re-exported so `@opengeo/core/test` offers the same names.
export { suiteJson, testJson, toJson } from './report-json.js';

/**
 * @import { History } from '../shared/history.js'
 * @import { CheckResult } from './checks.js'
 * @import {
 *   AggregatedRecommendation,
 *   ContentReview,
 *   DocumentReview,
 *   Priority,
 *   QualityFinding,
 *   QualityRecommendation,
 *   QualityReview,
 * } from './quality.js'
 * @import { DiscoveryResult } from './discover.js'
 * @import { FixStep, Score } from './score.js'
 * @import { TestResult } from './run.js'
 */

/**
 * Terminal rendering of a test run (§5).
 *
 * Failures come first and carry the specific reason, because the reason is the product: "no
 * llms.txt at https://site/llms.txt" is actionable, "llms.txt: FAIL" is not.
 */

/**
 * @typedef {object} ReportOptions
 * @property {boolean} [verbose] Print passing checks too. Off by default so failures are not buried.
 * @property {History} [history] Previous runs, for the delta and the sparkline.
 *
 *   Optional everywhere: the report has to render identically for a caller that has no project
 *   directory to read a history out of, which is every `opengeo test <url>` against someone else's
 *   site.
 * @property {number} [width] Overridden only by tests, which have no terminal to measure.
 */

/**
 * @param {TestResult} result
 * @param {ReportOptions} [options]
 * @returns {string}
 */
export function renderReport(result, options = {}) {
  result = terminalSafe(result);
  /** @type {string[]} */
  const lines = [];
  const { checks, score } = result;
  const width = options.width ?? terminalWidth();

  lines.push('');
  lines.push(`${c.bold('OpenGEO')} ${c.gray('test')}  ${result.url}`);
  if (result.framework) lines.push(c.gray(`Detected: ${result.framework.name}`));
  lines.push(renderScore(result.url, score, options));

  const failed = checks.filter((r) => r.scored && r.status === 'fail');
  const partly = checks.filter((r) => r.scored && r.status === 'partial');
  const suggested = checks.filter(isSuggestion).sort((a, b) => b.weight - a.weight);
  const blocked = checks.filter((r) => r.status === 'locked');
  const passed = checks.filter((r) => r.scored && r.status === 'pass');
  const adopted = checks.filter((r) => !r.scored && r.status === 'pass');
  const skipped = checks.filter((r) => r.status === 'na');

  if (failed.length > 0) {
    lines.push(heading(`Failed (${failed.length})`));
    for (const check of failed) lines.push(...renderCheck(check, score, width));
  }
  if (partly.length > 0) {
    lines.push(heading(`Partly there (${partly.length})`));
    for (const check of partly) lines.push(...renderCheck(check, score, width));
  }
  if (suggested.length > 0) {
    lines.push(heading(`Suggestions (${suggested.length})`));
    lines.push(...indentWrapped(SUGGESTIONS_INTRO, width, c.gray));
    lines.push('');
    for (const check of suggested) lines.push(...renderCheck(check, score, width));
  }
  if (blocked.length > 0) lines.push(...renderLocked(blocked, score, width));
  lines.push(...renderPassing('Passed', passed, score, width, options.verbose));
  lines.push(...renderPassing('Adopted', adopted, score, width, options.verbose));
  if (skipped.length > 0) {
    lines.push(heading(`Not applicable (${skipped.length})`));
    for (const check of skipped) {
      lines.push(`  ${SYM.na()} ${c.bold(check.id)} ${check.title}`);
      lines.push(...indentWrapped(check.reason, width, c.gray));
    }
  }

  lines.push(...renderNextSteps(checks, score, width));
  return lines.join('\n');
}

/**
 * What the Suggestions group is, in one line. Printed under its heading because a reader who has
 * just seen 100/100 deserves to know why there is still a list.
 */
export const SUGGESTIONS_INTRO =
  'Conventions for AI agents this page has not adopted. They are outside the score: the best-read sites have not adopted them either, so these are what would set this one apart.';

/**
 * The passing checks: ids on one line by default, every reason with --verbose. Passed and Adopted
 * are separate groups because one is the score and the other is the suggestions, and a reader
 * counting to seven should not have to subtract.
 *
 * @param {string} title
 * @param {CheckResult[]} checks
 * @param {Score} score
 * @param {number} width
 * @param {boolean | undefined} verbose
 * @returns {string[]}
 */
function renderPassing(title, checks, score, width, verbose) {
  if (checks.length === 0) return [];
  const lines = [heading(`${title} (${checks.length})`)];
  if (verbose) {
    for (const check of checks) lines.push(...renderCheck(check, score, width));
    return lines;
  }
  lines.push(`  ${c.gray(checks.map((check) => check.id).join(' '))}`);
  lines.push(`  ${c.gray('Re-run with --verbose to see why each one passed.')}`);
  return lines;
}

/**
 * One check, at whatever width the terminal actually is.
 *
 * The reason is the product, so it is the thing that gets the space: it wraps rather than running
 * off the right edge, which is what it did before at any width under about 120 columns. A partial
 * carries its arithmetic (`2 of 4`) because "partly there" with no number is a mood, not a
 * measurement, and anything short of a pass carries its `fix` line last, since that is the part the
 * reader is going to act on.
 *
 * A scored fail is priced in score points, the headline's unit, not by its weight: a check's weight
 * is out of 61 and the headline is out of 100. A suggestion carries no price, because adopting it
 * moves no score. A partial's `2 of 4` stays in weight, because it is the check's own arithmetic
 * rather than a price.
 *
 * @param {CheckResult} check
 * @param {Score} score
 * @param {number} width
 * @returns {string[]}
 */
function renderCheck(check, score, width) {
  const symbol =
    isSuggestion(check) ? SYM.suggestion()
    : check.status === 'pass' ? SYM.pass()
    : check.status === 'fail' ? SYM.fail()
    : check.status === 'partial' ? SYM.partial()
    : check.status === 'locked' ? SYM.locked()
    : SYM.na();

  const tail =
    check.status === 'fail' && check.scored ? c.gray(`  -${check.price ?? scoreGain(score, check.weight)} pts`)
    : check.status === 'partial'
      ? `  ${meter((check.earned / check.weight) * 100, 8)} ${c.yellow(`${check.earned} of ${check.weight}`)}`
      : '';

  const lines = [`  ${symbol} ${c.bold(check.id)} ${check.title}${tail}`];
  lines.push(...indentWrapped(check.reason, width));
  if (check.detail) lines.push(...indentWrapped(check.detail, width, c.gray));
  if (check.fix) lines.push(...indentHanging(glyphArrow(), check.fix, width, ink.info));
  return lines;
}

/**
 * The twin cascade, as one block.
 *
 * This is the section the whole `locked` status exists for. Twelve paragraphs each explaining
 * that a document which does not exist cannot be inspected is not information; the same twelve
 * checks, counted and labelled with the single thing that unlocks them, is.
 *
 * @param {CheckResult[]} blocked
 * @param {Score} score
 * @param {number} width
 * @returns {string[]}
 */
function renderLocked(blocked, score, width) {
  /** @type {string[]} */
  const lines = [];
  const blockers = score.locked.unlockedBy.join(' and ') || 'one fix';
  lines.push(heading(`Locked (${blocked.length})`));
  lines.push(
    `  ${c.bold(fg(PALETTE.info, `${blocked.length} more ${blocked.length === 1 ? 'suggestion applies' : 'suggestions apply'}`))} ${c.gray('once')} ${c.bold(blockers)} ${c.gray('passes')}`,
  );

  // One sentence naming the fix, taken from the check that is actually blocking, so this stays
  // correct if the cascade is ever keyed on something other than B1.
  if (score.locked.unlockedBy[0] === 'B1') {
    lines.push(...indentWrapped('Serve a markdown twin at the .md URL and every one of these becomes measurable. `opengeo generate` writes the files; `opengeo prod` serves them.', width, c.gray));
  }
  lines.push('');
  // The ids and their weights on one line: enough to see the shape of what is waiting without
  // twelve paragraphs of it.
  const priced = blocked.map((check) => `${c.bold(check.id)} ${c.gray(String(check.weight))}`).join('  ');
  lines.push(`  ${priced}  ${c.gray('(check weights)')}`);
  return lines;
}

/**
 * The two lines of a report that setup can afford to show, and no more.
 *
 * Onboarding used to end on three commands to go and try, which is a homework list handed to
 * somebody who has just answered four questions. This ends it on the number instead: what the site
 * scores right now, and the ranked fixes that move it. It is deliberately the report's own
 * `renderScore` and `renderNextSteps` rather than a smaller copy of them, because a second
 * implementation of "how many points is this worth" is exactly how the two start disagreeing.
 *
 * @param {TestResult} result
 * @param {ReportOptions} [options]
 * @returns {string}
 */
export function renderSetupScore(result, options = {}) {
  result = terminalSafe(result);
  const width = options.width ?? terminalWidth();
  const lines = [renderScore(result.url, result.score, options)];
  lines.push(...renderNextSteps(result.checks, result.score, width));
  return `${lines.join('\n')}\n`;
}

/**
 * What to do next: scored fixes by points recovered, then the suggestions by weight.
 *
 * The ranking comes from `fixSteps`, which the fix prompt and the dashboard use too, so the three
 * cannot disagree about what comes first. `lost` carries a partial's shortfall rather than its
 * weight, so a check two points from full does not outrank one that earned nothing, and the twin's
 * own step says how many more suggestions it makes measurable rather than listing them.
 *
 * @param {readonly CheckResult[]} checks
 * @param {Score} score
 * @param {number} width
 * @returns {string[]}
 */
function renderNextSteps(checks, score, width) {
  /** @type {string[]} */
  const lines = [''];
  const steps = fixSteps(checks, score);
  const fixes = steps.filter((step) => !step.suggestion);
  const ideas = steps.filter((step) => step.suggestion);

  if (fixes.length === 0) {
    lines.push(`  ${ink.ok(ideas.length > 0 ? 'Nothing to fix. Every scored check passed.' : 'Nothing to fix. Every check that applies to this URL passed.')}`);
    lines.push('');
  } else {
    lines.push(`  ${c.bold('Do this next')} ${c.gray('(most points first)')}`);
    lines.push('');
    lines.push(...renderSteps(fixes.slice(0, MAX_NEXT_STEPS), width, true));
    const rest = fixes.slice(MAX_NEXT_STEPS);
    if (rest.length > 0) {
      // Priced together rather than summed, since rounding makes score points not quite additive.
      const restPoints = scoreGain(score, rest.reduce((sum, step) => sum + step.recovered, 0));
      lines.push(`  ${c.gray(`plus ${rest.length} smaller ${rest.length === 1 ? 'fix' : 'fixes'} worth ${restPoints} between them: ${rest.map((step) => step.id).join(' ')}`)}`);
    }
    lines.push('');
  }

  if (ideas.length > 0) {
    // Fewer of these than of the fixes: once the score is handled, the first suggestion or two is
    // the decision, and the full list is already printed above.
    const shown = ideas.slice(0, fixes.length === 0 ? MAX_NEXT_STEPS : MAX_NEXT_IDEAS);
    lines.push(`  ${c.bold(fixes.length === 0 ? 'Worth adopting next' : 'Then, to stand out')} ${c.gray('(suggestions, outside the score)')}`);
    lines.push('');
    lines.push(...renderSteps(shown, width, fixes.length === 0));
    const rest = ideas.slice(shown.length);
    if (rest.length > 0) lines.push(`  ${c.gray(`plus ${rest.length} more: ${rest.map((step) => step.id).join(' ')}`)}`);
    lines.push('');
  }

  if (fixes.length === 0 && ideas.length === 0) return lines;
  lines.push(c.gray('Run the same command with --prompt to get a fix prompt for Claude Code.'));
  lines.push('');
  return lines;
}

/**
 * @param {FixStep[]} steps
 * @param {number} width
 * @param {boolean} emphasiseFirst
 * @returns {string[]}
 */
function renderSteps(steps, width, emphasiseFirst) {
  /** @type {string[]} */
  const lines = [];
  // Measured rather than counted by hand: two spaces, the four-wide price, two, the three-wide id,
  // two. A literal here drifts the moment any of those five change, and a hanging indent that is
  // one column out is more distracting than no hanging indent at all.
  const gutter = ' '.repeat(2 + NEXT_POINTS_WIDTH + 2 + NEXT_ID_WIDTH + 2);
  for (const [index, step] of steps.entries()) {
    const wrapped = wrapText(step.text, Math.max(24, width - gutter.length - 2));
    // Green throughout, because every number in this column is points coming back rather than
    // points lost. A suggestion has no points to show, so its column says what it is instead.
    const left = step.suggestion ? ink.info('tip'.padStart(NEXT_POINTS_WIDTH)) : ink.accent(`+${step.points}`.padStart(NEXT_POINTS_WIDTH));
    const paint = emphasiseFirst && index === 0 ? c.bold : (/** @type {string} */ line) => line;
    lines.push(`  ${left}  ${c.bold(step.id.padEnd(NEXT_ID_WIDTH))}  ${paint(wrapped[0] ?? '')}`);
    for (const line of wrapped.slice(1)) lines.push(`${gutter}${paint(line)}`);
  }
  return lines;
}

/** More than this and the ranking stops being a decision and starts being the report again. */
const NEXT_POINTS_WIDTH = 4;
const NEXT_ID_WIDTH = 3;
const MAX_NEXT_STEPS = 5;
const MAX_NEXT_IDEAS = 2;

/**
 * The same, with the continuation lines hanging under the first line's text rather than its marker.
 *
 * @param {string} marker
 * @param {string} text
 * @param {number} width
 * @param {(value: string) => string} paint
 * @returns {string[]}
 */
function indentHanging(marker, text, width, paint) {
  const pad = ' '.repeat(marker.length + 1);
  const gutter = ' '.repeat(BODY_INDENT);
  const wrapped = wrapText(text, Math.max(20, width - BODY_INDENT - pad.length));
  return wrapped.map((line, index) => `${gutter}${paint(index === 0 ? `${marker} ${line}` : `${pad}${line}`)}`);
}

/**
 * @returns {string}
 */
function glyphArrow() {
  return process.env.OPENGEO_ASCII ? '->' : '→';
}

/**
 * The headline: score, meter, how many scored checks passed, where the suggestions stand, and what
 * changed since last time.
 *
 * Two numbers, on purpose. The first is whether an agent can read the page today; the second is
 * how much of the agent-specific layer the site has adopted, which is what OpenGEO itself adds. A
 * well-built site with no twin reads 100/100 and 2 of 15, and both halves of that are true.
 *
 * @param {string} url
 * @param {Score} score
 * @param {ReportOptions} options
 * @returns {string}
 */
function renderScore(url, score, options) {
  const value = String(score.value).padStart(3, ' ');
  const bar = meter(score.value, 24, { scale: 'structural' });
  const { scored } = score;
  const parts = [`${scored.pass} of ${scored.count} scored checks passed`];
  if (scored.partial > 0) parts.push(`${scored.partial} partial`);
  if (scored.fail > 0) parts.push(`${scored.fail} failed`);
  if (score.counts.na > 0) parts.push(`${score.counts.na} n/a`);

  const headline = `  ${scoreInk(score.value, c.bold(`${value}/100`))}  ${bar}  ${c.gray(parts.join(', '))}`;
  const lines = [headline];
  const { suggestions } = score;
  if (suggestions.count > 0) {
    const label = 'ideas'.padStart(value.length + 4);
    const detail = [`${suggestions.adopted} of ${suggestions.count} suggestions adopted`];
    if (suggestions.locked > 0) detail.push(`${suggestions.locked} waiting on ${score.locked.unlockedBy.join(' and ') || 'one fix'}`);
    lines.push(`  ${c.gray(label)}  ${adoptionMeter(suggestions.adopted, suggestions.locked, suggestions.count, 24)}  ${c.gray(detail.join(', '))}`);
  }
  const trend = renderTrend(url, score, options);
  if (trend) lines.push(trend);
  return `\n${lines.join('\n')}\n`;
}

/**
 * "+11 since 2h ago", with a sparkline of the runs before it.
 *
 * Compared against the last run of *this* URL only. Testing localhost and then production and
 * calling the difference progress would be a lie the headline then prints in green.
 *
 * @param {string} url
 * @param {Score} score
 * @param {ReportOptions} options
 * @returns {string | undefined}
 */
function renderTrend(url, score, options) {
  const history = options.history;
  if (!history || history.entries.length === 0) return undefined;

  const delta = deltaFor(history, { at: new Date().toISOString(), url, mode: 'structure', score: score.value });
  if (!delta) return undefined;

  const trend = scoreTrend(history, url);
  const spark = trend.length >= 2 ? `  ${sparkline([...trend, score.value])}` : '';
  const moved =
    delta.points > 0 ? ink.ok(`+${delta.points}`)
    : delta.points < 0 ? ink.danger(String(delta.points))
    : c.gray('no change');
  return `  ${moved} ${c.gray(`since ${relativeAge(delta.previous.at)}`)}${spark}`;
}

/**
 * The quality review of one document, rendered as its own block.
 *
 * Kept visually distinct on purpose (§5): it sits after the structural score and the checks, under
 * its own heading, with its own 0-100 clearly labelled as a different measurement. The two numbers
 * answer different questions - is the Markdown served correctly, and is it worth reading - and
 * nothing here is added to, subtracted from, or averaged into the one above it.
 *
 * @param {QualityReview} review
 * @param {{ heading?: string }} [options]
 * @returns {string}
 */
export function renderQuality(review, options = {}) {
  review = terminalSafe(review);
  /** @type {string[]} */
  const lines = [];
  lines.push(heading(options.heading ?? 'Content quality (AI review, separate from the score above)'));
  lines.push(`  ${c.gray(`${review.provider} ${review.model}`)}`);
  lines.push('');

  if (review.raw) {
    lines.push(`  ${review.summary}`);
    lines.push('');
    for (const line of review.raw.split('\n')) lines.push(`  ${c.gray(line)}`);
    lines.push('');
    return lines.join('\n');
  }

  if (review.score !== undefined) {
    lines.push(renderContentScore(review.score, 'this document'));
    lines.push('');
  }
  lines.push(`  ${review.summary}`);
  lines.push('');

  for (const finding of review.findings) lines.push(...renderFinding(finding));
  if (review.findings.length > 0) lines.push('');

  if (review.recommendations.length > 0) {
    lines.push(`  ${c.bold('What to change')}`);
    lines.push('');
    review.recommendations.forEach((recommendation, index) => {
      lines.push(...renderRecommendation(recommendation, index + 1));
    });
  }
  return lines.join('\n');
}

/**
 * One area line: what it scored, and what the gap is costing out of 100.
 *
 * @param {QualityFinding} finding
 * @returns {string[]}
 */
function renderFinding(finding) {
  const weight = areaWeight(finding.area);
  const value =
    finding.score === undefined
      ? c.gray('unscored')
      : `${bar(finding.score, 10)}  ${scoreColour(finding.score)(`${finding.score}/100`)}${
          weight === undefined ? '' : c.gray(`  -${Math.round((weight * (100 - finding.score)) / 100)}`)
        }`;
  return [`  ${c.bold(finding.area.padEnd(AREA_WIDTH))} ${value}`, `      ${finding.note}`];
}

/**
 * One edit, numbered.
 *
 * Priority, action, where, why, in that order, because that is the order somebody deciding whether
 * to do it now reads them in. `where` is printed even when it is only a heading: the difference
 * between "add prices" and "add prices under ## Plans" is the difference between a note and a task.
 *
 * @param {AggregatedRecommendation | QualityRecommendation} recommendation
 * @param {number} index
 * @returns {string[]}
 */
function renderRecommendation(recommendation, index) {
  /** @type {string[]} */
  const lines = [];
  const documents = 'documents' in recommendation ? recommendation.documents : [];
  lines.push(`  ${c.bold(String(index).padStart(2))}  ${priorityTag(recommendation.priority)} ${c.gray(recommendation.area)}`);
  lines.push(`      ${recommendation.action}`);
  if (recommendation.impact) lines.push(`      ${c.gray(recommendation.impact)}`);
  // Two URLs is enough to show that an edit is not local to one page. Ten is a wrapped line that
  // buries the edit itself, and the full list is in --json anyway.
  const shown = documents.slice(0, 2);
  const more = documents.length > shown.length ? [`+${documents.length - shown.length} more`] : [];
  const place = [recommendation.where, ...shown, ...more].filter(Boolean).join('  ');
  if (place) lines.push(`      ${c.cyan(place)}`);
  lines.push('');
  return lines;
}

/**
 * @param {Priority} priority
 * @returns {string}
 */
function priorityTag(priority) {
  const colour = priority === 'high' ? c.red : priority === 'medium' ? c.yellow : c.gray;
  return colour(priority.padEnd(6));
}

/**
 * The multi-document content review, and the second of OpenGEO's two numbers.
 *
 * Score, then where the missing points are, then what to do about them, then the documents. A
 * review that says "8 documents, 62/100" and stops is a dashboard metric, not a tool: the thing
 * the reader can act on is which area is costing them and which edit fixes it, so that leads and
 * the per-document detail follows.
 *
 * @param {ContentReview} review
 * @param {DiscoveryResult} [discovery]
 * @returns {string}
 */
export function renderContentReport(review, discovery) {
  review = terminalSafe(review);
  discovery = terminalSafe(discovery);
  /** @type {string[]} */
  const lines = [];
  const reviewed = review.documents.filter((doc) => doc.review);
  const failed = review.documents.filter((doc) => doc.error);

  lines.push(heading('Content quality (AI review, never part of the 0-100 structural score)'));
  lines.push(
    `  ${c.gray(`${review.provider} ${review.model}`)}  ${c.gray(
      `${reviewed.length} document${reviewed.length === 1 ? '' : 's'} reviewed`,
    )}`,
  );
  if (review.score !== undefined) {
    lines.push('');
    lines.push(renderContentScore(review.score, `across ${reviewed.length} document${reviewed.length === 1 ? '' : 's'}`));
    lines.push(`      ${c.gray(qualityBand(review.score))}`);
  }
  lines.push('');

  if (review.areaScores.length > 0) {
    const lost = review.areaScores.reduce((total, area) => total + area.lost, 0);
    lines.push(`  ${c.bold('Where the points went')} ${c.gray(`(${lost} lost, costliest first)`)}`);
    for (const area of review.areaScores) {
      const cost = c.gray((area.weight === undefined ? '-' : `-${area.lost}`).padStart(3));
      const of = c.gray(area.weight === undefined ? '  own area' : ` of ${String(area.weight).padStart(2)}`);
      lines.push(`      ${area.area.padEnd(AREA_WIDTH)} ${bar(area.score, 10)}  ${scoreColour(area.score)(`${String(area.score).padStart(3)}/100`)}  ${cost}${of}`);
    }
    lines.push('');
  }

  if (review.recommendations.length > 0) {
    const shown = review.recommendations.slice(0, MAX_RECOMMENDATIONS);
    lines.push(`  ${c.bold('What to change first')}`);
    lines.push('');
    shown.forEach((recommendation, index) => lines.push(...renderRecommendation(recommendation, index + 1)));
    if (review.recommendations.length > shown.length) {
      lines.push(`      ${c.gray(`...and ${review.recommendations.length - shown.length} more, in --json.`)}`);
      lines.push('');
    }
  }

  const ordered = [...review.documents].sort((a, b) => (a.review?.score ?? 999) - (b.review?.score ?? 999));
  lines.push(`  ${c.bold('By document')} ${c.gray('(weakest first)')}`);
  lines.push('');
  /** @type {Set<string>} */
  const explained = new Set();
  for (const document of ordered) lines.push(...renderDocument(document, explained));

  if (failed.length > 0) {
    lines.push(`  ${c.yellow(`${failed.length} document${failed.length === 1 ? '' : 's'} could not be reviewed.`)}`);
    lines.push('');
  }
  if (review.notReviewed > 0) {
    lines.push(`  ${c.gray(`${review.notReviewed} more found but not reviewed. Raise the cap with --max-docs.`)}`);
    lines.push('');
  }
  if (discovery && discovery.rejected.length > 0) {
    lines.push(`  ${c.bold('Not Markdown')}`);
    for (const item of discovery.rejected.slice(0, 8)) lines.push(`      ${c.gray(`${item.url} - ${item.reason}`)}`);
    if (discovery.rejected.length > 8) lines.push(`      ${c.gray(`...and ${discovery.rejected.length - 8} more`)}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * @param {DocumentReview} document
 * @param {Set<string>} explained The first lines of errors already printed in full. Ten documents
 *   failing on one mistyped model id need the provider's reason and the fix once, not ten times.
 * @returns {string[]}
 */
function renderDocument(document, explained) {
  /** @type {string[]} */
  const lines = [];
  const words = c.gray(`${document.words} words, via ${document.source}`);

  if (document.error) {
    const [first = '', ...rest] = document.error.split('\n');
    const width = terminalWidth();
    lines.push(`  ${SYM.warn()} ${c.bold(document.url)}  ${words}`);
    lines.push(...wrapText(first, Math.max(24, width - 6)).map((part) => `      ${part}`));
    if (!explained.has(first)) {
      explained.add(first);
      for (const line of rest) {
        if (line.trim()) lines.push(...wrapText(line.trim(), Math.max(24, width - 8)).map((part) => `        ${c.gray(part)}`));
      }
    }
    lines.push('');
    return lines;
  }

  const review = document.review;
  if (!review) return lines;

  const score = review.score === undefined ? c.gray('  unscored') : scoreColour(review.score)(c.bold(`${String(review.score).padStart(3)}/100`));
  lines.push(`  ${score}  ${c.bold(document.url)}  ${words}`);
  lines.push(`      ${review.summary}`);

  if (review.raw) {
    for (const line of review.raw.split('\n').slice(0, 12)) lines.push(`      ${c.gray(line)}`);
    lines.push('');
    return lines;
  }

  // The per-area notes and the edits are already summarised above, so a document line stays short:
  // its score, what it is, and the areas that are actually weak on this particular page.
  for (const finding of review.findings.filter((entry) => (entry.score ?? 100) < WEAK_AREA)) {
    lines.push(`      ${c.gray(`${finding.area} ${finding.score}/100`)}  ${finding.note}`);
  }
  lines.push('');
  return lines;
}

/** Widest area label plus a space, so the score column lines up whatever the model called them. */
const AREA_WIDTH = 14;
/** Below this an area is worth naming again under the document it belongs to. */
const WEAK_AREA = 70;
/** More than this in the terminal is a wall of text. The rest stay in `--json`. */
const MAX_RECOMMENDATIONS = 6;

/**
 * @param {number} score
 * @param {string} label
 * @returns {string}
 */
function renderContentScore(score, label) {
  return `  ${scoreColour(score)(c.bold(`${String(score).padStart(3)}/100`))}  ${bar(score, 24)}  ${c.gray(`content, ${label}`)}`;
}

/**
 * @param {number} score
 * @returns {(text: string) => string}
 */
function scoreColour(score) {
  const band = contentBand(score);
  return band === 'good' ? c.green : band === 'fair' ? c.yellow : c.red;
}

/**
 * @param {number} score
 * @param {number} width
 * @returns {string}
 */
function bar(score, width) {
  const filled = Math.round((score / 100) * width);
  return `${scoreColour(score)('#'.repeat(filled))}${c.gray('.'.repeat(width - filled))}`;
}

/**
 * What discovery found, before any of it is reviewed. Printed in `--content` mode and whenever a
 * run turns up nothing, because "which documents did you even look at" is the first question.
 *
 * @param {DiscoveryResult} discovery
 * @returns {string}
 */
export function renderDiscovery(discovery) {
  discovery = terminalSafe(discovery);
  /** @type {string[]} */
  const lines = [];
  lines.push(heading(`Markdown documents found (${discovery.twins.length})`));
  for (const twin of discovery.twins) {
    lines.push(`  ${c.bold(twin.url)}`);
    lines.push(`      ${c.gray(`${twin.words} words, ${twin.bytes} bytes, via ${twin.source}`)}`);
  }
  if (discovery.twins.length === 0) lines.push(`  ${c.gray('none')}`);
  lines.push('');
  return lines.join('\n');
}
