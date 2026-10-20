import { AI_PROVIDERS, isAiProvider, resolveProvider } from './providers.js';
import { RESERVED_AI_PARAMS } from './config.js';
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

/** How long one call may take when the caller set no limit. A long page is a long answer. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Statuses that hold for every call this run would make: the key is refused (401, 403), the
 * account has no credit (402), or there is no such model or address (404). A caller with more
 * pages queued stops sending after one, rather than printing the same failure once per page and,
 * on a provider that bills refused calls, paying for it. A 400 is not one of them: it can be about
 * a single request, such as a page too long for the model.
 *
 * @param {unknown} status
 * @returns {status is number}
 */
export function failsEveryCall(status) {
  return status === 401 || status === 402 || status === 403 || status === 404;
}

/**
 * The provider's own explanation, out of the envelope it came in. Every vendor nests it somewhere
 * different, and the raw JSON buries "model: claude-sonet-9" among type tags and request ids.
 * Anything that is not one of the familiar shapes is returned as it was.
 *
 * @param {string} body
 * @returns {string}
 */
export function providerMessage(body) {
  /** @type {any} */
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return body.trim();
  }
  // Gemini has answered with a one-element array of the same envelope.
  const envelope = Array.isArray(json) ? json[0] : json;
  const candidates = [envelope?.error?.message, envelope?.message, envelope?.error, envelope?.detail];
  const found = candidates.find((value) => typeof value === 'string' && value.trim());
  return typeof found === 'string' ? found.trim() : body.trim();
}

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
 * The config loader refuses these in `ai.params`; skipping them here as well covers a caller that
 * built its overrides without going through the loader.
 */
const RESERVED_PARAMS = new Set(/** @type {readonly string[]} */ (RESERVED_AI_PARAMS));

/**
 * The body as sent: the shape's own fields, then the catalogue's flags for its default model, then
 * the project's `ai.params`.
 *
 * The catalogue's flags are for one model. `thinking: { type: 'disabled' }` is the right thing to
 * send DeepSeek's flash model and a 400 from a model that has no switch, so a model the user picked
 * gets only what they wrote in `ai.params`. Objects merge rather than replace, so `ai.params` can set
 * `generationConfig.temperature` without losing the output cap, and a `null` takes a field out.
 *
 * @param {Record<string, unknown>} body
 * @param {ProviderCall} call
 * @param {ResolvedProvider} provider
 * @returns {Record<string, unknown>}
 */
export function requestBody(body, call, provider) {
  let merged = body;
  if (provider.defaultParams && call.model === provider.defaultModel) merged = mergeParams(merged, provider.defaultParams, true);
  if (provider.params) merged = mergeParams(merged, provider.params, true);
  return merged;
}

/**
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} extra
 * @param {boolean} top
 * @returns {Record<string, unknown>}
 */
function mergeParams(base, extra, top) {
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (top && RESERVED_PARAMS.has(key)) continue;
    // Keys that would reach the prototype instead of the body.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (value === null) delete out[key];
    else if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeParams(/** @type {Record<string, unknown>} */ (out[key]), value, false);
    else out[key] = value;
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The only network call in OpenGSO that carries the user's API key.
 *
 * Dispatch is on the *wire format*, not on the vendor. Most of the industry ships an
 * OpenAI-compatible endpoint, so one caller plus a base URL covers Grok, Qwen, Kimi, DeepSeek,
 * Groq, OpenRouter, a local Ollama, and whatever gateway a company put in front of them. Adding a
 * vendor that follows the pattern is a row in the catalogue, not a branch here.
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
      throw new Error(ERRORS.unknownApiShape(provider.api));
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
 * @param {ProviderCall} call For the limit, the model an error should name, and the key, which is
 *   only here so it can be taken back out of an error body that echoes it.
 * @param {string} label
 * @returns {Promise<unknown>}
 */
async function post(url, init, call, label) {
  const { apiKey } = call;
  const timeoutMs = call.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
      throw Object.assign(new Error(ERRORS.providerFailed(label, response.status, providerMessage(shown), call.model)), { status: response.status });
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
      throw new Error(ERRORS.providerTimeout(label, Math.round(timeoutMs / 1000), call.timeoutMs !== undefined));
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
      body: JSON.stringify(
        requestBody(
          {
            model: call.model,
            max_tokens: call.maxTokens ?? DEFAULT_MAX_TOKENS,
            system: call.system,
            messages: [{ role: 'user', content: call.prompt }],
          },
          call,
          provider,
        ),
      ),
    },
    call,
    provider.label,
  ));

  if (json.stop_reason === 'max_tokens') throw new TruncatedOutputError(provider.label);
  if (json.stop_reason === 'refusal') throw new Error(ERRORS.providerRefused(provider.label));
  // Text blocks only: a thinking block, if `ai.params` turned thinking on, is working, not the page.
  const text = (Array.isArray(json.content) ? json.content : [])
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('');
  if (!text) throw new Error(ERRORS.providerEmpty(provider.label, 'text'));
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
  const json = /** @type {{ choices?: Array<{ message?: { content?: unknown; refusal?: unknown }; finish_reason?: string }> }} */ (await post(
    `${provider.baseUrl}${provider.path ?? '/chat/completions'}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(provider, call.apiKey) },
      body: JSON.stringify(
        requestBody(
          {
            model: call.model,
            ...tokens,
            messages: [
              { role: 'system', content: call.system },
              { role: 'user', content: call.prompt },
            ],
          },
          call,
          provider,
        ),
      ),
    },
    call,
    provider.label,
  ));

  const choice = json.choices?.[0];
  if (choice?.finish_reason === 'length') throw new TruncatedOutputError(provider.label);
  if (typeof choice?.message?.refusal === 'string' && choice.message.refusal) throw new Error(ERRORS.providerRefused(provider.label));
  const text = withoutReasoning(messageText(choice?.message?.content));
  if (!text) throw new Error(ERRORS.providerEmpty(provider.label, 'message'));
  return text;
}

/**
 * A message's text, whichever way the endpoint spells it. Most send a string; Mistral's reasoning
 * models and some gateways send a list of parts, where only the `text` parts are the answer.
 *
 * @param {unknown} content
 * @returns {string}
 */
function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/**
 * Open-weight reasoning models served through an OpenAI-shaped endpoint often put their working in
 * the answer itself, inside `<think>` tags, when the host has no separate field for it. That working
 * is not the page, and the fidelity check would rightly reject a twin that opened with it.
 *
 * @param {string} text
 * @returns {string}
 */
export function withoutReasoning(text) {
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '');
}

/**
 * @param {ProviderCall} call
 * @param {ResolvedProvider} provider
 * @returns {Promise<string>}
 */
async function callGemini(call, provider) {
  const model = encodeURIComponent(call.model);
  const json = /** @type {{ candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>; promptFeedback?: { blockReason?: string } }} */ (await post(
    `${provider.baseUrl}/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(provider, call.apiKey) },
      body: JSON.stringify(
        requestBody(
          {
            systemInstruction: { parts: [{ text: call.system }] },
            contents: [{ role: 'user', parts: [{ text: call.prompt }] }],
            generationConfig: { maxOutputTokens: call.maxTokens ?? DEFAULT_MAX_TOKENS },
          },
          call,
          provider,
        ),
      ),
    },
    call,
    provider.label,
  ));

  const candidate = json.candidates?.[0];
  if (candidate?.finishReason === 'MAX_TOKENS') throw new TruncatedOutputError(provider.label);
  if (json.promptFeedback?.blockReason || candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'PROHIBITED_CONTENT') {
    throw new Error(ERRORS.providerRefused(provider.label));
  }
  const parts = candidate?.content?.parts;
  // A part marked `thought` is a thought summary, which `ai.params` can ask for; it is not the page.
  const text = (Array.isArray(parts) ? parts : []).map((part) => (typeof part?.text === 'string' && !part.thought ? part.text : '')).join('');
  if (!text) throw new Error(ERRORS.providerEmpty(provider.label, 'candidate'));
  return text;
}
