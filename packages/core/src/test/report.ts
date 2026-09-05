import { c, SYM, heading } from '../shared/log.js';
import type { CheckResult } from './checks.js';
import type { QualityReview } from './quality.js';
import type { Score } from './score.js';
import type { TestResult } from './index.js';

/**
 * Terminal rendering of a test run (§5).
 *
 * Failures come first and carry the specific reason, because the reason is the product: "no
 * llms.txt at https://site/llms.txt" is actionable, "llms.txt: FAIL" is not.
 */

export interface ReportOptions {
  /** Print passing checks too. Off by default so failures are not buried. */
  verbose?: boolean;
}

export function renderReport(result: TestResult, options: ReportOptions = {}): string {
  const lines: string[] = [];
  const { checks, score } = result;

  lines.push('');
  lines.push(`${c.bold('OpenGEO')} ${c.gray('test')}  ${result.url}`);
  if (result.framework) lines.push(c.gray(`Detected: ${result.framework.name}`));
  lines.push(renderScore(score));

  const failedRequired = checks.filter((r) => r.status === 'fail' && r.importance === 'required');
  const failedRecommended = checks.filter((r) => r.status === 'fail' && r.importance === 'recommended');
  const passed = checks.filter((r) => r.status === 'pass');
  const skipped = checks.filter((r) => r.status === 'na');

  if (failedRequired.length > 0) {
    lines.push(heading(`Failed - required (${failedRequired.length})`));
    for (const check of failedRequired) lines.push(...renderCheck(check));
  }
  if (failedRecommended.length > 0) {
    lines.push(heading(`Failed - recommended (${failedRecommended.length})`));
    for (const check of failedRecommended) lines.push(...renderCheck(check));
  }
  if (passed.length > 0) {
    if (options.verbose) {
      lines.push(heading(`Passed (${passed.length})`));
      for (const check of passed) lines.push(...renderCheck(check));
    } else {
      lines.push(heading(`Passed (${passed.length})`));
      lines.push(`  ${c.gray(passed.map((check) => check.id).join(' '))}`);
      lines.push(`  ${c.gray('Re-run with --verbose to see why each one passed.')}`);
    }
  }
  if (skipped.length > 0) {
    lines.push(heading(`Not applicable (${skipped.length})`));
    for (const check of skipped) {
      lines.push(`  ${SYM.na()} ${c.bold(check.id)} ${check.title}`);
      lines.push(`      ${c.gray(check.reason)}`);
    }
  }

  lines.push('');
  if (failedRequired.length + failedRecommended.length > 0) {
    lines.push(c.gray(`Run the same command with --prompt to get a fix prompt for Claude Code.`));
    lines.push('');
  }
  return lines.join('\n');
}

function renderCheck(check: CheckResult): string[] {
  const symbol = check.status === 'pass' ? SYM.pass() : check.status === 'fail' ? SYM.fail() : SYM.na();
  const points = check.status === 'fail' ? c.gray(`  -${check.weight} pts`) : '';
  const lines = [`  ${symbol} ${c.bold(check.id)} ${check.title}${points}`, `      ${check.reason}`];
  if (check.detail) lines.push(`      ${c.gray(check.detail)}`);
  return lines;
}

function renderScore(score: Score): string {
  const value = String(score.value).padStart(3, ' ');
  const colour = score.value >= 85 ? c.green : score.value >= 60 ? c.yellow : c.red;
  const bar = renderBar(score.value);
  const counts = c.gray(
    `${score.counts.pass} passed, ${score.counts.fail} failed${score.counts.na > 0 ? `, ${score.counts.na} n/a` : ''}`,
  );
  return `\n  ${colour(c.bold(`${value}/100`))}  ${bar}  ${counts}\n`;
}

function renderBar(value: number): string {
  const width = 24;
  const filled = Math.round((value / 100) * width);
  const colour = value >= 85 ? c.green : value >= 60 ? c.yellow : c.red;
  return `${colour('#'.repeat(filled))}${c.gray('.'.repeat(width - filled))}`;
}

/** Machine-readable output for `--json` and for the product website's local API. */
export function toJson(result: TestResult, quality?: QualityReview): string {
  return JSON.stringify(
    {
      url: result.url,
      score: result.score.value,
      earned: result.score.earned,
      possible: result.score.possible,
      twinUrl: result.twinUrl,
      framework: result.framework ? { id: result.framework.id, name: result.framework.name } : null,
      checks: result.checks.map((check) => ({
        id: check.id,
        title: check.title,
        category: check.category,
        importance: check.importance,
        weight: check.weight,
        status: check.status,
        reason: check.reason,
        detail: check.detail,
      })),
      // Its own key, never merged into `score`: a deterministic audit and a model's opinion are
      // different kinds of claim, and a consumer should have to opt into reading the second.
      quality: quality ?? null,
    },
    null,
    2,
  );
}

/**
 * The quality review, rendered as its own block.
 *
 * Kept visually distinct on purpose (§5): it sits after the score and the checks, under its own
 * heading, with its own 1-5 rating clearly labelled as the model's opinion. Nothing here is added
 * to, subtracted from, or averaged into the number above it.
 */
export function renderQuality(review: QualityReview): string {
  const lines: string[] = [];
  lines.push(heading('Content quality (AI review, separate from the score above)'));
  lines.push(`  ${c.gray(`${review.provider} ${review.model}`)}`);
  lines.push('');

  if (review.raw) {
    lines.push(`  ${review.summary}`);
    lines.push('');
    for (const line of review.raw.split('\n')) lines.push(`  ${c.gray(line)}`);
    lines.push('');
    return lines.join('\n');
  }

  if (review.rating !== undefined) {
    lines.push(`  ${c.bold(`${review.rating}/5`)} ${c.gray("the model's own read, not part of the 0-100 score")}`);
    lines.push('');
  }
  lines.push(`  ${review.summary}`);
  lines.push('');

  for (const finding of review.findings) {
    lines.push(`  ${c.bold(finding.area)}`);
    lines.push(`      ${finding.note}`);
  }
  if (review.findings.length > 0) lines.push('');

  if (review.suggestions.length > 0) {
    lines.push(`  ${c.bold('Suggestions')}`);
    for (const suggestion of review.suggestions) lines.push(`      - ${suggestion}`);
    lines.push('');
  }
  return lines.join('\n');
}
