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

/** The three request/response shapes every provider on the market currently speaks. */
export type ProviderApi = 'anthropic' | 'openai' | 'gemini';

/** How the key is attached to the request. `none` is for a local server that wants no key. */
export type ProviderAuth = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';

export type AiProvider =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'xai'
  | 'groq'
  | 'mistral'
  | 'deepseek'
  | 'openrouter'
  | 'together'
  | 'perplexity'
  | 'ollama'
  | 'custom';

export interface ProviderInfo {
  id: AiProvider;
  /** Shown in the picker and in reports. The vendor's own name for itself. */
  label: string;
  api: ProviderApi;
  /** Everything up to but not including the endpoint path. Overridable per project. */
  baseUrl: string;
  defaultModel: string;
  auth: ProviderAuth;
  /**
   * OpenAI's current endpoints reject `max_tokens` on their newer models, and most of the
   * OpenAI-compatible clones reject `max_completion_tokens`. One field, so neither is broken.
   */
  tokenParam: 'max_tokens' | 'max_completion_tokens';
  /** Provider-native variables people already have exported, accepted so nobody duplicates a key. */
  envVars: string[];
  /** Where a key comes from. Printed by `opengeo settings` and by the "no key" error. */
  keysUrl?: string;
  /** No key at all: a model server on the user's own machine. */
  keyless?: boolean;
  /** The endpoint is the user's to name, so `ai.baseUrl` and `ai.model` are required. */
  userDefined?: boolean;
  note?: string;
}

/**
 * Order is the order the picker shows, not alphabetical: the three OpenGEO started with, then the
 * hosted APIs, then the local option, then the escape hatch. `custom` is last because it is the
 * answer for people the list did not cover, and putting it first would suggest the list is thin.
 */
export const PROVIDERS: readonly ProviderInfo[] = [
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

export const AI_PROVIDERS: AiProvider[] = PROVIDERS.map((provider) => provider.id);

const BY_ID = new Map<AiProvider, ProviderInfo>(PROVIDERS.map((provider) => [provider.id, provider]));

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && BY_ID.has(value as AiProvider);
}

export function providerInfo(id: AiProvider): ProviderInfo {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown AI provider: ${id}`);
  return found;
}

export const DEFAULT_MODELS: Record<AiProvider, string> = Object.fromEntries(
  PROVIDERS.map((provider) => [provider.id, provider.defaultModel]),
) as Record<AiProvider, string>;

/** Every provider-native variable the catalogue accepts, in picker order, for the docs and `.env`. */
export function providerEnvVars(): Array<{ provider: AiProvider; envVars: string[] }> {
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
 */
export interface ProviderOverrides {
  baseUrl?: string;
  api?: ProviderApi;
  auth?: ProviderAuth;
  headers?: Record<string, string>;
}

export interface ResolvedProvider {
  id: AiProvider;
  label: string;
  api: ProviderApi;
  baseUrl: string;
  auth: ProviderAuth;
  headers: Record<string, string>;
  tokenParam: 'max_tokens' | 'max_completion_tokens';
  keyless: boolean;
}

export function resolveProvider(id: AiProvider, overrides: ProviderOverrides = {}): ResolvedProvider {
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

/** What is still missing before this provider can be called, in a sentence, or nothing. */
export function providerGaps(id: AiProvider, model: string | undefined, overrides: ProviderOverrides = {}): string[] {
  const info = providerInfo(id);
  const gaps: string[] = [];
  if (!(overrides.baseUrl || info.baseUrl)) gaps.push('ai.baseUrl');
  if (!model) gaps.push('ai.model');
  return gaps;
}
