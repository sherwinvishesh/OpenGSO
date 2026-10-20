import { AI_PROVIDERS, DEFAULT_MODELS, isAiProvider, providerGaps } from '../shared/providers.js';
import { ERRORS } from '../shared/errors.js';
import { isCI } from '../shared/env.js';
import { callProvider, failsEveryCall, stripCodeFence } from '../shared/provider-call.js';

/**
 * @import { AiProvider, ProviderOverrides } from '../shared/providers.js'
 * @import { ProviderFn } from '../shared/provider-call.js'
 * @import { DiscoveredTwin } from './discover.js'
 */

/**
 * Defined in `api-types.js` with every other shape the dashboard reads, and re-exported here.
 *
 * @typedef {import('../shared/api-types.js').Priority} Priority
 * @typedef {import('../shared/api-types.js').QualityRecommendation} QualityRecommendation
 * @typedef {import('../shared/api-types.js').QualityFinding} QualityFinding
 * @typedef {import('../shared/api-types.js').QualityReview} QualityReview
 * @typedef {import('../shared/api-types.js').DocumentReview} DocumentReview
 * @typedef {import('../shared/api-types.js').AreaScore} AreaScore
 * @typedef {import('../shared/api-types.js').AggregatedRecommendation} AggregatedRecommendation
 * @typedef {import('../shared/api-types.js').ContentReview} ContentReview
 */

/**
 * The optional AI content review (§5), and its own 0-100 score.
 *
 * There are two numbers in OpenGSO and they are never added together. The structural score says
 * whether the Markdown is *served* correctly: reachable, right content type, right headers. This
 * one says whether the Markdown is *worth reading* once it arrives. A site can serve a perfect
 * twin of a page that says nothing, and score 100 on the first and 40 on the second, and both
 * numbers are true. Averaging them would produce a figure nobody could act on, so they stay apart:
 * separate key in the JSON, separate section in the report, and the exit code follows the
 * structural half alone.
 *
 * The content score is derived, not asked for. The model rates five named areas 0-100 against a
 * written rubric, and the score is the weighted mean of those. That is deliberate: a model asked
 * for one overall number gives a different one every run, whereas a weighted mean of five judged
 * areas can be explained line by line ("specificity is costing you 11 points") and is the thing
 * the recommendations then attach to.
 *
 * It is also the single exception to "test never needs a key" (§11), and it refuses to run in CI
 * for the same reason generate's AI tier does: one rule for everything AI-touching, not several.
 */

/**
 * The five areas, and what each is worth out of 100.
 *
 * The weights are an opinion about who this document is for. It is read by an agent that has to
 * answer somebody's question from it and cannot follow a link to find out more, so answerability
 * and concrete facts carry more than half the score between them. Keywords matter least: they are
 * the easiest thing to add and the least useful to a reader who is already looking at the page.
 *
 * Ordered heaviest first, which is also the order they are asked about in the prompt.
 */
export const QUALITY_AREAS = /** @type {const} */ ([
  {
    id: 'answerability',
    label: 'Answerability',
    weight: 30,
    asks: 'Could an agent answer a real question about this from the document alone, without visiting anything else?',
  },
  {
    id: 'specificity',
    label: 'Specificity',
    weight: 25,
    asks: 'Concrete facts, numbers, prices, dates, names and versions, rather than adjectives and claims?',
  },
  {
    id: 'definition',
    label: 'Definition',
    weight: 20,
    asks: 'Is it obvious in the first few lines what this is, who it is for, and what it does?',
  },
  {
    id: 'structure',
    label: 'Structure',
    weight: 15,
    asks: 'Headings that describe their content, a sensible order, and a length that suits what there is to say?',
  },
  {
    id: 'keywords',
    label: 'Keywords',
    weight: 10,
    asks: 'Are the words someone would actually search for present, and used naturally rather than stuffed?',
  },
]);

/** @typedef {(typeof QUALITY_AREAS)[number]['id']} QualityAreaId */

/** Total of the area weights. 100 by construction; asserted by the tests rather than assumed. */
export const QUALITY_TOTAL_WEIGHT = QUALITY_AREAS.reduce((total, area) => total + area.weight, 0);

/**
 * The rubric.
 *
 * Written into the prompt because an unanchored 0-100 from a language model drifts: the same
 * document scores 60 one day and 85 the next. Bands described in terms of what the reader can
 * actually do with the document are the closest thing to a fixed reference point available here,
 * and the report repeats them so a number on screen can be interpreted without the prompt.
 */
export const QUALITY_BANDS = /** @type {const} */ ([
  { from: 90, label: 'Anything a reader could reasonably ask is answered here, with specifics.' },
  { from: 75, label: 'Solid. A reader gets what they came for, with gaps at the edges.' },
  { from: 60, label: 'Usable, but vague in places a reader would notice.' },
  { from: 40, label: 'Thin. A reader would have to go back to the site for the real answer.' },
  { from: 20, label: 'Mostly claims and navigation. Very little a reader could use.' },
  { from: 0, label: 'An agent would learn almost nothing from this document.' },
]);

/**
 * @param {number} score
 * @returns {string}
 */
export function qualityBand(score) {
  return (QUALITY_BANDS.find((band) => score >= band.from) ?? /** @type {NonNullable<(typeof QUALITY_BANDS)[number]>} */ (QUALITY_BANDS[QUALITY_BANDS.length - 1])).label;
}

/** @type {readonly Priority[]} */
const PRIORITIES = ['high', 'medium', 'low'];

/**
 * @typedef {object} QualityOptions
 * @property {AiProvider} provider
 * @property {string} apiKey
 * @property {string} [model]
 * @property {ProviderFn} [call] Injectable so tests never touch the network.
 * @property {number} [timeoutMs]
 * @property {ProviderOverrides} [overrides] Endpoint overrides, for a gateway or a provider OpenGSO does not ship with.
 * @property {Record<string, string | undefined>} [env] Overridable only so the CI guard itself is testable.
 */

/**
 * @typedef {object} QualityInput
 * @property {string} url
 * @property {string} markdown The markdown a real agent receives at the twin URL.
 */

export const QUALITY_SYSTEM_PROMPT = [
  'You review a Markdown document that a website serves to AI agents in place of its HTML page.',
  '',
  'The reader you are judging for is an agent answering somebody\'s question. It cannot click a',
  'link, cannot see the rest of the site, and will not come back. Everything it can say about this',
  'page has to be in this document. Judge how well the document serves that reader, on these five',
  'areas and nothing else:',
  ...QUALITY_AREAS.map((area) => `- ${area.label} (worth ${area.weight} of 100): ${area.asks}`),
  '',
  'Score each area 0-100 against this scale, and use the whole range. Most real pages land between',
  '40 and 80, and a 100 means you cannot name anything further to add.',
  ...QUALITY_BANDS.map((band) => `- ${band.from}+: ${band.label}`),
  '',
  'Then give specific edits, hardest-hitting first. Each one names the area it lifts, what to change',
  'in the imperative, where in the document to change it, and what a reader gains. Quote the',
  'document when you can.',
  '  Useful: "Add the price and billing period next to each plan name under ## Pricing, so an agent',
  '  asked what the team plan costs can answer instead of guessing."',
  '  Useless: "improve clarity", "add more detail", "consider SEO best practices".',
  'Recommend nothing that is already there. If an area scores 90 or above, say so and move on.',
  '',
  'You are reviewing content quality only. Do not comment on HTTP headers, file locations, robots',
  'rules or anything else about how the document is served; a separate deterministic audit covers',
  'all of that, and duplicating it here would be noise.',
  '',
  'Reply with JSON only, no code fence, in exactly this shape:',
  '{"summary": "one sentence on what this document is and how well it reads",',
  ' "findings": [{"area": "Answerability", "score": 0-100, "note": "one or two sentences"}],',
  ' "recommendations": [{"area": "Specificity", "priority": "high|medium|low",',
  '   "action": "what to change, imperative", "where": "heading or quoted phrase",',
  '   "impact": "what the reader gains"}]}',
  'Include one finding per area, all five, in the order given above.',
].join('\n');

/**
 * @param {QualityInput} input
 * @returns {string}
 */
export function buildQualityPrompt(input) {
  return [
    `Document URL: ${input.url}`,
    '',
    '--- BEGIN DOCUMENT ---',
    input.markdown,
    '--- END DOCUMENT ---',
  ].join('\n');
}

/**
 * The catalogue weight for a label the model used, matched on the label or the id, or undefined.
 *
 * @param {string} area
 * @returns {number | undefined}
 */
export function areaWeight(area) {
  const key = area.trim().toLowerCase();
  return QUALITY_AREAS.find((entry) => entry.id === key || entry.label.toLowerCase() === key)?.weight;
}

/**
 * Findings to a 0-100 document score.
 *
 * Only the areas the model actually scored count, and the weights are renormalised over those. It
 * is the same rule the structural score uses for `n/a` checks: an unanswered question leaves the
 * denominator rather than scoring zero, because a model that returned four findings instead of five
 * has told you nothing about the fifth. An area OpenGSO does not know about is ignored in the
 * arithmetic and still printed, on the same principle.
 *
 * @param {readonly QualityFinding[]} findings
 * @returns {number | undefined}
 */
export function scoreFindings(findings) {
  let earned = 0;
  let weight = 0;
  for (const finding of findings) {
    const areaWeightValue = areaWeight(finding.area);
    if (areaWeightValue === undefined || typeof finding.score !== 'number') continue;
    earned += finding.score * areaWeightValue;
    weight += areaWeightValue;
  }
  if (weight === 0) return undefined;
  return Math.round(earned / weight);
}

/**
 * Run the review. Throws only for the two refusals the user needs to see and act on - CI, and an
 * unknown provider. A provider that errors mid-call is reported as a failed review rather than
 * thrown, because the structural report is already on screen and must not be lost.
 *
 * @param {QualityInput} input
 * @param {QualityOptions} options
 * @returns {Promise<QualityReview>}
 */
export async function reviewQuality(input, options) {
  if (!isAiProvider(options.provider)) {
    throw new Error(ERRORS.unknownProvider(options.provider, AI_PROVIDERS));
  }
  if (isCI(options.env ?? process.env)) {
    throw new Error(ERRORS.ciBlocked('test --content'));
  }

  const call = options.call ?? callProvider;
  const model = options.model || DEFAULT_MODELS[options.provider];
  const gaps = providerGaps(options.provider, model, options.overrides);
  if (gaps.length > 0) throw new Error(ERRORS.providerIncomplete(options.provider, gaps));

  const text = await call({
    provider: options.provider,
    model,
    apiKey: options.apiKey,
    system: QUALITY_SYSTEM_PROMPT,
    prompt: buildQualityPrompt(input),
    maxTokens: 2048,
    timeoutMs: options.timeoutMs,
    overrides: options.overrides,
  });

  return parseQuality(text, options.provider, model);
}

/**
 * @typedef {QualityOptions & {
 *   maxDocuments?: number; // Hard cap on how many documents are sent to the provider. Every one of them costs money.
 *   concurrency?: number; // How many reviews are in flight at once.
 *   onProgress?: (done: number, total: number, url: string) => void; // Called as each document finishes, so a long run can narrate itself.
 *   signal?: AbortSignal; // Checked before each batch, so an abandoned run stops making paid calls.
 * }} ContentReviewOptions
 */

const DEFAULT_MAX_DOCUMENTS = 10;
const DEFAULT_CONCURRENCY = 3;

/**
 * @param {readonly DiscoveredTwin[]} twins
 * @param {ContentReviewOptions} options
 * @returns {Promise<ContentReview>}
 */
export async function reviewContent(twins, options) {
  if (!isAiProvider(options.provider)) {
    throw new Error(ERRORS.unknownProvider(options.provider, AI_PROVIDERS));
  }
  if (isCI(options.env ?? process.env)) {
    throw new Error(ERRORS.ciBlocked('test --content'));
  }

  const model = options.model || DEFAULT_MODELS[options.provider];
  const gaps = providerGaps(options.provider, model, options.overrides);
  if (gaps.length > 0) throw new Error(ERRORS.providerIncomplete(options.provider, gaps));

  const max = options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS;
  const reviewing = twins.slice(0, max);
  /** @type {DocumentReview[]} */
  const documents = reviewing.map((twin) => ({
    url: twin.url,
    pageUrl: twin.pageUrl,
    source: twin.source,
    words: twin.words,
  }));

  let done = 0;
  /** @type {number | undefined} */
  let refused;
  let sent = 0;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  for (let i = 0; i < reviewing.length && refused === undefined; i += concurrency) {
    options.signal?.throwIfAborted();
    const batch = reviewing.slice(i, i + concurrency);
    sent += batch.length;
    await Promise.all(
      batch.map(async (twin, offset) => {
        const entry = /** @type {DocumentReview} */ (documents[i + offset]);
        try {
          entry.review = await reviewQuality({ url: twin.url, markdown: twin.markdown }, { ...options, model });
        } catch (error) {
          entry.error = error instanceof Error ? error.message : String(error);
          const status = /** @type {{ status?: unknown }} */ (error)?.status;
          if (failsEveryCall(status)) refused = status;
        }
        done += 1;
        options.onProgress?.(done, reviewing.length, twin.url);
      }),
    );
  }
  for (const entry of documents.slice(sent)) entry.error = ERRORS.contentDocumentNotSent;

  return {
    provider: options.provider,
    model,
    halted: refused === undefined ? undefined : ERRORS.contentReviewHalted(refused, reviewing.length - sent),
    documents,
    score: mean(documents.map((doc) => doc.review?.score).filter(/** @returns {value is number} */ (value) => typeof value === 'number')),
    areaScores: aggregateAreas(documents),
    recommendations: aggregateRecommendations(documents),
    notReviewed: twins.length - reviewing.length,
  };
}

/**
 * @param {readonly number[]} values
 * @returns {number | undefined}
 */
function mean(values) {
  if (values.length === 0) return undefined;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

/**
 * Average each area across documents, keyed on the label the model used rather than on the
 * catalogue. A model that answers with an area nobody asked for still gets reported, because
 * silently dropping part of a paid-for answer is worse than showing an unexpected row.
 *
 * Ordered by what each area is costing rather than by its raw score, so the row at the top is the
 * one worth working on: a weak area worth 10 points is a smaller problem than a middling one
 * worth 30, and sorting on the score alone would put them the wrong way round.
 *
 * @param {readonly DocumentReview[]} documents
 * @returns {AreaScore[]}
 */
function aggregateAreas(documents) {
  /** @type {Map<string, { total: number; count: number; label: string }>} */
  const buckets = new Map();
  for (const document of documents) {
    for (const finding of document.review?.findings ?? []) {
      if (typeof finding.score !== 'number') continue;
      const key = finding.area.trim().toLowerCase();
      const bucket = buckets.get(key) ?? { total: 0, count: 0, label: finding.area.trim() };
      bucket.total += finding.score;
      bucket.count += 1;
      buckets.set(key, bucket);
    }
  }
  return [...buckets.values()]
    .map((bucket) => {
      const score = Math.round(bucket.total / bucket.count);
      const weight = areaWeight(bucket.label);
      return { area: bucket.label, score, weight, lost: Math.round(((weight ?? 0) * (100 - score)) / 100), documents: bucket.count };
    })
    .sort((a, b) => b.lost - a.lost || a.score - b.score);
}

/**
 * One list of edits for the whole site, rather than the same advice repeated under eight documents.
 *
 * Two documents that both need prices added are one job, and a reader working through the list
 * needs to see it once with both URLs attached. Collapsing on the normalised action is crude but
 * it only ever merges wording a model repeated verbatim, which is exactly the case that matters.
 *
 * @param {readonly DocumentReview[]} documents
 * @returns {AggregatedRecommendation[]}
 */
function aggregateRecommendations(documents) {
  /** @type {Map<string, AggregatedRecommendation>} */
  const merged = new Map();
  for (const document of documents) {
    for (const recommendation of document.review?.recommendations ?? []) {
      const key = recommendation.action.trim().toLowerCase().replace(/[^a-z0-9 ]+/g, '');
      const existing = merged.get(key);
      if (existing) {
        if (!existing.documents.includes(document.url)) existing.documents.push(document.url);
        // Keep the most urgent verdict any document gave the same edit.
        if (PRIORITIES.indexOf(recommendation.priority) < PRIORITIES.indexOf(existing.priority)) {
          existing.priority = recommendation.priority;
        }
        continue;
      }
      merged.set(key, { ...recommendation, documents: [document.url] });
    }
  }
  return [...merged.values()].sort(
    (a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || b.documents.length - a.documents.length,
  );
}

/**
 * Parse the model's answer, tolerating the usual deviations: a code fence, or prose wrapped around
 * the JSON. A reply that cannot be parsed at all is surfaced verbatim rather than discarded - the
 * user paid for that call, and the text may still be useful.
 *
 * It also accepts the plainer shape a model reaches for when it ignores half the instructions: a
 * `suggestions` array of bare strings instead of `recommendations`, and a 1-5 `rating` instead of
 * per-area scores. Both are upgraded rather than dropped, because a review that renders with less
 * detail is worth more than an error that renders with none.
 *
 * @param {string} text
 * @param {AiProvider} provider
 * @param {string} model
 * @returns {QualityReview}
 */
export function parseQuality(text, provider, model) {
  const cleaned = stripCodeFence(text).trim();
  const json = extractJsonObject(cleaned);

  if (json) {
    try {
      const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(json));
      const findings = toFindings(parsed.findings);
      return {
        score: scoreFindings(findings) ?? overallScore(parsed),
        summary: typeof parsed.summary === 'string' ? parsed.summary : 'The model returned no summary.',
        findings,
        recommendations: toRecommendations(parsed.recommendations ?? parsed.suggestions),
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
    recommendations: [],
    provider,
    model,
    raw: cleaned,
  };
}

/**
 * @param {string} text
 * @returns {string | undefined}
 */
function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

/**
 * The fallback for a reply with no per-area scores: whatever overall number it did give.
 *
 * `rating` is read on the 1-5 scale the older prompt asked for, because a model answering with one
 * is answering the old question and 4 means 80, not 4.
 *
 * @param {Record<string, unknown>} parsed
 * @returns {number | undefined}
 */
function overallScore(parsed) {
  if (typeof parsed.score === 'number') return clamp(parsed.score);
  if (typeof parsed.rating === 'number') return clamp(Math.round((Math.min(5, Math.max(1, parsed.rating)) / 5) * 100));
  return undefined;
}

/**
 * @param {number} value
 * @returns {number}
 */
function clamp(value) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * @param {unknown} value
 * @returns {QualityFinding[]}
 */
function toFindings(value) {
  if (!Array.isArray(value)) return [];
  /** @type {QualityFinding[]} */
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (item);
    const area = typeof record.area === 'string' ? record.area : undefined;
    const note = typeof record.note === 'string' ? record.note : undefined;
    // `rating` on a 1-5 scale is the old shape, and 5 there means 100 here.
    const score =
      typeof record.score === 'number'
        ? clamp(record.score)
        : typeof record.rating === 'number'
          ? clamp((Math.min(5, Math.max(1, record.rating)) / 5) * 100)
          : undefined;
    if (area && note) out.push({ area, note, score });
  }
  return out;
}

/**
 * Recommendations, from either the structured shape or a bare list of strings.
 *
 * A string carries no area and no priority, so it is filed under the area OpenGSO cannot name and
 * at medium. Inventing a priority for it would put a guess in the same column as the model's own
 * judgement, which is worse than admitting the reply was thinner than asked for.
 *
 * @param {unknown} value
 * @returns {QualityRecommendation[]}
 */
function toRecommendations(value) {
  if (!Array.isArray(value)) return [];
  /** @type {QualityRecommendation[]} */
  const out = [];
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.trim().length > 0) out.push({ area: 'General', action: item.trim(), priority: 'medium' });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (item);
    const action = typeof record.action === 'string' ? record.action.trim() : '';
    if (!action) continue;
    out.push({
      area: typeof record.area === 'string' && record.area.trim() ? record.area.trim() : 'General',
      action,
      impact: typeof record.impact === 'string' && record.impact.trim() ? record.impact.trim() : undefined,
      priority: toPriority(record.priority),
      where: typeof record.where === 'string' && record.where.trim() ? record.where.trim() : undefined,
    });
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {Priority}
 */
function toPriority(value) {
  const found = typeof value === 'string' ? PRIORITIES.find((priority) => priority === value.trim().toLowerCase()) : undefined;
  return found ?? 'medium';
}
