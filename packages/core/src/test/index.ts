import type { AiBot } from '../shared/bots.js';
import { parseUrl } from '../shared/http.js';
import { ERRORS } from '../shared/errors.js';
import type { CheckResult } from './checks.js';
import type { Evidence } from './evidence.js';
import { gatherEvidence } from './evidence.js';
import type { Framework } from './framework.js';
import { detectFrameworkFrom } from './framework.js';
import { runChecks } from './runner.js';
import type { Score } from './score.js';
import { scoreChecks } from './score.js';

export * from './checks.js';
export * from './evidence.js';
export * from './framework.js';
export * from './prompt.js';
export * from './quality.js';
export * from './report.js';
export * from './runner.js';
export * from './score.js';

export interface TestResult {
  url: string;
  twinUrl: string;
  checks: CheckResult[];
  score: Score;
  evidence: Evidence;
  /** Undefined when nothing matched. No check's result depends on this. */
  framework?: Framework;
}

export interface TestOptions {
  timeoutMs?: number;
  /** Built-ins plus the project's own crawlers, so A1 judges robots.txt against both. */
  bots?: readonly AiBot[];
}

export async function testUrl(target: string, options: TestOptions = {}): Promise<TestResult> {
  const url = parseUrl(target);
  if (!url) throw new Error(ERRORS.invalidUrl(target));
  const evidence = await gatherEvidence(url, { timeoutMs: options.timeoutMs, bots: options.bots });
  return testEvidence(evidence);
}

/** Split out so tests can score synthetic evidence without any network access. */
export function testEvidence(evidence: Evidence): TestResult {
  const checks = runChecks(evidence);
  return {
    url: evidence.target.toString(),
    twinUrl: evidence.twinUrl,
    framework: detectFrameworkFrom(evidence.html),
    checks,
    score: scoreChecks(checks),
    evidence,
  };
}
