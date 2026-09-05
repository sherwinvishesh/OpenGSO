import type { AiProvider } from '../shared/config.js';
import { AI_PROVIDERS, DEFAULT_MODELS } from '../shared/config.js';
import { ERRORS } from '../shared/errors.js';
import { isCI } from '../shared/env.js';
import type { ProviderFn } from '../generate/ai.js';
import { callProvider, stripCodeFence } from '../generate/ai.js';

/**
 * The optional AI markdown-quality pass (idea.md §5).
 *
 * Deliberately a separate module with a separate return type, because the one rule §5 is emphatic
 * about is that this never touches the 0-100 number. The structural checks are deterministic: a
 * header is present or it is not. This is a language model's opinion. Averaging the two would
 * produce a number nobody could interpret, so they never meet - not in the score, not in the JSON
 * output, and not in the same section of the report.
 *
 * It is also the single exception to "test never needs a key" (§11), and it refuses to run in CI
 * for the same reason generate's AI tier does: one rule for everything AI-touching, not several.
 */

export interface QualityFinding {
  /** Short label, e.g. "Length" or "Keyword coverage". */
  area: string;
  /** The model's read on this area, in one or two sentences. */
  note: string;
}

export interface QualityReview {
  /** The model's own 1-5 read, kept well away from the 0-100 structural score. */
  rating?: number;
  summary: string;
  findings: QualityFinding[];
  suggestions: string[];
  provider: AiProvider;
  model: string;
  /** Set when the model answered but not in the shape asked for. The raw text is still shown. */
  raw?: string;
}

export interface QualityOptions {
  provider: AiProvider;
  apiKey: string;
  model?: string;
  /** Injectable so tests never touch the network. */
  call?: ProviderFn;
  timeoutMs?: number;
  /** Overridable only so the CI guard itself is testable. */
  env?: Record<string, string | undefined>;
}

export interface QualityInput {
  url: string;
  /** The markdown a real agent receives at the twin URL. */
  markdown: string;
}

export const QUALITY_SYSTEM_PROMPT = [
  'You review a Markdown document that a website serves to AI agents in place of its HTML page.',
  '',
  'Judge it on three things and nothing else:',
  '- Keyword coverage and relevance: would an agent answering a question about this topic find the',
  '  terms it needs, or has the page buried them?',
  '- Length: too long for what it says, too short to be useful, or about right.',
  '- Specific improvements: concrete, actionable edits to this document.',
  '',
  'You are reviewing content quality only. Do not comment on HTTP headers, file locations, robots',
  'rules or anything else about how the document is served; a separate deterministic audit covers',
  'all of that, and duplicating it here would be noise.',
  '',
  'Reply with JSON only, no code fence, in exactly this shape:',
  '{"rating": 1-5, "summary": "one sentence", "findings": [{"area": "...", "note": "..."}],',
  ' "suggestions": ["...", "..."]}',
].join('\n');

export function buildQualityPrompt(input: QualityInput): string {
  return [
    `Document URL: ${input.url}`,
    '',
    '--- BEGIN DOCUMENT ---',
    input.markdown,
    '--- END DOCUMENT ---',
  ].join('\n');
}

/**
 * Run the review. Throws only for the two refusals the user needs to see and act on - CI, and an
 * unknown provider. A provider that errors mid-call is reported as a failed review rather than
 * thrown, because the structural report is already on screen and must not be lost.
 */
export async function reviewQuality(input: QualityInput, options: QualityOptions): Promise<QualityReview> {
  if (!AI_PROVIDERS.includes(options.provider)) {
    throw new Error(ERRORS.unknownProvider(options.provider, AI_PROVIDERS));
  }
  if (isCI(options.env ?? process.env)) {
    throw new Error(ERRORS.ciBlocked('test --quality'));
  }

  const call = options.call ?? callProvider;
  const model = options.model || DEFAULT_MODELS[options.provider];

  const text = await call({
    provider: options.provider,
    model,
    apiKey: options.apiKey,
    system: QUALITY_SYSTEM_PROMPT,
    prompt: buildQualityPrompt(input),
    maxTokens: 2048,
    timeoutMs: options.timeoutMs,
  });

  return parseQuality(text, options.provider, model);
}

/**
 * Parse the model's answer, tolerating the usual deviations: a code fence, or prose wrapped around
 * the JSON. A reply that cannot be parsed at all is surfaced verbatim rather than discarded - the
 * user paid for that call, and the text may still be useful.
 */
export function parseQuality(text: string, provider: AiProvider, model: string): QualityReview {
  const cleaned = stripCodeFence(text).trim();
  const json = extractJsonObject(cleaned);

  if (json) {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      return {
        rating: typeof parsed.rating === 'number' ? clampRating(parsed.rating) : undefined,
        summary: typeof parsed.summary === 'string' ? parsed.summary : 'The model returned no summary.',
        findings: toFindings(parsed.findings),
        suggestions: toStrings(parsed.suggestions),
        provider,
        model,
      };
    } catch {
      // Fall through to the raw form below.
    }
  }

  return {
    summary: 'The model did not reply in the requested format. Its answer is below, unedited.',
    findings: [],
    suggestions: [],
    provider,
    model,
    raw: cleaned,
  };
}

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

function clampRating(value: number): number {
  return Math.min(5, Math.max(1, Math.round(value)));
}

function toFindings(value: unknown): QualityFinding[] {
  if (!Array.isArray(value)) return [];
  const out: QualityFinding[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const area = typeof record.area === 'string' ? record.area : undefined;
    const note = typeof record.note === 'string' ? record.note : undefined;
    if (area && note) out.push({ area, note });
  }
  return out;
}

function toStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}
