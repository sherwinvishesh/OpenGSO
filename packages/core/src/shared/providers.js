/**
 * The AI provider catalogue (§6, §11).
 *
 * OpenGEO is bring-your-own-key, and "your key" turned out to mean a lot of different things: a
 * Claude key, an OpenAI key, a Grok key, a Groq key, a company gateway, or a model running on the
 * user's own laptop. Rather than a switch statement that grows a branch per vendor, every provider
 * is a row in this table, and the wire code in generate/ai.ts speaks the three API shapes those
 * rows point at.
 *
 * That is also what makes "add your own" a supported feature rather than a fork: the `custom`
 * provider is a row with the endpoint fields left for the user's config to fill in, so anything
 * that speaks one of the three shapes works without a code change.
 *
 * Nothing here holds a key. The table is the shape of the request; the key comes from `.env` at the
 * moment of the call and goes nowhere else.
 */

/**
 * The three request/response shapes every provider on the market currently speaks.
 *
 * @typedef {'anthropic' | 'openai' | 'gemini'} ProviderApi
 */

/**
 * How the key is attached to the request. `none` is for a local server that wants no key.
 *
 * @typedef {'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none'} ProviderAuth
 */

/**
 * @typedef {'anthropic'
 *   | 'openai'
 *   | 'gemini'
 *   | 'xai'
 *   | 'groq'
 *   | 'mistral'
 *   | 'deepseek'
 *   | 'openrouter'
 *   | 'together'
 *   | 'perplexity'
 *   | 'ollama'
 *   | 'custom'} AiProvider
 */

/**
 * @typedef {object} ProviderInfo
 * @property {AiProvider} id
 * @property {string} label Shown in the picker and in reports. The vendor's own name for itself.
 * @property {ProviderApi} api
 * @property {string} baseUrl Everything up to but not including the endpoint path. Overridable per
 *   project.
 * @property {string} defaultModel
 * @property {ProviderAuth} auth
 * @property {'max_tokens' | 'max_completion_tokens'} tokenParam OpenAI's current endpoints reject
 *   `max_tokens` on their newer models, and most of the OpenAI-compatible clones reject
 *   `max_completion_tokens`. One field, so neither is broken.
 * @property {string[]} envVars Provider-native variables people already have exported, accepted so
 *   nobody duplicates a key.
 * @property {string} [keysUrl] Where a key comes from. Printed by `opengeo settings` and by the
 *   "no key" error.
 * @property {boolean} [keyless] No key at all: a model server on the user's own machine.
 * @property {boolean} [userDefined] The endpoint is the user's to name, so `ai.baseUrl` and
 *   `ai.model` are required.
 * @property {string} [note]
 */

/**
 * Order is the order the picker shows, not alphabetical: the three OpenGEO started with, then the
 * hosted APIs, then the local option, then the escape hatch. `custom` is last because it is the
 * answer for people the list did not cover, and putting it first would suggest the list is thin.
 *
 * @type {readonly ProviderInfo[]}
 */
export const PROVIDERS = [
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    api: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-5',
    auth: 'x-api-key',
    tokenParam: 'max_tokens',
    envVars: ['ANTHROPIC_API_KEY'],
    keysUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    api: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    auth: 'bearer',
    tokenParam: 'max_completion_tokens',
    envVars: ['OPENAI_API_KEY'],
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    api: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-flash',
    auth: 'x-goog-api-key',
    tokenParam: 'max_tokens',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    keysUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    api: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['XAI_API_KEY', 'GROK_API_KEY'],
    keysUrl: 'https://console.x.ai',
  },
  {
    id: 'groq',
    label: 'Groq',
    api: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['GROQ_API_KEY'],
    keysUrl: 'https://console.groq.com/keys',
    note: 'Open-weight models on Groq hardware. Fast enough that a whole site regenerates in a minute.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    api: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['MISTRAL_API_KEY'],
    keysUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    api: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['DEEPSEEK_API_KEY'],
    keysUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    api: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['OPENROUTER_API_KEY'],
    keysUrl: 'https://openrouter.ai/keys',
    note: 'One key, hundreds of models. The model id carries the vendor prefix, e.g. openai/gpt-4o-mini.',
  },
  {
    id: 'together',
    label: 'Together AI',
    api: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['TOGETHER_API_KEY'],
    keysUrl: 'https://api.together.ai/settings/api-keys',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    api: 'openai',
    baseUrl: 'https://api.perplexity.ai',
    defaultModel: 'sonar',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['PERPLEXITY_API_KEY'],
    keysUrl: 'https://www.perplexity.ai/settings/api',
  },
  {
    id: 'ollama',
    label: 'Ollama (on this machine)',
    api: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    auth: 'none',
    tokenParam: 'max_tokens',
    envVars: [],
    keyless: true,
    keysUrl: 'https://ollama.com/download',
    note: 'No key, no network. `ollama serve` has to be running, and the model already pulled.',
  },
  {
    id: 'custom',
    label: 'Something else (your own endpoint)',
    api: 'openai',
    baseUrl: '',
    defaultModel: '',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: [],
    userDefined: true,
    note: 'Any endpoint that speaks the OpenAI, Anthropic or Gemini shape: a gateway, a proxy, a self-hosted server.',
  },
];

// The three derived tables below are marked pure so a bundle that imports this module and uses none
// of them can drop them, catalogue and all. `errors.js` imports from here and `config.js` imports
// `errors.js`, so without the marks `opengeo-prod` ships every provider endpoint. `check:bundles`
// is what notices if a new top-level call undoes this.
/** @type {AiProvider[]} */
export const AI_PROVIDERS = /* @__PURE__ */ PROVIDERS.map((provider) => provider.id);

/** @type {Map<AiProvider, ProviderInfo>} */
const BY_ID = /* @__PURE__ */ new Map(
  /* @__PURE__ */ PROVIDERS.map((provider) => [provider.id, provider]),
);

/**
 * @param {unknown} value
 * @returns {value is AiProvider}
 */
export function isAiProvider(value) {
  return typeof value === 'string' && BY_ID.has(/** @type {AiProvider} */ (value));
}

/**
 * @param {AiProvider} id
 * @returns {ProviderInfo}
 */
export function providerInfo(id) {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown AI provider: ${id}`);
  return found;
}

export const DEFAULT_MODELS = /** @type {Record<AiProvider, string>} */ (/* @__PURE__ */ Object.fromEntries(
  /* @__PURE__ */ PROVIDERS.map((provider) => [provider.id, provider.defaultModel]),
));

/**
 * Every provider-native variable the catalogue accepts, in picker order, for the docs and `.env`.
 *
 * @returns {Array<{ provider: AiProvider; envVars: string[] }>}
 */
export function providerEnvVars() {
  return PROVIDERS.filter((provider) => provider.envVars.length > 0).map((provider) => ({
    provider: provider.id,
    envVars: [...provider.envVars],
  }));
}

/**
 * How a project's `ai` block overrides the catalogue row.
 *
 * Every field is optional and every field is honoured for *any* provider, not just `custom`: the
 * common reason to set `baseUrl` on a built-in is a corporate gateway that mirrors the vendor's API
 * at a different host, and refusing that would push people to `custom` for no reason.
 *
 * @typedef {object} ProviderOverrides
 * @property {string} [baseUrl]
 * @property {ProviderApi} [api]
 * @property {ProviderAuth} [auth]
 * @property {Record<string, string>} [headers]
 */

/**
 * @typedef {object} ResolvedProvider
 * @property {AiProvider} id
 * @property {string} label
 * @property {ProviderApi} api
 * @property {string} baseUrl
 * @property {ProviderAuth} auth
 * @property {Record<string, string>} headers
 * @property {'max_tokens' | 'max_completion_tokens'} tokenParam
 * @property {boolean} keyless
 */

/**
 * @param {AiProvider} id
 * @param {ProviderOverrides} [overrides]
 * @returns {ResolvedProvider}
 */
export function resolveProvider(id, overrides = {}) {
  const info = providerInfo(id);
  const baseUrl = (overrides.baseUrl || info.baseUrl).replace(/\/+$/, '');
  return {
    id,
    label: info.label,
    api: overrides.api ?? info.api,
    baseUrl,
    auth: overrides.auth ?? info.auth,
    headers: overrides.headers ?? {},
    tokenParam: info.tokenParam,
    keyless: Boolean(info.keyless) || (overrides.auth ?? info.auth) === 'none',
  };
}

/**
 * What is still missing before this provider can be called, in a sentence, or nothing.
 *
 * @param {AiProvider} id
 * @param {string | undefined} model
 * @param {ProviderOverrides} [overrides]
 * @returns {string[]}
 */
export function providerGaps(id, model, overrides = {}) {
  const info = providerInfo(id);
  /** @type {string[]} */
  const gaps = [];
  if (!(overrides.baseUrl || info.baseUrl)) gaps.push('ai.baseUrl');
  if (!model) gaps.push('ai.model');
  return gaps;
}
