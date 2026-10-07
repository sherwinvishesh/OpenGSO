import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AI_PROVIDERS,
  DEFAULT_MODELS,
  PROVIDERS,
  defaultConfig,
  isAiProvider,
  mergeConfig,
  providerEnvVars,
  providerGaps,
  providerInfo,
  providerOverridesOf,
  resolveAiCall,
  resolveProvider,
} from '@opengeo/core/shared';
import type { OpenGeoConfig } from '@opengeo/core/shared';
import { createAiEnhancer } from '@opengeo/core/generate';
import type { ProviderCall } from '@opengeo/core/generate';

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
    for (const id of ['anthropic', 'openai', 'gemini', 'xai', 'groq', 'mistral', 'deepseek', 'ollama', 'custom']) {
      expect(AI_PROVIDERS, id).toContain(id);
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
    expect(() => providerInfo('nope' as never)).toThrow(/Unknown AI provider/);
  });
});

describe("the config default, which cannot import the catalogue", () => {
  // defaultConfig() writes the provider and model out as literals on purpose: shared/config.js is
  // in `opengeo-prod`'s import graph, and a value import from providers.ts would bundle twelve
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

  it('treats auth: none as keyless, whatever the row says', () => {
    expect(resolveProvider('openai', { auth: 'none' }).keyless).toBe(true);
    expect(resolveProvider('ollama').keyless).toBe(true);
  });

  it('reports what a user-defined provider is still missing', () => {
    expect(providerGaps('custom', undefined)).toEqual(['ai.baseUrl', 'ai.model']);
    expect(providerGaps('custom', 'my-model', { baseUrl: 'https://x.example/v1' })).toEqual([]);
    expect(providerGaps('anthropic', 'claude-sonnet-5')).toEqual([]);
  });
});

describe('the ai block of a config merge', () => {
  const ai: OpenGeoConfig['ai'] = {
    provider: 'custom',
    model: 'local-1',
    baseUrl: 'https://gateway.corp.example/v1',
    api: 'openai',
    auth: 'bearer',
  };
  const base: OpenGeoConfig = { ...defaultConfig(), ai };
  const merge = (patch: Partial<OpenGeoConfig['ai']>) => mergeConfig(base, { ai: patch }).ai;

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

  it('round-trips through providerOverridesOf', () => {
    expect(providerOverridesOf({ ai })).toEqual({
      baseUrl: ai.baseUrl,
      api: 'openai',
      auth: 'bearer',
      headers: undefined,
    });
  });
});

describe('the wire code', () => {
  /** Captures the request an enhancer would have made, and answers with a fixed body. */
  function recorder(reply: string) {
    const calls: ProviderCall[] = [];
    return {
      calls,
      fn: async (call: ProviderCall) => {
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
    expect(() => createAiEnhancer({ provider: 'grok' as never, apiKey: 'k', env: {} })).toThrow(/grok/);
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
  const saved: Record<string, string | undefined> = {};
  let root: string;

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

  const env = (lines: string[]) => writeFileSync(join(root, '.env'), `${lines.join('\n')}\n`);
  const config = (ai: Partial<OpenGeoConfig['ai']> = {}): OpenGeoConfig => ({
    ...defaultConfig(),
    ai: { ...defaultConfig().ai, ...ai },
  });
  const call = (result: ReturnType<typeof resolveAiCall>) => {
    if (!('call' in result)) throw new Error(`expected a call, got ${JSON.stringify(result)}`);
    return result.call;
  };

  it('refuses to send one provider\'s key to another one named by a flag', () => {
    env(['OPENAI_API_KEY=sk-openai-only']);
    const result = resolveAiCall(root, config(), { provider: 'anthropic' });
    expect('error' in result).toBe(true);
    const message = (result as { error: string }).error;
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

  it('says a key is missing, rather than erroring, when there is none at all', () => {
    expect(resolveAiCall(root, config())).toEqual({ missing: 'anthropic' });
    expect(resolveAiCall(root, config(), { provider: 'openai' })).toEqual({ missing: 'openai' });
  });

  it('runs a keyless provider with no key, and refuses a provider that does not exist', () => {
    const resolved = call(resolveAiCall(root, config({ provider: 'ollama', model: 'llama3' })));
    expect(resolved).toMatchObject({ provider: 'ollama', apiKey: '', model: 'llama3' });
    expect(resolved.keySource).toBeUndefined();
    expect('error' in resolveAiCall(root, config(), { provider: 'nope' })).toBe(true);
  });
});
