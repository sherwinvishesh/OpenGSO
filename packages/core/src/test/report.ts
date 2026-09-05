import { c, SYM, heading } from '../shared/log.js';
import type { CheckResult } from './checks.js';
import type { Score } from './score.js';
import type { TestResult } from './index.js';

/**
 * Terminal rendering of a test run (idea.md §5).
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
export function toJson(result: TestResult): string {
  return JSON.stringify(
    {
      url: result.url,
      score: result.score.value,
      earned: result.score.earned,
      possible: result.score.possible,
      twinUrl: result.twinUrl,
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
    },
    null,
    2,
  );
}
