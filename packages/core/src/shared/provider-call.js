import { AI_PROVIDERS, isAiProvider, resolveProvider } from './providers.js';
import { ERRORS } from './errors.js';

/**
 * @import { AiProvider, ProviderOverrides, ResolvedProvider } from './providers.js'
 */

/**
 * The one HTTP call to an AI provider, shared by generate's AI tier and test's content review so
 * neither pillar has to import the other to reach it. The key goes to exactly one place: the
 * provider the user picked (§11).
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

/** The output cap sent with every call that does not set its own. */
export const DEFAULT_MAX_TOKENS = 8192;

/**
 * The provider stopped because it hit the output cap. What it returned is the start of an answer,
 * and a rewrite that is missing its end must never be accepted or cached.
 */
export class TruncatedOutputError extends Error {
  /** @param {string} provider */
  constructor(provider) {
    super(ERRORS.aiOutputTruncated(provider));
    this.name = 'TruncatedOutputError';
  }
}

/**
 * Models often wrap a whole document in ```markdown despite being told not to. Unwrapping that is
 * not a fidelity concern, so it happens before the check rather than being counted against it.
 *
 * A document that merely opens and closes with code blocks of its own looks the same from the
 * outside, and unwrapping it deletes the first fence and the last and turns the prose between them
 * into code. So a bare fence is taken as a wrapper only when nothing inside it is a fence, and a
 * `markdown` fence only when the fences inside it pair up.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripCodeFence(text) {
  const trimmed = text.trim();
  const match = /^```(markdown|md)?[^\S\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (!match) return trimmed;
  const inner = match[2];
  const innerFences = inner.split('\n').filter((line) => /^\s*(```|~~~)/.test(line)).length;
  const wrapped = match[1] ? innerFences % 2 === 0 : innerFences === 0;
  return wrapped ? inner : trimmed;
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
 * @param {string} apiKey Only so it can be taken back out of an error body that echoes it.
 * @returns {Promise<unknown>}
 */
async function post(url, init, timeoutMs, label, apiKey) {
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
    // A gateway that echoes the request back would otherwise put the key in a message that is
    // printed, kept as a generate warning and sent to the dashboard. Both refusals below quote it.
    const shown = apiKey ? body.split(apiKey).join('[redacted]') : body;
    if (!response.ok) {
      // The status rides along so a caller with many calls queued can tell a refused key from one bad document.
      throw Object.assign(new Error(ERRORS.providerFailed(label, response.status, shown)), { status: response.status });
    }
    // A 200 is no promise of JSON: a proxy or a captive portal in front of the endpoint answers with
    // a page, and a parser error would name a token rather than the endpoint.
    /** @type {unknown} */
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(ERRORS.providerNotJson(label, shown));
    }
    if (typeof json !== 'object' || json === null) throw new Error(ERRORS.providerNotJson(label, shown));
    return json;
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
  const json = /** @type {{ content?: Array<{ type?: string; text?: string }>; stop_reason?: string }} */ (await post(
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
        max_tokens: call.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: call.system,
        messages: [{ role: 'user', content: call.prompt }],
      }),
    },
    call.timeoutMs ?? 120_000,
    provider.label,
    call.apiKey,
  ));

  if (json.stop_reason === 'max_tokens') throw new TruncatedOutputError(provider.label);
  const text = (Array.isArray(json.content) ? json.content : [])
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
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
  const tokens = { [provider.tokenParam]: call.maxTokens ?? DEFAULT_MAX_TOKENS };
  const json = /** @type {{ choices?: Array<{ message?: { content?: string }; finish_reason?: string }> }} */ (await post(
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
    call.apiKey,
  ));

  if (json.choices?.[0]?.finish_reason === 'length') throw new TruncatedOutputError(provider.label);
  const content = json.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : '';
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
  const json = /** @type {{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }> }} */ (await post(
    `${provider.baseUrl}/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(provider, call.apiKey) },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: call.system }] },
        contents: [{ role: 'user', parts: [{ text: call.prompt }] }],
        generationConfig: { maxOutputTokens: call.maxTokens ?? DEFAULT_MAX_TOKENS },
      }),
    },
    call.timeoutMs ?? 120_000,
    provider.label,
    call.apiKey,
  ));

  if (json.candidates?.[0]?.finishReason === 'MAX_TOKENS') throw new TruncatedOutputError(provider.label);
  const parts = json.candidates?.[0]?.content?.parts;
  const text = (Array.isArray(parts) ? parts : []).map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  if (!text) throw new Error(`${provider.label} returned no candidate content.`);
  return text;
}
