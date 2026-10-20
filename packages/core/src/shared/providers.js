/**
 * The AI provider catalogue (§6, §11).
 *
 * OpenGEO is bring-your-own-key, and "your key" turned out to mean a lot of different things: a
 * Claude key, an OpenAI key, a Qwen key from Alibaba Cloud, a Groq key, a company gateway, or a
 * model running on the user's own laptop. Rather than a switch statement that grows a branch per
 * vendor, every provider is a row in this table, and the wire code in shared/provider-call.js
 * speaks the three API shapes those rows point at.
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
 *   | 'mistral'
 *   | 'deepseek'
 *   | 'qwen'
 *   | 'kimi'
 *   | 'zai'
 *   | 'minimax'
 *   | 'cohere'
 *   | 'perplexity'
 *   | 'openrouter'
 *   | 'groq'
 *   | 'together'
 *   | 'fireworks'
 *   | 'cerebras'
 *   | 'sambanova'
 *   | 'deepinfra'
 *   | 'huggingface'
 *   | 'nvidia'
 *   | 'novita'
 *   | 'ollama'
 *   | 'lmstudio'
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
 * @property {string} [path] The endpoint path, when it is not the one its API shape normally uses.
 *   Perplexity is the case: it speaks the OpenAI shape at `/sonar`, not `/chat/completions`.
 * @property {Record<string, unknown>} [params] Extra request-body fields for the default model,
 *   and only that model. They are what turns off a model's reasoning or a vendor's web search, and
 *   every one of them is a flag the model it was written for accepts and another model may refuse,
 *   so a model the user picks gets none of them. `ai.params` in the config is how they add their
 *   own.
 * @property {string[]} [aliases] Names people type for this provider that are not its id: the
 *   product instead of the company, a common misspelling. Only ever used to suggest the id, never
 *   accepted in its place, so a config file means the same thing on every machine.
 * @property {string} [note] One line the picker and `opengeo help providers` show under the row: what
 *   is different about this one.
 */

/**
 * Order is the order the picker shows, not alphabetical: the three most people already have a key
 * for, then the labs that sell their own models, then the hosts that serve other people's open
 * models, then the two that run on this machine, then the escape hatch. `custom` is last because it
 * is the answer for people the list did not cover, and putting it first would suggest the list is
 * thin.
 *
 * Each default model is the vendor's fast, cheap, current one. Generate's AI tier is transcription,
 * not reasoning, and it runs once per page, so a flagship model would cost ten times as much to
 * reformat a table. Where the default model thinks before it answers, `params` turns that off:
 * thinking tokens count against the output cap, and a long page would otherwise run out of room
 * before the model wrote a word of it.
 *
 * @type {readonly ProviderInfo[]}
 */
export const PROVIDERS = [
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    api: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-5-5',
    auth: 'x-api-key',
    tokenParam: 'max_tokens',
    envVars: ['ANTHROPIC_API_KEY'],
    keysUrl: 'https://console.anthropic.com/settings/keys',
    // Sonnet 5.5 refuses `disabled`; `between_tools` is its lowest setting, and with no tools in the
    // request it means no thinking at all.
    params: { thinking: { type: 'between_tools' } },
    aliases: ['claude', 'sonnet', 'opus', 'haiku'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    api: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-6-luna',
    auth: 'bearer',
    tokenParam: 'max_completion_tokens',
    envVars: ['OPENAI_API_KEY'],
    keysUrl: 'https://platform.openai.com/api-keys',
    params: { reasoning_effort: 'none' },
    aliases: ['gpt', 'chatgpt', 'open-ai'],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    api: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    // Its thinking cannot be switched off, but this model's default level is the lowest one.
    defaultModel: 'gemini-3.5-flash-lite',
    auth: 'x-goog-api-key',
    tokenParam: 'max_tokens',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    keysUrl: 'https://aistudio.google.com/apikey',
    aliases: ['google', 'bard', 'aistudio'],
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    api: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.3',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['XAI_API_KEY', 'GROK_API_KEY'],
    keysUrl: 'https://console.x.ai',
    params: { reasoning_effort: 'none' },
    aliases: ['grok', 'x', 'x-ai'],
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
    aliases: ['mistralai', 'le-chat'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    api: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-flash',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['DEEPSEEK_API_KEY'],
    keysUrl: 'https://platform.deepseek.com/api_keys',
    params: { thinking: { type: 'disabled' } },
    aliases: ['deep-seek'],
  },
  {
    id: 'qwen',
    label: 'Alibaba Qwen',
    api: 'openai',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['DASHSCOPE_API_KEY'],
    keysUrl: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key',
    params: { enable_thinking: false },
    aliases: ['alibaba', 'dashscope', 'tongyi', 'kwen', 'qwen3', 'aliyun'],
    note: 'Keys are tied to a region. A key from the China console needs ai.baseUrl set to https://dashscope.aliyuncs.com/compatible-mode/v1.',
  },
  {
    id: 'kimi',
    label: 'Moonshot Kimi',
    api: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2.6',
    auth: 'bearer',
    tokenParam: 'max_completion_tokens',
    envVars: ['MOONSHOT_API_KEY'],
    keysUrl: 'https://platform.kimi.ai/console/api-keys',
    params: { thinking: { type: 'disabled' } },
    aliases: ['moonshot', 'moonshotai'],
  },
  {
    id: 'zai',
    label: 'Z.ai GLM',
    api: 'openai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-5.3-flash',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['ZAI_API_KEY', 'ZHIPUAI_API_KEY'],
    keysUrl: 'https://z.ai/manage-apikey/apikey-list',
    aliases: ['glm', 'zhipu', 'zhipuai', 'z.ai', 'z-ai', 'chatglm'],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    api: 'openai',
    baseUrl: 'https://api.minimax.io/v1',
    defaultModel: 'MiniMax-M3',
    auth: 'bearer',
    tokenParam: 'max_completion_tokens',
    envVars: ['MINIMAX_API_KEY'],
    keysUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    params: { thinking: { type: 'disabled' } },
    aliases: ['mini-max', 'hailuo'],
  },
  {
    id: 'cohere',
    label: 'Cohere',
    api: 'openai',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    defaultModel: 'command-a-03-2025',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['CO_API_KEY', 'COHERE_API_KEY'],
    keysUrl: 'https://dashboard.cohere.com/api-keys',
    aliases: ['command', 'command-a'],
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    api: 'openai',
    baseUrl: 'https://api.perplexity.ai/v1',
    // Same request and answer as a chat completion, at Perplexity's own path. The old
    // /chat/completions path stopped being supported in September 2026.
    path: '/sonar',
    defaultModel: 'sonar',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['PERPLEXITY_API_KEY', 'PPLX_API_KEY'],
    keysUrl: 'https://www.perplexity.ai/settings/api',
    // A search engine first: left on, it would answer from the web rather than from the page.
    params: { disable_search: true },
    aliases: ['pplx', 'sonar'],
    note: 'Built for search. With search switched off it rewrites pages like any other model, but a general model is the better fit.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    api: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-5.5',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['OPENROUTER_API_KEY'],
    keysUrl: 'https://openrouter.ai/keys',
    aliases: ['open-router'],
    note: 'One key, hundreds of models. The model id carries the vendor prefix, e.g. qwen/qwen-plus or anthropic/claude-haiku-5.5.',
  },
  {
    id: 'groq',
    label: 'Groq',
    api: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['GROQ_API_KEY'],
    keysUrl: 'https://console.groq.com/keys',
    // gpt-oss always reasons; low is its least.
    params: { reasoning_effort: 'low' },
    note: 'Open-weight models on Groq hardware: among the fastest hosted options, with a free tier.',
  },
  {
    id: 'together',
    label: 'Together AI',
    api: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'openai/gpt-oss-120b',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['TOGETHER_API_KEY'],
    keysUrl: 'https://api.together.ai/settings/api-keys',
    aliases: ['togetherai', 'together-ai'],
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    api: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/glm-5p3-flash',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['FIREWORKS_API_KEY'],
    keysUrl: 'https://app.fireworks.ai/settings/users/api-keys',
    aliases: ['fireworks-ai', 'fireworksai'],
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    api: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'qwen-3.8-27b',
    auth: 'bearer',
    tokenParam: 'max_completion_tokens',
    envVars: ['CEREBRAS_API_KEY'],
    keysUrl: 'https://cloud.cerebras.ai',
    params: { reasoning_effort: 'none' },
    note: 'Wafer-scale hardware: among the fastest hosted options for open-weight models.',
  },
  {
    id: 'sambanova',
    label: 'SambaNova',
    api: 'openai',
    baseUrl: 'https://api.sambanova.ai/v1',
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['SAMBANOVA_API_KEY'],
    keysUrl: 'https://cloud.sambanova.ai/apis',
    aliases: ['samba', 'samba-nova'],
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    api: 'openai',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    defaultModel: 'deepseek-ai/DeepSeek-V4.1-Flash',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['DEEPINFRA_API_KEY', 'DEEPINFRA_TOKEN'],
    keysUrl: 'https://deepinfra.com/dash/api_keys',
    aliases: ['deep-infra'],
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    api: 'openai',
    baseUrl: 'https://router.huggingface.co/v1',
    defaultModel: 'openai/gpt-oss-120b',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['HF_TOKEN'],
    keysUrl: 'https://huggingface.co/settings/tokens',
    aliases: ['hf', 'hugging-face'],
    note: 'Routes to whichever inference partner serves the model. The token needs the "Make calls to Inference Providers" permission.',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    api: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'nvidia/nemotron-3-super-120b-a12b',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['NVIDIA_API_KEY'],
    keysUrl: 'https://build.nvidia.com',
    params: { chat_template_kwargs: { enable_thinking: false } },
    aliases: ['nim', 'nemotron'],
  },
  {
    id: 'novita',
    label: 'Novita AI',
    api: 'openai',
    baseUrl: 'https://api.novita.ai/openai/v1',
    defaultModel: 'deepseek/deepseek-v4.1-flash',
    auth: 'bearer',
    tokenParam: 'max_tokens',
    envVars: ['NOVITA_API_KEY'],
    keysUrl: 'https://novita.ai/settings/key-management',
    aliases: ['novitaai', 'novita-ai'],
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
    note: 'No key, no network. Start it with OLLAMA_CONTEXT_LENGTH=32768 ollama serve, or long pages are cut short before the model sees them.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (on this machine)',
    api: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'openai/gpt-oss-20b',
    auth: 'none',
    tokenParam: 'max_tokens',
    envVars: [],
    keyless: true,
    keysUrl: 'https://lmstudio.ai',
    aliases: ['lm-studio', 'lms'],
    note: 'No key, no network. Turn on the server in the Developer tab, load a model, and use the id it shows.',
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
    aliases: ['other', 'gateway', 'proxy', 'vllm', 'llamacpp', 'llama.cpp', 'azure', 'litellm'],
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
 * The provider somebody probably meant by a name that is not an id, or nothing.
 *
 * "claude", "grok" and "kwen" are what people type, and a list of twenty-five ids is a poor answer
 * to any of them. This is a suggestion and never a substitute: `--provider claude` still stops, so
 * the same config file cannot mean two things on two versions of OpenGEO.
 *
 * @param {string} input
 * @returns {AiProvider | undefined}
 */
export function suggestProvider(input) {
  const wanted = input.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!wanted) return undefined;
  if (isAiProvider(wanted)) return wanted;
  /** @param {string} name */
  const squash = (name) => name.replace(/[-.]/g, '');
  const names = PROVIDERS.flatMap((provider) => [provider.id, ...(provider.aliases ?? [])].map((name) => ({ id: provider.id, name })));
  // Every exact name before any near one, so "grok" is xAI's product and not one typo from Groq.
  const exact = names.find(({ name }) => squash(name) === squash(wanted));
  if (exact) return exact.id;
  /** @type {{ id: AiProvider; distance: number } | undefined} */
  let best;
  for (const { id, name } of names) {
    // Up to two edits, fewer for a short name, catches "anthropc" and "openia" without turning
    // "qwen" into "groq".
    const distance = editDistance(wanted, name);
    if (distance <= Math.min(2, Math.floor(name.length / 3)) && (!best || distance < best.distance)) best = { id, distance };
  }
  return best?.id;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

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
 * @property {Record<string, unknown>} [params] Extra request-body fields, merged over the
 *   catalogue's own. A `null` removes a field the catalogue would have sent.
 */

/**
 * @typedef {object} ResolvedProvider
 * @property {AiProvider} id
 * @property {string} label
 * @property {ProviderApi} api
 * @property {string} baseUrl
 * @property {string} [path] Set only when the endpoint does not use its shape's usual path.
 * @property {ProviderAuth} auth
 * @property {Record<string, string>} headers
 * @property {'max_tokens' | 'max_completion_tokens'} tokenParam
 * @property {boolean} keyless
 * @property {string} defaultModel
 * @property {Record<string, unknown>} [defaultParams] The catalogue's fields for `defaultModel`.
 * @property {Record<string, unknown>} [params] The project's own `ai.params`.
 */

/**
 * @param {AiProvider} id
 * @param {ProviderOverrides} [overrides]
 * @returns {ResolvedProvider}
 */
export function resolveProvider(id, overrides = {}) {
  const info = providerInfo(id);
  const baseUrl = (overrides.baseUrl || info.baseUrl).replace(/\/+$/, '');
  const api = overrides.api ?? info.api;
  // A row's path and flags describe its own wire shape. Pointed at another shape, they would only
  // produce a 404 or a refused field, so the shape's defaults apply instead.
  const sameShape = api === info.api;
  return {
    id,
    label: info.label,
    api,
    baseUrl,
    path: sameShape ? info.path : undefined,
    auth: overrides.auth ?? info.auth,
    headers: overrides.headers ?? {},
    tokenParam: info.tokenParam,
    keyless: Boolean(info.keyless) || (overrides.auth ?? info.auth) === 'none',
    defaultModel: info.defaultModel,
    defaultParams: sameShape ? info.params : undefined,
    params: overrides.params,
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
