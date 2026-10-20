import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AI_PROVIDERS,
  DEFAULT_MODELS,
  ERRORS,
  PROVIDERS,
  RESERVED_AI_PARAMS,
  configPatchProblem,
  defaultConfig,
  isAiProvider,
  mergeConfig,
  providerEnvVars,
  providerGaps,
  providerInfo,
  providerOverridesOf,
  resolveAiCall,
  resolveProvider,
  suggestProvider,
} from '@opengeo/core/shared';
import { createAiEnhancer } from '@opengeo/core/generate';
/** @import { OpenGeoConfig } from '@opengeo/core/shared' */
/** @import { ProviderCall } from '@opengeo/core/generate' */

/**
 * The provider catalogue, and the two things that make it more than a list: `resolveProvider`,
 * which is how every caller turns a row plus a project's overrides into a request, and the wire
 * code that has to keep speaking three API shapes no matter how many vendors are in the table.
 */

describe('the catalogue', () => {
  it('gives every row an id, a label, an endpoint and a default model', () => {
    for (const provider of PROVIDERS) {
      expect(provider.id, 'id').toBeTruthy();
      expect(provider.label, `${provider.id} label`).toBeTruthy();
      // `custom` is the one row with neither an endpoint nor a model, because both are the user's
      // to name. Everything else has to be callable straight out of the table.
      if (!provider.userDefined) {
        expect(provider.defaultModel, `${provider.id} model`).toBeTruthy();
        expect(provider.baseUrl, `${provider.id} baseUrl`).toMatch(/^https?:\/\//);
      }
    }
  });

  it('has no duplicate ids and keeps AI_PROVIDERS in picker order', () => {
    const ids = PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(AI_PROVIDERS).toEqual(ids);
  });

  it('covers the providers people actually asked for', () => {
    for (const id of ['anthropic', 'openai', 'gemini', 'xai', 'groq', 'mistral', 'deepseek', 'qwen', 'kimi', 'zai', 'perplexity', 'openrouter', 'ollama', 'lmstudio', 'custom']) {
      expect(AI_PROVIDERS, id).toContain(id);
    }
  });

  it('keeps every alias pointing at exactly one provider, and never at an id of another', () => {
    /** @type {Map<string, string>} */
    const owners = new Map();
    for (const provider of PROVIDERS) {
      for (const alias of provider.aliases ?? []) {
        expect(alias, `${provider.id} alias ${alias}`).toBe(alias.toLowerCase());
        expect(isAiProvider(alias), `${alias} is already an id`).toBe(false);
        expect(owners.get(alias), `${alias} is claimed twice`).toBeUndefined();
        owners.set(alias, provider.id);
      }
    }
  });

  it('writes catalogue flags only for the OpenAI shape it can send them in, and never a reserved field', () => {
    for (const provider of PROVIDERS) {
      for (const key of Object.keys(provider.params ?? {})) {
        expect(RESERVED_AI_PARAMS, `${provider.id} params.${key}`).not.toContain(key);
      }
      // Only Perplexity has a path of its own, and only the OpenAI caller reads one.
      if (provider.path) expect(provider.api, `${provider.id} path`).toBe('openai');
    }
  });

  it('points every hosted provider at a page where a key comes from', () => {
    for (const provider of PROVIDERS) {
      if (provider.keyless || provider.userDefined) continue;
      expect(provider.keysUrl, `${provider.id} keysUrl`).toMatch(/^https:\/\//);
    }
  });

  it('speaks only the three API shapes the wire code implements', () => {
    for (const provider of PROVIDERS) {
      expect(['anthropic', 'openai', 'gemini']).toContain(provider.api);
    }
  });

  it('derives DEFAULT_MODELS and the env-var list from the same rows', () => {
    expect(DEFAULT_MODELS.xai).toBe(providerInfo('xai').defaultModel);
    const vars = providerEnvVars();
    expect(vars.find((entry) => entry.provider === 'xai')?.envVars).toContain('XAI_API_KEY');
    // Nothing keyless or user-defined has a vendor variable to inherit.
    expect(vars.map((entry) => entry.provider)).not.toContain('ollama');
  });

  it('recognises its own ids and nothing else', () => {
    expect(isAiProvider('xai')).toBe(true);
    expect(isAiProvider('XAI')).toBe(false);
    expect(isAiProvider('llama-cpp')).toBe(false);
    expect(isAiProvider('claude')).toBe(false);
    expect(() => providerInfo(/** @type {never} */ ('nope'))).toThrow(/Unknown AI provider/);
  });
});

describe('a provider name that is not an id', () => {
  it('suggests the provider people mean by the product, the company or a misspelling', () => {
    /** @type {Array<[string, string]>} */
    const meant = [
      ['claude', 'anthropic'],
      ['Claude', 'anthropic'],
      ['grok', 'xai'],
      ['kwen', 'qwen'],
      ['alibaba', 'qwen'],
      ['moonshot', 'kimi'],
      ['GLM', 'zai'],
      ['google', 'gemini'],
      ['gpt', 'openai'],
      ['hugging face', 'huggingface'],
      ['LM Studio', 'lmstudio'],
      ['open router', 'openrouter'],
      ['together.ai', 'together'],
      ['anthropc', 'anthropic'],
      ['openia', 'openai'],
      ['perplexty', 'perplexity'],
      ['azure', 'custom'],
    ];
    for (const [typed, id] of meant) expect(suggestProvider(typed), typed).toBe(id);
  });

  it('keeps groq and grok apart, and suggests nothing for a name it does not know', () => {
    expect(suggestProvider('groq')).toBe('groq');
    expect(suggestProvider('grok')).toBe('xai');
    expect(suggestProvider('qwen')).toBe('qwen');
    expect(suggestProvider('banana')).toBeUndefined();
    expect(suggestProvider('')).toBeUndefined();
  });

  it('puts the suggestion in the refusal, first, ahead of the list', () => {
    const message = ERRORS.unknownProvider('claude', AI_PROVIDERS);
    expect(message.split('\n')[0]).toBe('Unknown AI provider "claude". Did you mean "anthropic"?');
    expect(ERRORS.unknownProvider('banana', AI_PROVIDERS).split('\n')[0]).toBe('Unknown AI provider "banana".');
  });
});

describe("the config default, which cannot import the catalogue", () => {
  // defaultConfig() writes the provider and model out as literals on purpose: shared/config.js is
  // in `opengeo-prod`'s import graph, and a value import from providers.js would bundle twelve
  // endpoints and twelve key variable names into the one package that must contain no AI code.
  // check:bundles catches that at build time; these two catch the other half, a catalogue edit
  // that silently leaves the default behind.
  it('names a provider that is in the catalogue', () => {
    expect(isAiProvider(defaultConfig().ai.provider)).toBe(true);
  });

  it("matches that provider's default model", () => {
    const { provider, model } = defaultConfig().ai;
    expect(model).toBe(providerInfo(provider).defaultModel);
  });
});

describe('resolveProvider', () => {
  it('uses the catalogue row when nothing overrides it', () => {
    const resolved = resolveProvider('groq');
    expect(resolved.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(resolved.api).toBe('openai');
    expect(resolved.auth).toBe('bearer');
    expect(resolved.keyless).toBe(false);
  });

  it('lets a gateway replace the endpoint of a built-in provider', () => {
    const resolved = resolveProvider('anthropic', { baseUrl: 'https://gateway.corp.example/anthropic/' });
    // The trailing slash is stripped here so no caller has to remember to.
    expect(resolved.baseUrl).toBe('https://gateway.corp.example/anthropic');
    expect(resolved.api).toBe('anthropic');
  });

  it('carries a row\'s own path and default-model flags, and drops both for another API shape', () => {
    const perplexity = resolveProvider('perplexity');
    expect(perplexity.path).toBe('/sonar');
    expect(perplexity.defaultParams).toEqual({ disable_search: true });
    expect(perplexity.defaultModel).toBe('sonar');
    const elsewhere = resolveProvider('perplexity', { api: 'anthropic', params: { top_k: 5 } });
    expect(elsewhere.path).toBeUndefined();
    expect(elsewhere.defaultParams).toBeUndefined();
    expect(elsewhere.params).toEqual({ top_k: 5 });
  });

  it('treats auth: none as keyless, whatever the row says', () => {
    expect(resolveProvider('openai', { auth: 'none' }).keyless).toBe(true);
    expect(resolveProvider('ollama').keyless).toBe(true);
  });

  it('reports what a user-defined provider is still missing', () => {
    expect(providerGaps('custom', undefined)).toEqual(['ai.baseUrl', 'ai.model']);
    expect(providerGaps('custom', 'my-model', { baseUrl: 'https://x.example/v1' })).toEqual([]);
    expect(providerGaps('anthropic', 'claude-sonnet-5-5')).toEqual([]);
  });
});

describe('the ai block of a config merge', () => {
  /** @type {OpenGeoConfig['ai']} */
  const ai = {
    provider: 'custom',
    model: 'local-1',
    baseUrl: 'https://gateway.corp.example/v1',
    api: 'openai',
    auth: 'bearer',
  };
  /** @type {OpenGeoConfig} */
  const base = { ...defaultConfig(), ai };
  /** @param {Partial<OpenGeoConfig['ai']>} patch */
  const merge = (patch) => mergeConfig(base, { ai: patch }).ai;

  it('drops the old endpoint when the provider changes', () => {
    const merged = merge({ provider: 'anthropic' });
    expect(merged.provider).toBe('anthropic');
    // Keeping the gateway URL here would silently send Anthropic traffic to somebody else's host.
    expect(merged.baseUrl).toBeUndefined();
    expect(merged.api).toBeUndefined();
    expect(merged.auth).toBeUndefined();
  });

  it('keeps an endpoint the patch restates', () => {
    const merged = merge({ provider: 'openai', baseUrl: 'https://gateway.corp.example/openai' });
    expect(merged.baseUrl).toBe('https://gateway.corp.example/openai');
  });

  it('leaves the endpoint alone when the provider is unchanged', () => {
    expect(merge({ model: 'local-2' }).baseUrl).toBe(ai.baseUrl);
  });

  it('drops the old provider\'s params when the provider changes, and keeps them when it does not', () => {
    const withParams = { ...base, ai: { ...ai, params: { temperature: 0 } } };
    expect(mergeConfig(withParams, { ai: { provider: 'groq' } }).ai.params).toBeUndefined();
    expect(mergeConfig(withParams, { ai: { model: 'local-2' } }).ai.params).toEqual({ temperature: 0 });
  });

  it('round-trips through providerOverridesOf', () => {
    expect(providerOverridesOf({ ai: { ...ai, params: { top_p: 1 } } })).toStrictEqual({
      baseUrl: ai.baseUrl,
      api: 'openai',
      auth: 'bearer',
      headers: undefined,
      params: { top_p: 1 },
    });
  });
});

describe('ai.params in a config file', () => {
  it('accepts an object of extra fields', () => {
    expect(configPatchProblem({ ai: { params: { temperature: 0, reasoning_effort: 'low' } } })).toBeUndefined();
  });

  it('refuses a field the request is built around, and anything that is not an object', () => {
    expect(configPatchProblem({ ai: { params: { model: 'x' } } })).toMatch(/ai\.params .* without model, messages/);
    expect(configPatchProblem({ ai: { params: { stream: true } } })).toMatch(/ai\.params/);
    expect(configPatchProblem({ ai: { params: ['temperature'] } })).toMatch(/ai\.params/);
    expect(configPatchProblem({ ai: { params: 'low' } })).toMatch(/ai\.params/);
  });
});

describe('the wire code', () => {
  /**
   * Captures the request an enhancer would have made, and answers with a fixed body.
   * @param {string} reply
   */
  function recorder(reply) {
    /** @type {ProviderCall[]} */
    const calls = [];
    return {
      calls,
      /** @param {ProviderCall} call */
      fn: async (call) => {
        calls.push(call);
        return reply;
      },
    };
  }

  const input = { url: 'https://example.com/a', title: 'A', html: '<h1>A</h1>', algorithmicMarkdown: '# A\n\nOne.' };

  it('passes the project overrides through to the call', async () => {
    const mock = recorder('# A\n\nOne.');
    const enhance = createAiEnhancer({
      provider: 'xai',
      apiKey: 'k',
      call: mock.fn,
      overrides: { baseUrl: 'https://gateway.corp.example/v1' },
      env: {},
    });
    await enhance(input);
    expect(mock.calls[0]?.provider).toBe('xai');
    expect(mock.calls[0]?.model).toBe(DEFAULT_MODELS.xai);
    expect(mock.calls[0]?.overrides?.baseUrl).toBe('https://gateway.corp.example/v1');
  });

  it('refuses a provider it cannot address rather than calling a broken URL', () => {
    expect(() => createAiEnhancer({ provider: 'custom', apiKey: 'k', call: async () => '', env: {} })).toThrow(
      /ai\.baseUrl/,
    );
  });

  it('refuses a provider that does not exist', () => {
    expect(() => createAiEnhancer({ provider: /** @type {never} */ ('grok'), apiKey: 'k', env: {} })).toThrow(/grok/);
  });
});

/**
 * The one place a CLI run or a dashboard request decides which provider to call, with which key, at
 * which address. Every case here is a way the key used to reach a host it was never issued for.
 */
describe('resolveAiCall', () => {
  // Every variable the resolver reads, cleared so a key exported on the machine running the tests
  // cannot decide an outcome. Restored afterwards.
  const NAMES = [...PROVIDERS.flatMap((provider) => provider.envVars), 'OPENGEO_API_KEY', 'OPENGEO_PROVIDER', 'OPENGEO_MODEL', 'OPENGEO_BASE_URL'];
  /** @type {Record<string, string | undefined>} */
  const saved = {};
  /** @type {string} */
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opengeo-ai-call-'));
    for (const name of NAMES) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  /** @param {string[]} lines */
  const env = (lines) => writeFileSync(join(root, '.env'), `${lines.join('\n')}\n`);
  /**
   * @param {Partial<OpenGeoConfig['ai']>} [ai]
   * @returns {OpenGeoConfig}
   */
  const config = (ai = {}) => ({
    ...defaultConfig(),
    ai: { ...defaultConfig().ai, ...ai },
  });
  /** @param {ReturnType<typeof resolveAiCall>} result */
  const call = (result) => {
    if (!('call' in result)) throw new Error(`expected a call, got ${JSON.stringify(result)}`);
    return result.call;
  };

  it('points at a key saved under a name OpenGEO does not read, and never uses it', () => {
    env([
      'claude_api=sk-ant-not-a-real-key',
      'OPENAI_KEY=sk-not-real',
      'OPENAI_API_BASE=https://gateway.example',
      'GOOGLE_MAPS_API_KEY=maps',
      'X_API_KEY=twitter',
      'STRIPE_SECRET_KEY=sk_live_x',
      'kwen-token=q',
    ]);
    const result = resolveAiCall(root, config());
    expect(result).toEqual({
      missing: 'anthropic',
      lookalikes: [
        { name: 'claude_api', provider: 'anthropic' },
        { name: 'OPENAI_KEY', provider: 'openai' },
        { name: 'kwen-token', provider: 'qwen' },
      ],
    });
    const message = ERRORS.noApiKey("generate's AI tier", 'lookalikes' in result ? result.lookalikes : []);
    expect(message).toContain('.env has claude_api, which looks like an Anthropic Claude key');
    expect(message).toContain('ANTHROPIC_API_KEY=<the same key>');
    expect(message).toContain('DASHSCOPE_API_KEY=<the same key>');
    expect(message).not.toContain('sk-ant-not-a-real-key');
    expect(ERRORS.noApiKey('x')).not.toContain('.env has');

    // The short note a keyless `opengeo test` ends with names them too: the person who wrote
    // claude_api= is the one most likely to wonder why the review never runs.
    const skipped = ERRORS.contentReviewSkipped('lookalikes' in result ? result.lookalikes : []);
    expect(skipped).toContain('ANTHROPIC_API_KEY=<the same key>');
    expect(skipped).not.toContain('sk-ant-not-a-real-key');
    expect(ERRORS.contentReviewSkipped()).not.toContain('.env has');
  });

  it('refuses to send one provider\'s key to another one named by a flag', () => {
    env(['OPENAI_API_KEY=sk-openai-only']);
    const result = resolveAiCall(root, config(), { provider: 'anthropic' });
    expect('error' in result).toBe(true);
    const message = /** @type {{ error: string }} */ (result).error;
    expect(message).toContain('anthropic');
    expect(message).toContain('openai');
    expect(message).toContain('ANTHROPIC_API_KEY');
    expect(message).not.toContain('sk-openai-only');
  });

  it('uses the flagged provider\'s own key when there is one', () => {
    env(['OPENAI_API_KEY=sk-openai', 'ANTHROPIC_API_KEY=sk-anthropic']);
    const resolved = call(resolveAiCall(root, config(), { provider: 'anthropic' }));
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.apiKey).toBe('sk-anthropic');
  });

  it('drops the endpoint and model of the configured provider when a flag picks another', () => {
    env([
      'OPENGEO_PROVIDER=custom',
      'OPENGEO_API_KEY=sk-gateway',
      'OPENGEO_BASE_URL=https://gateway.corp.example/v1',
      'OPENAI_API_KEY=sk-openai',
    ]);
    const custom = config({
      provider: 'custom',
      model: 'local-1',
      baseUrl: 'https://gateway.corp.example/v1',
      api: 'openai',
      headers: { 'X-Team': 'web' },
    });
    const resolved = call(resolveAiCall(root, custom, { provider: 'openai' }));
    expect(resolved.apiKey).toBe('sk-openai');
    expect(resolved.overrides.baseUrl).toBeUndefined();
    expect(resolved.overrides.headers).toBeUndefined();
    expect(resolved.overrides.api).toBeUndefined();
    expect(resolved.model).toBe(DEFAULT_MODELS.openai);
  });

  it('does not point a native key at the endpoint configured for a different provider', () => {
    env(['ANTHROPIC_API_KEY=sk-anthropic']);
    const custom = config({ provider: 'custom', model: 'local-1', baseUrl: 'https://gateway.corp.example/v1', api: 'openai' });
    const resolved = call(resolveAiCall(root, custom));
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.overrides.baseUrl).toBeUndefined();
    expect(resolved.model).toBe(DEFAULT_MODELS.anthropic);
  });

  it('keeps the endpoint, model and key when they all belong to the provider being called', () => {
    env(['OPENGEO_PROVIDER=openai', 'OPENGEO_API_KEY=sk-openai']);
    const gateway = config({ provider: 'openai', model: 'gpt-x', baseUrl: 'https://gateway.corp.example/openai' });
    const resolved = call(resolveAiCall(root, gateway));
    expect(resolved).toMatchObject({ provider: 'openai', apiKey: 'sk-openai', model: 'gpt-x', keySource: 'env-file' });
    expect(resolved.overrides.baseUrl).toBe('https://gateway.corp.example/openai');
    expect(call(resolveAiCall(root, gateway, { model: 'gpt-y' })).model).toBe('gpt-y');
  });

  it("uses the configured provider's own default model when the config names a provider and no model", () => {
    // A hand-written `"ai": { "provider": "openai" }` used to inherit the Anthropic default from the
    // merge, and that Claude model id was then sent to OpenAI.
    env(['OPENAI_API_KEY=sk-openai']);
    const loaded = mergeConfig(defaultConfig(), { ai: /** @type {OpenGeoConfig['ai']} */ ({ provider: 'openai' }) });
    expect(call(resolveAiCall(root, loaded)).model).toBe(DEFAULT_MODELS.openai);
  });

  it('keeps a model the same patch names alongside the new provider', () => {
    const merged = mergeConfig(defaultConfig(), { ai: { provider: 'openai', model: 'gpt-x' } });
    expect(merged.ai.model).toBe('gpt-x');
  });

  it('says a key is missing, rather than erroring, when there is none at all', () => {
    expect(resolveAiCall(root, config())).toEqual({ missing: 'anthropic', lookalikes: [] });
    expect(resolveAiCall(root, config(), { provider: 'openai' })).toEqual({ missing: 'openai', lookalikes: [] });
  });

  it('lets the configured provider win over a key some other tool exported', () => {
    // OPENAI_API_KEY comes first in the catalogue, so it used to decide the provider for a project
    // that was set up for Qwen and had its own key sitting right there.
    process.env.OPENAI_API_KEY = 'sk-openai-for-another-tool';
    env(['DASHSCOPE_API_KEY=sk-qwen']);
    const resolved = call(resolveAiCall(root, config({ provider: 'qwen', model: 'qwen-plus' })));
    expect(resolved).toMatchObject({ provider: 'qwen', apiKey: 'sk-qwen', model: 'qwen-plus' });
  });

  it('never moves a project set up for a model on this machine onto a hosted one', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-for-another-tool';
    const resolved = call(resolveAiCall(root, config({ provider: 'ollama', model: 'llama3.2' })));
    expect(resolved).toMatchObject({ provider: 'ollama', apiKey: '', model: 'llama3.2' });
    const gateway = config({ provider: 'custom', model: 'local', baseUrl: 'http://127.0.0.1:8080/v1', api: 'openai', auth: 'none' });
    expect(call(resolveAiCall(root, gateway))).toMatchObject({ provider: 'custom', apiKey: '' });
  });

  it('falls back to whichever key there is when the configured provider has none', () => {
    env(['GROQ_API_KEY=gsk-groq']);
    expect(call(resolveAiCall(root, config({ provider: 'qwen' })))).toMatchObject({ provider: 'groq', apiKey: 'gsk-groq' });
  });

  it('sends the key nowhere when OPENGEO_PROVIDER names no provider', () => {
    // It used to fall through to the Anthropic default, so a Qwen key went to Anthropic.
    env(['OPENGEO_PROVIDER=kwen', 'OPENGEO_API_KEY=sk-qwen']);
    const result = resolveAiCall(root, config());
    expect(result).toEqual({ error: ERRORS.envProviderUnknown('kwen') });
    expect(ERRORS.envProviderUnknown('kwen')).toContain('Did you mean "qwen"?');
    expect(ERRORS.envProviderUnknown('kwen')).not.toContain('sk-qwen');
    // A flag that names a real provider still runs, on that provider's own key and not this one.
    process.env.OPENAI_API_KEY = 'sk-openai';
    expect(call(resolveAiCall(root, config(), { provider: 'openai' }))).toMatchObject({ provider: 'openai', apiKey: 'sk-openai' });
  });

  it('reads OPENGEO_PROVIDER whatever its case', () => {
    env(['OPENGEO_PROVIDER=OpenAI', 'OPENGEO_API_KEY=sk-openai']);
    expect(call(resolveAiCall(root, config()))).toMatchObject({ provider: 'openai', apiKey: 'sk-openai' });
  });

  it('runs a keyless provider with no key, and refuses a provider that does not exist', () => {
    const resolved = call(resolveAiCall(root, config({ provider: 'ollama', model: 'llama3' })));
    expect(resolved).toMatchObject({ provider: 'ollama', apiKey: '', model: 'llama3' });
    expect(resolved.keySource).toBeUndefined();
    expect('error' in resolveAiCall(root, config(), { provider: 'nope' })).toBe(true);
  });
});
