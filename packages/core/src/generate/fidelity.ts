/**
 * The fidelity guard behind §6's promise that the AI tier "never alters facts".
 *
 * A prompt asking a model not to change numbers is a hope, not a guarantee. This turns it into a
 * property that is actually checked: every number, date, price and percentage in the algorithmic
 * extraction has to survive into the AI output. If one goes missing, the AI output is thrown away
 * and the algorithmic markdown is written instead, with a warning saying why.
 *
 * The bias is deliberately toward false alarms. Falling back costs the user some prose polish;
 * shipping a twin that quietly says 2023 where the page says 2024 costs them the whole point of
 * the tool.
 */

export type FactKind = 'date' | 'currency' | 'percent' | 'number';

export interface FactToken {
  /** As it appeared in the text. */
  value: string;
  /** Comparison form: case-folded, separators removed, dates reduced to yyyy-mm-dd where possible. */
  canonical: string;
  kind: FactKind;
}

export interface FidelityIssue {
  code: 'missing-fact' | 'dropped-occurrences' | 'too-short' | 'missing-heading' | 'empty-output';
  severity: 'error' | 'warning';
  message: string;
}

export interface FidelityReport {
  /** False when any error-severity issue fired, which means: discard the candidate. */
  ok: boolean;
  issues: FidelityIssue[];
  errors: string[];
  warnings: string[];
  sourceFacts: FactToken[];
  /** Distinct facts present in the source but absent from the candidate. */
  missing: FactToken[];
}

export interface FidelityOptions {
  /** Candidate must keep at least this share of the source's word count. */
  minWordRatio?: number;
  /** Candidate must keep at least this share of total fact occurrences (catches dropped tables). */
  minFactOccurrenceRatio?: number;
  /** How many missing facts to name in the warning before saying "and N more". */
  maxReported?: number;
}

const MONTH_NAMES: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const MONTH_ALTERNATION = Object.keys(MONTH_NAMES).sort((a, b) => b.length - a.length).join('|');
// Thousands separators only where they belong, so the trailing comma in "$12,500, a 42% rise" is
// punctuation rather than part of the number.
const NUMBER = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;
const CURRENCY_CODES = 'USD|EUR|GBP|JPY|CAD|AUD|CHF|SEK|NOK|DKK|ISK|INR|CNY|NZD|BRL|MXN|ZAR|PLN|CZK|SGD|HKD|KRW';

/**
 * Ordered alternation: the first pattern that matches at a position wins, so `$12,500` is one
 * currency fact rather than the number `12,500` with a stray dollar sign, and `3 March 2024` is one
 * date rather than the numbers 3 and 2024.
 */
const FACT_PATTERNS: Array<{ kind: FactKind; source: string }> = [
  { kind: 'date', source: String.raw`\d{4}-\d{2}-\d{2}` },
  { kind: 'date', source: String.raw`\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}` },
  { kind: 'date', source: String.raw`\d{1,2}(?:st|nd|rd|th)?\s+(?:${MONTH_ALTERNATION})\.?,?\s+\d{4}` },
  { kind: 'date', source: String.raw`(?:${MONTH_ALTERNATION})\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}` },
  { kind: 'date', source: String.raw`(?:${MONTH_ALTERNATION})\.?\s+\d{4}` },
  { kind: 'currency', source: String.raw`[$£€¥₹]\s?${NUMBER}` },
  { kind: 'currency', source: String.raw`${NUMBER}\s?(?:${CURRENCY_CODES})\b` },
  { kind: 'percent', source: String.raw`${NUMBER}\s?%` },
  { kind: 'percent', source: String.raw`${NUMBER}\s?percent\b` },
  { kind: 'number', source: NUMBER },
];

const FACT_REGEX = new RegExp(FACT_PATTERNS.map((p) => `(${p.source})`).join('|'), 'gi');

/**
 * Markdown noise removed before scanning, so `**$12,500**` and `$12,500` produce the same fact and a
 * bolded price isn't reported as lost.
 */
export function normalizeForFacts(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/`/g, ' '))
    .replace(/[*_~`>#|]/g, ' ')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .replace(/\s+/g, ' ');
}

export function extractFacts(markdown: string): FactToken[] {
  const text = normalizeForFacts(markdown);
  const out: FactToken[] = [];
  FACT_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FACT_REGEX.exec(text)) !== null) {
    const groupIndex = match.slice(1).findIndex((group) => group !== undefined);
    if (groupIndex < 0) continue;
    const kind = FACT_PATTERNS[groupIndex]!.kind;
    const value = match[0].trim();
    out.push({ value, canonical: canonicalize(value, kind), kind });
  }
  return out;
}

export function canonicalize(value: string, kind: FactKind): string {
  const flat = value.toLowerCase().replace(/\s+/g, ' ').trim();
  if (kind === 'date') {
    const iso = canonicalDate(flat);
    if (iso) return iso;
  }
  return flat
    .replace(/percent/g, '%')
    .replace(/[,\s]/g, '')
    .replace(/\.$/, '');
}

/**
 * `3 March 2024`, `March 3, 2024` and `2024-03-03` are the same day, so they canonicalize the same
 * way. Purely numeric forms like `03/04/2024` stay raw: day-first and month-first are genuinely
 * ambiguous, and guessing wrong here would hide a real alteration.
 */
function canonicalDate(value: string): string | undefined {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dayFirst = new RegExp(String.raw`^(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALTERNATION})\.?,?\s+(\d{4})$`).exec(value);
  if (dayFirst) return formatIso(Number(dayFirst[3]), MONTH_NAMES[dayFirst[2]!]!, Number(dayFirst[1]));

  const monthFirst = new RegExp(String.raw`^(${MONTH_ALTERNATION})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$`).exec(value);
  if (monthFirst) return formatIso(Number(monthFirst[3]), MONTH_NAMES[monthFirst[1]!]!, Number(monthFirst[2]));

  const monthYear = new RegExp(String.raw`^(${MONTH_ALTERNATION})\.?\s+(\d{4})$`).exec(value);
  if (monthYear) return `${monthYear[2]}-${String(MONTH_NAMES[monthYear[1]!]!).padStart(2, '0')}`;

  return undefined;
}

function formatIso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function extractHeadings(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split('\n')) {
    const match = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (match) out.push(match[2]!.trim().replace(/[*_`]/g, '').toLowerCase());
  }
  return out;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Compare an AI-rewritten page against the algorithmic extraction of the same page.
 *
 * `source` is the algorithmic markdown (ground truth), `candidate` is what the model returned.
 */
export function verifyFidelity(source: string, candidate: string, options: FidelityOptions = {}): FidelityReport {
  const minWordRatio = options.minWordRatio ?? 0.6;
  const minFactOccurrenceRatio = options.minFactOccurrenceRatio ?? 0.8;
  const maxReported = options.maxReported ?? 5;

  const issues: FidelityIssue[] = [];
  const sourceFacts = extractFacts(source);
  const missing: FactToken[] = [];

  if (candidate.trim().length === 0) {
    issues.push({ code: 'empty-output', severity: 'error', message: 'The model returned an empty document.' });
    return finish(issues, sourceFacts, missing);
  }

  const candidateFacts = extractFacts(candidate);
  const candidateCounts = new Map<string, number>();
  for (const fact of candidateFacts) {
    candidateCounts.set(fact.canonical, (candidateCounts.get(fact.canonical) ?? 0) + 1);
  }

  const sourceCounts = new Map<string, FactToken>();
  const sourceTotals = new Map<string, number>();
  for (const fact of sourceFacts) {
    if (!sourceCounts.has(fact.canonical)) sourceCounts.set(fact.canonical, fact);
    sourceTotals.set(fact.canonical, (sourceTotals.get(fact.canonical) ?? 0) + 1);
  }

  for (const [canonical, fact] of sourceCounts) {
    if (!candidateCounts.has(canonical)) missing.push(fact);
  }

  if (missing.length > 0) {
    const named = missing.slice(0, maxReported).map((fact) => `"${fact.value}"`).join(', ');
    const rest = missing.length > maxReported ? ` and ${missing.length - maxReported} more` : '';
    issues.push({
      code: 'missing-fact',
      severity: 'error',
      message: `The model's version drops or changes ${missing.length} fact${missing.length === 1 ? '' : 's'} from the page: ${named}${rest}.`,
    });
  }

  const sourceOccurrences = sourceFacts.length;
  const keptOccurrences = [...sourceTotals].reduce(
    (total, [canonical, count]) => total + Math.min(count, candidateCounts.get(canonical) ?? 0),
    0,
  );
  if (sourceOccurrences > 0 && keptOccurrences / sourceOccurrences < minFactOccurrenceRatio) {
    const pct = Math.round((keptOccurrences / sourceOccurrences) * 100);
    issues.push({
      code: 'dropped-occurrences',
      severity: 'error',
      message: `Only ${pct}% of the page's ${sourceOccurrences} number, date and price mentions survived. A table or list was probably collapsed.`,
    });
  }

  const sourceWords = wordCount(source);
  const candidateWords = wordCount(candidate);
  if (sourceWords > 0 && candidateWords / sourceWords < minWordRatio) {
    issues.push({
      code: 'too-short',
      severity: 'error',
      message: `The model returned ${candidateWords} words against the page's ${sourceWords}. That is a summary, not a faithful reproduction.`,
    });
  }

  // Structure loss is worth saying out loud, but it is not a factual error, so it never triggers the
  // fallback on its own.
  const candidateHeadings = new Set(extractHeadings(candidate));
  const lostHeadings = extractHeadings(source).filter((heading) => !candidateHeadings.has(heading));
  if (lostHeadings.length > 0) {
    issues.push({
      code: 'missing-heading',
      severity: 'warning',
      message: `${lostHeadings.length} heading${lostHeadings.length === 1 ? '' : 's'} from the page did not come back: ${lostHeadings.slice(0, maxReported).map((h) => `"${h}"`).join(', ')}.`,
    });
  }

  return finish(issues, sourceFacts, missing);
}

function finish(issues: FidelityIssue[], sourceFacts: FactToken[], missing: FactToken[]): FidelityReport {
  const errors = issues.filter((i) => i.severity === 'error').map((i) => i.message);
  const warnings = issues.filter((i) => i.severity === 'warning').map((i) => i.message);
  return { ok: errors.length === 0, issues, errors, warnings, sourceFacts, missing };
}
