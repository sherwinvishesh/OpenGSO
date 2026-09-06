import type { AiBot } from '../shared/bots.js';
import { ERRORS } from '../shared/errors.js';
import { parseUrl } from '../shared/http.js';
import type { AiProvider, ProviderOverrides } from '../shared/providers.js';
import type { ProviderFn } from '../generate/ai.js';
import type { DiscoveryResult } from './discover.js';
import { discoverTwins } from './discover.js';
import type { ContentReview } from './quality.js';
import { reviewContent } from './quality.js';
import type { TestResult } from './run.js';
import { testUrl } from './run.js';

/**
 * The three shapes a test run can take, and the single function that runs all of them.
 *
 * There are two genuinely different questions to ask about a site, and conflating them was the old
 * design's mistake:
 *
 * - **structure** is the deterministic audit. Is the twin reachable, is the content type right, does
 *   `Vary` include `Accept`. Free, offline-friendly, reproducible, and the only thing that produces
 *   the 0-100 score.
 * - **content** is the language model's read on the documents themselves. Is the product actually
 *   defined, are the words someone would search for present, is it specific. Costs money, needs a
 *   key, and is never reproducible to the decimal.
 * - **full** is both, in that order, because the second needs the first: the structural pass is what
 *   finds the documents. A run with no key still gets the structural half and a note saying why the
 *   content half did not happen, rather than an error where a report should be.
 *
 * The CLI and the dashboard both call this. Neither has its own copy of the sequencing, which is
 * why the two can never disagree about what "run the full test" means.
 */

export type TestMode = 'full' | 'structure' | 'content';

export const TEST_MODES: readonly TestMode[] = ['full', 'structure', 'content'];

export function isTestMode(value: unknown): value is TestMode {
  return typeof value === 'string' && (TEST_MODES as readonly string[]).includes(value);
}

/** Everything the content pass needs. Absent means it cannot run, which is a reportable state. */
export interface SuiteAi {
  provider: AiProvider;
  apiKey: string;
  model?: string;
  overrides?: ProviderOverrides;
  /** Injectable so tests never touch the network. */
  call?: ProviderFn;
}

export interface SuiteOptions {
  mode: TestMode;
  timeoutMs?: number;
  /** Built-ins plus the project's own crawlers, so A1 judges robots.txt against both. */
  bots?: readonly AiBot[];
  /** Absent means the content pass reports "no key" instead of running. */
  ai?: SuiteAi;
  /**
   * The caller asked for the content pass by name (`-q`, or the dashboard's own toggle). Turns a
   * missing key from a note into a refusal, because silently doing less than was asked for is the
   * one outcome nobody can debug.
   */
  requireContent?: boolean;
  /** How many documents get reviewed. Every one is a paid call. */
  maxDocs?: number;
  /** How many candidate URLs discovery will fetch before giving up on a huge sitemap. */
  maxFetch?: number;
  onProgress?: (event: SuiteProgress) => void;
  /** Overridable only so the CI guard itself is testable. */
  env?: Record<string, string | undefined>;
}

export type SuiteProgress =
  | { phase: 'structure' }
  // Carries the finished structural result so a terminal can print the report the moment it exists,
  // rather than making the user watch a blank screen through a minute of paid AI calls.
  | { phase: 'structure-done'; result: TestResult }
  | { phase: 'discover' }
  | { phase: 'discovered'; documents: number }
  | { phase: 'review'; done: number; total: number; url: string };

export interface SuiteResult {
  mode: TestMode;
  url: string;
  /** Absent only in `content` mode, which never runs the checks. */
  structure?: TestResult;
  discovery?: DiscoveryResult;
  content?: ContentReview;
  /**
   * Why the content pass did not run. A note, not a failure: in `full` mode this is the normal
   * outcome for the majority of users, who have no key and did not ask for one.
   */
  contentSkipped?: string;
  /** The content pass was attempted and failed. Distinct from skipped, and worth an exit code. */
  contentError?: string;
}

export async function runTestSuite(target: string, options: SuiteOptions): Promise<SuiteResult> {
  const url = parseUrl(target);
  if (!url) throw new Error(ERRORS.invalidUrl(target));

  const structure = options.mode === 'content' ? undefined : await runStructure(url, options);
  const result: SuiteResult = { mode: options.mode, url: url.toString(), structure };
  if (options.mode === 'structure') return result;

  // In `full` mode a missing key is expected and must not read as an error. In `content` mode the
  // user asked for exactly this one thing, so refusing loudly is the honest answer.
  if (!options.ai) {
    const message = ERRORS.noApiKey(options.mode === 'content' ? 'test --content' : 'the content review');
    if (options.mode === 'content' || options.requireContent) result.contentError = message;
    else result.contentSkipped = message;
    return result;
  }

  options.onProgress?.({ phase: 'discover' });
  const discovery = await discoverTwins(url, {
    timeoutMs: options.timeoutMs,
    evidence: structure?.evidence,
    maxFetch: options.maxFetch,
  });
  result.discovery = discovery;
  options.onProgress?.({ phase: 'discovered', documents: discovery.twins.length });

  if (discovery.twins.length === 0) {
    result.contentError = noDocuments(url, discovery);
    return result;
  }

  try {
    result.content = await reviewContent(discovery.twins, {
      provider: options.ai.provider,
      apiKey: options.ai.apiKey,
      model: options.ai.model,
      overrides: options.ai.overrides,
      call: options.ai.call,
      timeoutMs: options.timeoutMs,
      maxDocuments: options.maxDocs,
      env: options.env,
      onProgress: (done, total, reviewed) => options.onProgress?.({ phase: 'review', done, total, url: reviewed }),
    });
  } catch (error) {
    result.contentError = error instanceof Error ? error.message : String(error);
  }
  return result;
}

async function runStructure(url: URL, options: SuiteOptions): Promise<TestResult> {
  options.onProgress?.({ phase: 'structure' });
  const result = await testUrl(url.toString(), { timeoutMs: options.timeoutMs, bots: options.bots });
  options.onProgress?.({ phase: 'structure-done', result });
  return result;
}

/**
 * "Nothing to review" has several causes and the user can only act on the specific one, so the
 * message names what was tried and what came back rather than saying no markdown was found.
 */
function noDocuments(url: URL, discovery: DiscoveryResult): string {
  const lines = [`No Markdown documents to review on ${url.origin}.`];
  if (discovery.rejected.length > 0) {
    lines.push('', 'Tried:');
    for (const item of discovery.rejected.slice(0, 5)) lines.push(`  ${item.url} - ${item.reason}`);
    if (discovery.rejected.length > 5) lines.push(`  ...and ${discovery.rejected.length - 5} more`);
  }
  lines.push(
    '',
    discovery.sources.llms || discovery.sources.sitemap
      ? 'The site publishes llms.txt or sitemap.xml, but none of the documents they point at came back as Markdown.'
      : 'The site publishes neither llms.txt nor sitemap.xml, so there was nothing to enumerate.',
    '',
    'Run `opengeo generate <url>` to write the twins first, then review them.',
  );
  return lines.join('\n');
}

/** The exit code a suite result deserves. Structural failures decide it whenever there was one. */
export function suiteExitCode(result: SuiteResult): number {
  if (result.structure) return result.structure.score.counts.fail === 0 ? 0 : 1;
  return result.contentError ? 1 : 0;
}
