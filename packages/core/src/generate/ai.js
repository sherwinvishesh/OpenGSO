import { AI_PROVIDERS, DEFAULT_MODELS, isAiProvider, providerGaps } from '../shared/providers.js';
import { ERRORS } from '../shared/errors.js';
import { isCI } from '../shared/env.js';
import { DEFAULT_MAX_TOKENS, TruncatedOutputError, callProvider, failsEveryCall, stripCodeFence } from '../shared/provider-call.js';
import { estimateTokens } from '../shared/tokens.js';
import { verifyFidelity } from './fidelity.js';

/**
 * @import { AiProvider, ProviderOverrides } from '../shared/providers.js'
 * @import { EnhanceInput, EnhanceOutput } from './generate.js'
 */

// The provider call itself lives in shared/provider-call.js. It is re-exported so the generate
// entry point still offers everything a caller of the AI tier needs.
export { DEFAULT_MAX_TOKENS, TruncatedOutputError, callProvider, stripCodeFence };

/**
 * @typedef {import('../shared/provider-call.js').ProviderCall} ProviderCall
 * @typedef {import('../shared/provider-call.js').ProviderFn} ProviderFn
 */

/**
 * The bring-your-own-key AI tier (§6).
 *
 * Three things this module is careful about:
 *
 * 1. The prompt asks for transcription, not writing. Every instruction pushes the model toward
 *    reproducing what is on the page rather than improving it, because a subtly reworded price is
 *    worse than a rough-but-correct algorithmic extraction.
 * 2. The numbers are not taken on the model's word. Whatever comes back goes through the fidelity
 *    guard in fidelity.js, which checks numbers, dates, prices and percentages in both directions
 *    and the overall length, and a failed check keeps the algorithmic markdown, with a warning.
 *    Words are not checked: see fidelity.js for what gets past it.
 * 3. The key is used for exactly one thing: an HTTPS call to the provider the user picked. It is
 *    never logged, never attached to any other request, and there is no telemetry anywhere in this
 *    package to attach it to (§11).
 */

/**
 * @typedef {object} AiEnhancerOptions
 * @property {AiProvider} provider
 * @property {string} [model]
 * @property {string} apiKey
 * @property {ProviderFn} [call] Defaults to the real HTTP providers.
 * @property {number} [maxTokens]
 * @property {number} [timeoutMs]
 * @property {ProviderOverrides} [overrides] Endpoint overrides for a gateway or a provider OpenGEO
 *   does not ship with.
 * @property {Record<string, string | undefined>} [env] Overridable only so the CI guard itself is
 *   testable.
 */

export const SYSTEM_PROMPT = [
  'You convert an already-rendered web page into clean Markdown for AI agents to read.',
  '',
  'You are a transcriber, not a writer or an editor. Your only job is to reproduce what is on the',
  'page in Markdown, with its structure intact.',
  '',
  'Absolute rules:',
  '- Never summarize, condense, or shorten. Every section on the page appears in your output.',
  '- Never paraphrase. Keep the page\'s own wording, sentence for sentence.',
  '- Never alter a fact. Names, dates, prices, numbers, percentages, units, job titles, company',
  '  names and version numbers must appear exactly as written, character for character.',
  '- Never invent. If something is not on the page, it does not go in the output.',
  '- Never add commentary, preamble, notes about what you did, or a closing remark.',
  '- Never add a frontmatter block. Start at the first heading or paragraph of the content.',
  '',
  'Formatting:',
  '- One H1 for the page title, then the page\'s own heading hierarchy below it.',
  '- Real Markdown tables for tabular data, keeping every row and every cell value.',
  '- Real Markdown lists for lists, preserving order and nesting.',
  '- Keep links as [text](absolute-url).',
  '- Drop navigation, headers, footers, cookie banners, and anything else that is site furniture',
  '  rather than page content.',
  '',
  'Output only the Markdown document. No code fence around the whole thing.',
].join('\n');

/**
 * @param {EnhanceInput} input
 * @returns {string}
 */
export function buildFidelityPrompt(input) {
  return [
    `Page title: ${input.title}`,
    `Page URL: ${input.url}`,
    '',
    'Below is an automatic, structure-only extraction of this page. It is accurate about the facts',
    'but crude about formatting: it may have flattened tables, lost nesting, or run text together.',
    '',
    'Rewrite it as clean Markdown. Fix the formatting. Change nothing else. Every number, date,',
    'price, name and percentage below must appear in your output exactly as it appears here.',
    '',
    '--- BEGIN EXTRACTION ---',
    input.algorithmicMarkdown,
    '--- END EXTRACTION ---',
  ].join('\n');
}

/**
 * Build the `enhance` hook `generatePages` calls per page.
 *
 * Any failure - a provider error, a timeout, a fidelity violation - resolves to the algorithmic
 * markdown with a warning. Generate never dies because an AI call went wrong.
 *
 * @param {AiEnhancerOptions} options
 * @returns {(input: EnhanceInput) => Promise<EnhanceOutput>}
 */
export function createAiEnhancer(options) {
  if (!isAiProvider(options.provider)) {
    throw new Error(ERRORS.unknownProvider(options.provider, AI_PROVIDERS));
  }
  if (isCI(options.env ?? process.env)) {
    throw new Error(ERRORS.ciBlocked("generate's AI tier"));
  }

  const call = options.call ?? callProvider;
  const model = options.model || DEFAULT_MODELS[options.provider];
  // A provider with no endpoint or no model would fail at the HTTP layer with a URL nobody can
  // read. Naming the missing config field here is the difference between a fixable error and a
  // support thread.
  const gaps = providerGaps(options.provider, model, options.overrides);
  if (gaps.length > 0) throw new Error(ERRORS.providerIncomplete(options.provider, gaps));

  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  // A refused key, an empty account or a model that does not exist fails every page the same way.
  // Sending the rest anyway prints the same failure once per page and, on a provider that bills
  // rejected calls, costs money for nothing.
  /** @type {number | undefined} */
  let refused;

  return async (input) => {
    if (refused !== undefined) {
      return { markdown: input.algorithmicMarkdown, warnings: [ERRORS.aiStoppedEarlier(refused)], fellBack: true, fallback: 'unavailable' };
    }
    // A transcription is about as long as its source. One that cannot fit would be cut off on every
    // run, and billed every time, so it is never sent.
    const tokens = estimateTokens(input.algorithmicMarkdown);
    if (tokens > maxTokens) {
      return { markdown: input.algorithmicMarkdown, warnings: [ERRORS.aiPageTooLong(tokens, maxTokens)], fellBack: true, fallback: 'too-long' };
    }

    /** @type {string} */
    let text;
    try {
      text = await call({
        provider: options.provider,
        model,
        apiKey: options.apiKey,
        system: SYSTEM_PROMPT,
        prompt: buildFidelityPrompt(input),
        maxTokens,
        timeoutMs: options.timeoutMs,
        overrides: options.overrides,
      });
    } catch (error) {
      const status = /** @type {{ status?: unknown }} */ (error)?.status;
      if (failsEveryCall(status)) refused = status;
      return {
        markdown: input.algorithmicMarkdown,
        warnings: [`AI tier unavailable for this page, kept the algorithmic version. ${errorText(error)}`],
        fellBack: true,
        fallback: error instanceof TruncatedOutputError ? 'truncated' : 'unavailable',
      };
    }

    const markdown = stripCodeFence(text).trim();
    const report = verifyFidelity(input.algorithmicMarkdown, markdown);
    if (!report.ok) {
      return {
        markdown: input.algorithmicMarkdown,
        warnings: [
          'Kept the algorithmic version: the AI rewrite failed the fidelity check.',
          ...report.errors,
        ],
        fellBack: true,
        fallback: 'fidelity',
      };
    }

    return { markdown, warnings: report.warnings, fellBack: false };
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
