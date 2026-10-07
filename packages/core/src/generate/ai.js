import { AI_PROVIDERS, DEFAULT_MODELS, isAiProvider, providerGaps, resolveProvider } from '../shared/providers.js';
import { ERRORS } from '../shared/errors.js';
import { isCI } from '../shared/env.js';
import { verifyFidelity } from './fidelity.js';

/**
 * @import { AiProvider, ProviderOverrides, ResolvedProvider } from '../shared/providers.js'
 * @import { EnhanceInput, EnhanceOutput } from './generate.js'
 */

/**
 * The bring-your-own-key AI tier (§6).
 *
 * Three things this module is careful about:
 *
 * 1. The prompt asks for transcription, not writing. Every instruction pushes the model toward
 *    reproducing what is on the page rather than improving it, because a subtly reworded price is
 *    worse than a rough-but-correct algorithmic extraction.
 * 2. Nothing is trusted on the model's word. Whatever comes back goes through the fidelity guard in
 *    fidelity.js, and a failed check silently keeps the algorithmic markdown instead.
 * 3. The key is used for exactly one thing: an HTTPS call to the provider the user picked. It is
 *    never logged, never attached to any other request, and there is no telemetry anywhere in this
 *    package to attach it to (§11).
 */

/**
 * @typedef {object} ProviderCall
 * @property {AiProvider} provider
 * @property {string} model
 * @property {string} apiKey
 * @property {string} system
 * @property {string} prompt
 * @property {number} [maxTokens]
 * @property {number} [timeoutMs]
 * @property {ProviderOverrides} [overrides] Endpoint overrides from the project's `ai` block. Absent
 *   means "use the catalogue row", which is what every built-in provider does until somebody points
 *   it at a gateway.
 */

/**
 * Injectable so tests, and the mock-provider fixtures, never touch the network.
 *
 * @typedef {(call: ProviderCall) => Promise<string>} ProviderFn
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

  return async (input) => {
    /** @type {string} */
    let text;
    try {
      text = await call({
        provider: options.provider,
        model,
        apiKey: options.apiKey,
        system: SYSTEM_PROMPT,
        prompt: buildFidelityPrompt(input),
        maxTokens: options.maxTokens,
        timeoutMs: options.timeoutMs,
        overrides: options.overrides,
      });
    } catch (error) {
      return {
        markdown: input.algorithmicMarkdown,
        warnings: [`AI tier unavailable for this page, kept the algorithmic version. ${errorText(error)}`],
        fellBack: true,
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
      };
    }

    return { markdown, warnings: report.warnings, fellBack: false };
  };
}

/**
 * Models often wrap a whole document in ```markdown despite being told not to. Unwrapping that is
 * not a fidelity concern, so it happens before the check rather than being counted against it.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripCodeFence(text) {
  const trimmed = text.trim();
  const match = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match ? match[1] : trimmed;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The only network call in OpenGEO that carries the user's API key.
 *
 * Dispatch is on the *wire format*, not on the vendor. Most of the industry ships an
 * OpenAI-compatible endpoint, so one caller plus a base URL covers Grok, Groq, Mistral, DeepSeek,
 * OpenRouter, Together, Perplexity, a local Ollama, and whatever gateway a company put in front of
 * them. Adding a vendor that follows the pattern is a row in the catalogue, not a branch here.
 *
 * @param {ProviderCall} call
 * @returns {Promise<string>}
 */
export async function callProvider(call) {
  if (!isAiProvider(call.provider)) {
    throw new Error(ERRORS.unknownProvider(call.provider, AI_PROVIDERS));
  }
  const provider = resolveProvider(call.provider, call.overrides);
  if (!provider.baseUrl) {
    throw new Error(ERRORS.providerIncomplete(call.provider, ['ai.baseUrl']));
  }
  switch (provider.api) {
    case 'anthropic':
      return callAnthropic(call, provider);
    case 'gemini':
      return callGemini(call, provider);
    case 'openai':
      return callOpenAI(call, provider);
    default:
      throw new Error(`Unknown API shape "${provider.api}". OpenGEO speaks: anthropic, openai, gemini.`);
  }
}

/**
 * Attach the key the way this endpoint expects it.
 *
 * `none` is a real answer, not a missing case: a model server on the user's own machine has no key
 * to send, and inventing a placeholder would only make the failure harder to read.
 *
 * @param {ResolvedProvider} provider
 * @param {string} apiKey
 * @returns {Record<string, string>}
 */
function authHeaders(provider, apiKey) {
  const extra = provider.headers;
  if (provider.auth === 'none' || !apiKey) return { ...extra };
  switch (provider.auth) {
    case 'x-api-key':
      return { 'x-api-key': apiKey, ...extra };
    case 'x-goog-api-key':
      return { 'x-goog-api-key': apiKey, ...extra };
    default:
      return { authorization: `Bearer ${apiKey}`, ...extra };
  }
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<unknown>}
 */
async function post(url, init, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Never followed. A redirect replays the request, key headers included, to a host nobody chose,
    // and fetch only strips `Authorization` on the way, not `x-api-key` or `x-goog-api-key`.
    const response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new Error(ERRORS.providerRedirected(label, response.status, response.headers.get('location')));
    }
    const body = await response.text();
    if (!response.ok) {
      throw new Error(ERRORS.providerFailed(label, response.status, body));
    }
    return /** @type {unknown} */ (JSON.parse(body));
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`The ${label} API did not respond within ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {ProviderCall} call
 * @param {ResolvedProvider} provider
 * @returns {Promise<string>}
 */
async function callAnthropic(call, provider) {
  const json = /** @type {{ content?: Array<{ type?: string; text?: string }> }} */ (await post(
    `${provider.baseUrl}/messages`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...authHeaders(provider, call.apiKey),
      },
      body: JSON.stringify({
        model: call.model,
        max_tokens: call.maxTokens ?? 8192,
        system: call.system,
        messages: [{ role: 'user', content: call.prompt }],
      }),
    },
    call.timeoutMs ?? 120_000,
    provider.label,
  ));

  const text = (json.content ?? [])
    .filter((block) => block.type === 'text' || typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('');
  if (!text) throw new Error(`${provider.label} returned no text content.`);
  return text;
}

/**
 * @param {ProviderCall} call
 * @param {ResolvedProvider} provider
 * @returns {Promise<string>}
 */
async function callOpenAI(call, provider) {
  // OpenAI's own newer models reject `max_tokens`; almost every compatible clone rejects
  // `max_completion_tokens`. The catalogue row says which one this endpoint accepts.
  const tokens = { [provider.tokenParam]: call.maxTokens ?? 8192 };
  const json = /** @type {{ choices?: Array<{ message?: { content?: string } }> }} */ (await post(
    `${provider.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(provider, call.apiKey) },
      body: JSON.stringify({
        model: call.model,
        ...tokens,
        messages: [
          { role: 'system', content: call.system },
          { role: 'user', content: call.prompt },
        ],
      }),
    },
    call.timeoutMs ?? 120_000,
    provider.label,
  ));

  const text = json.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error(`${provider.label} returned no message content.`);
  return text;
}

/**
 * @param {ProviderCall} call
 * @param {ResolvedProvider} provider
 * @returns {Promise<string>}
 */
async function callGemini(call, provider) {
  const model = encodeURIComponent(call.model);
  const json = /** @type {{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }} */ (await post(
    `${provider.baseUrl}/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(provider, call.apiKey) },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: call.system }] },
        contents: [{ role: 'user', parts: [{ text: call.prompt }] }],
        generationConfig: { maxOutputTokens: call.maxTokens ?? 8192 },
      }),
    },
    call.timeoutMs ?? 120_000,
    provider.label,
  ));

  const text = (json.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('');
  if (!text) throw new Error(`${provider.label} returned no candidate content.`);
  return text;
}
