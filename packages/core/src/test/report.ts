import { c, SYM, heading } from '../shared/log.js';
import type { CheckResult } from './checks.js';
import type {
  AggregatedRecommendation,
  ContentReview,
  DocumentReview,
  Priority,
  QualityFinding,
  QualityRecommendation,
  QualityReview,
} from './quality.js';
import { areaWeight, qualityBand } from './quality.js';
import type { DiscoveryResult } from './discover.js';
import type { SuiteResult } from './suite.js';
import type { Score } from './score.js';
import type { TestResult } from './run.js';

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
export function testJson(result: TestResult): Record<string, unknown> {
  return {
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
  };
}

export interface JsonExtras {
  /** A single-document review, from the older one-URL path. */
  quality?: QualityReview;
  /** The multi-document content pass. */
  content?: ContentReview;
  discovery?: DiscoveryResult;
  mode?: string;
  contentSkipped?: string;
  contentError?: string;
}

export function toJson(result: TestResult | undefined, extras: JsonExtras = {}): string {
  return JSON.stringify(
    {
      ...(result ? testJson(result) : {}),
      mode: extras.mode ?? (result ? 'structure' : 'content'),
      // Its own key, never merged into `score`: a deterministic audit and a model's opinion are
      // different kinds of claim, and a consumer should have to opt into reading the second.
      quality: extras.quality ?? null,
      content: extras.content ?? null,
      discovery: extras.discovery
        ? {
            documents: extras.discovery.twins.map((twin) => ({
              url: twin.url,
              pageUrl: twin.pageUrl ?? null,
              source: twin.source,
              bytes: twin.bytes,
              words: twin.words,
            })),
            rejected: extras.discovery.rejected,
            overCap: extras.discovery.overCap,
            sources: extras.discovery.sources,
          }
        : null,
      contentSkipped: extras.contentSkipped ?? null,
      contentError: extras.contentError ?? null,
    },
    null,
    2,
  );
}

/** The whole suite as JSON, so `--json` says the same thing in every mode. */
export function suiteJson(result: SuiteResult): string {
  return toJson(result.structure, {
    mode: result.mode,
    content: result.content,
    discovery: result.discovery,
    contentSkipped: result.contentSkipped,
    contentError: result.contentError,
  });
}

/**
 * The quality review of one document, rendered as its own block.
 *
 * Kept visually distinct on purpose (§5): it sits after the structural score and the checks, under
 * its own heading, with its own 0-100 clearly labelled as a different measurement. The two numbers
 * answer different questions - is the Markdown served correctly, and is it worth reading - and
 * nothing here is added to, subtracted from, or averaged into the one above it.
 */
export function renderQuality(review: QualityReview, options: { heading?: string } = {}): string {
  const lines: string[] = [];
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

/** One area line: what it scored, and what the gap is costing out of 100. */
function renderFinding(finding: QualityFinding): string[] {
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
 */
function renderRecommendation(recommendation: AggregatedRecommendation | QualityRecommendation, index: number): string[] {
  const lines: string[] = [];
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

function priorityTag(priority: Priority): string {
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
 */
export function renderContentReport(review: ContentReview, discovery?: DiscoveryResult): string {
  const lines: string[] = [];
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
  for (const document of ordered) lines.push(...renderDocument(document));

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

function renderDocument(document: DocumentReview): string[] {
  const lines: string[] = [];
  const words = c.gray(`${document.words} words, via ${document.source}`);

  if (document.error) {
    lines.push(`  ${SYM.warn()} ${c.bold(document.url)}  ${words}`);
    lines.push(`      ${document.error.split('\n')[0]}`);
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

function renderContentScore(score: number, label: string): string {
  return `  ${scoreColour(score)(c.bold(`${String(score).padStart(3)}/100`))}  ${bar(score, 24)}  ${c.gray(`content, ${label}`)}`;
}

function scoreColour(score: number): (text: string) => string {
  return score >= 75 ? c.green : score >= 50 ? c.yellow : c.red;
}

function bar(score: number, width: number): string {
  const filled = Math.round((score / 100) * width);
  return `${scoreColour(score)('#'.repeat(filled))}${c.gray('.'.repeat(width - filled))}`;
}

/**
 * What discovery found, before any of it is reviewed. Printed in `--content` mode and whenever a
 * run turns up nothing, because "which documents did you even look at" is the first question.
 */
export function renderDiscovery(discovery: DiscoveryResult): string {
  const lines: string[] = [];
  lines.push(heading(`Markdown documents found (${discovery.twins.length})`));
  for (const twin of discovery.twins) {
    lines.push(`  ${c.bold(twin.url)}`);
    lines.push(`      ${c.gray(`${twin.words} words, ${twin.bytes} bytes, via ${twin.source}`)}`);
  }
  if (discovery.twins.length === 0) lines.push(`  ${c.gray('none')}`);
  lines.push('');
  return lines.join('\n');
}
