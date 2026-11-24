import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_PROVIDERS, providerEnvVars, providerInfo, readCredentials, suggestProvider } from '@opengso/core/shared';
import { callProvider } from '../src/shared/provider-call.js';

/**
 * The AI/ML API row: where its key goes, and that it changes nothing for a project already set up
 * with another provider.
 */

const KEY = 'sk-test-not-a-real-key';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** @param {Array<{ url: string; init: RequestInit }>} seen @param {() => Response} answer */
function stubFetch(seen, answer) {
  vi.stubGlobal('fetch', async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    seen.push({ url: String(url), init });
    return answer();
  });
}

describe('the aimlapi row', () => {
  it('is an OpenAI-shaped row on api.aimlapi.com with a bearer key', () => {
    const row = providerInfo('aimlapi');
    expect(AI_PROVIDERS).toContain('aimlapi');
    expect(row).toMatchObject({ api: 'openai', auth: 'bearer', baseUrl: 'https://api.aimlapi.com/v1', tokenParam: 'max_tokens' });
    expect(row.defaultModel).toBe('google/gemini-3.5-flash-lite');
    expect(suggestProvider('aiml')).toBe('aimlapi');
  });

  it('sends the key to https://api.aimlapi.com/v1/chat/completions and nowhere else', async () => {
    /** @type {Array<{ url: string; init: RequestInit }>} */
    const seen = [];
    stubFetch(seen, () => new Response(JSON.stringify({ choices: [{ message: { content: '# ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const text = await callProvider({ provider: 'aimlapi', model: 'google/gemini-3.5-flash-lite', apiKey: KEY, system: 's', prompt: 'p' });
    expect(text).toBe('# ok');
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0].url);
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('api.aimlapi.com');
    expect(url.pathname).toBe('/v1/chat/completions');
    const headers = new Headers(seen[0].init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    // The project adds no source or partner header for any provider, so this row does not either.
    expect([...headers.keys()].filter((name) => name.startsWith('x-'))).toEqual([]);
    const body = JSON.parse(String(seen[0].init.body));
    expect(body.model).toBe('google/gemini-3.5-flash-lite');
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('refuses a redirect off api.aimlapi.com, so the key never reaches the other host', async () => {
    /** @type {Array<{ url: string; init: RequestInit }>} */
    const seen = [];
    stubFetch(seen, () => new Response(null, { status: 307, headers: { location: 'https://api.aimlapi.com.evil.example/v1/chat/completions' } }));
    await expect(
      callProvider({ provider: 'aimlapi', model: 'google/gemini-3.5-flash-lite', apiKey: KEY, system: 's', prompt: 'p' }),
    ).rejects.toThrow(/redirect/i);
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].url).host).toBe('api.aimlapi.com');
    expect(seen[0].init.redirect).toBe('manual');
  });
});

describe('an AI/ML API key on hand', () => {
  /** @type {string[]} */
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** @param {string} env */
  function project(env) {
    // Nothing from the shell running the tests may decide the answer.
    for (const { envVars } of providerEnvVars()) for (const name of envVars) vi.stubEnv(name, undefined);
    for (const name of ['OPENGSO_API_KEY', 'OPENGSO_PROVIDER', 'OPENGSO_MODEL', 'OPENGSO_BASE_URL']) vi.stubEnv(name, undefined);
    const root = mkdtempSync(join(tmpdir(), 'opengso-aimlapi-'));
    roots.push(root);
    writeFileSync(join(root, '.env'), env);
    return root;
  }

  it('is picked up from AIMLAPI_API_KEY or AIML_API_KEY', () => {
    expect(providerEnvVars().find((entry) => entry.provider === 'aimlapi')?.envVars).toEqual(['AIMLAPI_API_KEY', 'AIML_API_KEY']);
    expect(readCredentials(project(`AIMLAPI_API_KEY=${KEY}\n`))).toMatchObject({ provider: 'aimlapi', apiKey: KEY });
    expect(readCredentials(project(`AIML_API_KEY=${KEY}\n`))).toMatchObject({ provider: 'aimlapi', apiKey: KEY });
  });

  it('never outranks a key for a provider that was there before it', () => {
    const root = project(`AIMLAPI_API_KEY=${KEY}\nOPENAI_API_KEY=sk-openai\nNOVITA_API_KEY=sk-novita\n`);
    expect(readCredentials(root)?.provider).toBe('openai');
    expect(readCredentials(root, { provider: 'novita' })?.provider).toBe('novita');
    expect(readCredentials(root, { provider: 'aimlapi' })?.provider).toBe('aimlapi');
  });
});
