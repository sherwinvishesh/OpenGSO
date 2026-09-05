/**
 * The check catalogue (§5).
 *
 * Category A asks "can AI find and understand this site at all". Category B asks "is the markdown
 * twin actually being served correctly" - it is the same contract opengeo-prod implements in §7,
 * which is why both sides share the header constants in shared/version.ts.
 *
 * Weights are an implementation detail per §5, but the shape is fixed: required checks outweigh
 * recommended ones, and a check that cannot apply (HSTS on localhost) is marked n/a and dropped
 * from the denominator rather than silently scored as a failure.
 */

export type CheckCategory = 'A' | 'B';
export type CheckImportance = 'required' | 'recommended';
export type CheckStatus = 'pass' | 'fail' | 'na';

export interface CheckDefinition {
  id: string;
  category: CheckCategory;
  importance: CheckImportance;
  /** What the check verifies, in plain language. Shown in the CLI and the product website. */
  title: string;
  weight: number;
}

export interface CheckResult extends CheckDefinition {
  status: CheckStatus;
  /** The specific reason this check passed, failed, or did not apply. Never a generic string. */
  reason: string;
  /** Optional extra context: an observed header value, a measured number. */
  detail?: string;
}

export const CHECKS: readonly CheckDefinition[] = [
  // ---- A. General AI-discoverability -------------------------------------------------------
  { id: 'A1', category: 'A', importance: 'required', weight: 10, title: 'robots.txt exists and does not disallow known AI bots' },
  { id: 'A2', category: 'A', importance: 'required', weight: 8, title: 'llms.txt is present and valid' },
  { id: 'A3', category: 'A', importance: 'required', weight: 6, title: 'sitemap.xml is present and valid' },
  { id: 'A4', category: 'A', importance: 'recommended', weight: 4, title: 'Schema.org JSON-LD is present and parses' },
  { id: 'A5', category: 'A', importance: 'required', weight: 10, title: 'Real content is in the raw HTML, not only after JS runs' },
  { id: 'A6', category: 'A', importance: 'recommended', weight: 3, title: 'Time to first byte is fast enough for agent fetches' },
  { id: 'A7', category: 'A', importance: 'required', weight: 6, title: 'No noai / noimageai tag is silently blocking AI' },
  { id: 'A8', category: 'A', importance: 'recommended', weight: 3, title: 'Served over HTTPS with HSTS' },

  // ---- B. Implementation correctness ---------------------------------------------------------
  { id: 'B1', category: 'B', importance: 'required', weight: 10, title: 'Markdown twin URL is reachable and returns 2xx' },
  { id: 'B2', category: 'B', importance: 'required', weight: 6, title: 'Content-Type is exactly text/markdown; charset=utf-8' },
  { id: 'B3', category: 'B', importance: 'required', weight: 5, title: 'Markdown response body is non-empty' },
  { id: 'B4', category: 'B', importance: 'recommended', weight: 3, title: 'X-Markdown-Tokens is present and a positive integer' },
  { id: 'B5', category: 'B', importance: 'recommended', weight: 2, title: 'X-Content-Type-Options: nosniff is present' },
  { id: 'B6', category: 'B', importance: 'required', weight: 4, title: 'X-Robots-Tag on the twin includes noindex' },
  { id: 'B7', category: 'B', importance: 'required', weight: 6, title: 'Vary includes Accept, so CDNs cache the two formats separately' },
  { id: 'B8', category: 'B', importance: 'recommended', weight: 4, title: 'HTML response advertises the twin via Link rel="alternate"' },
  { id: 'B9', category: 'B', importance: 'required', weight: 8, title: 'Accept: text/markdown receives markdown, not HTML' },
  { id: 'B10', category: 'B', importance: 'required', weight: 8, title: 'A known AI bot User-Agent receives markdown without an Accept header' },
  { id: 'B11', category: 'B', importance: 'recommended', weight: 2, title: 'An Accept header excluding HTML and markdown returns 406' },
  { id: 'B12', category: 'B', importance: 'recommended', weight: 2, title: 'X-AEO-Version advertises the spec version implemented' },
  { id: 'B13', category: 'B', importance: 'required', weight: 5, title: 'The original HTML URL is still reachable and unaffected' },
  {
    id: 'B14',
    category: 'B',
    importance: 'required',
    weight: 5,
    title: 'The served markdown still matches the live page (no drift or staleness)',
  },
];

const BY_ID = new Map(CHECKS.map((c) => [c.id, c]));

export function checkDefinition(id: string): CheckDefinition {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown check id: ${id}`);
  return found;
}

export function pass(id: string, reason: string, detail?: string): CheckResult {
  return { ...checkDefinition(id), status: 'pass', reason, detail };
}

export function fail(id: string, reason: string, detail?: string): CheckResult {
  return { ...checkDefinition(id), status: 'fail', reason, detail };
}

export function na(id: string, reason: string, detail?: string): CheckResult {
  return { ...checkDefinition(id), status: 'na', reason, detail };
}
