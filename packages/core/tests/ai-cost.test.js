import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '@opengeo/core/shared';
import { callProvider, createAiEnhancer, generatePages, TruncatedOutputError } from '@opengeo/core/generate';
/** @import { Server } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */
/** @import { LoadedConfig, ProviderApi } from '@opengeo/core/shared' */
/** @import { EnhanceInput, EnhanceOutput, ProviderCall } from '@opengeo/core/generate' */

/**
 * Every AI call costs the user money, so a call whose answer cannot be used must not be repeated
 * on the next run, and a call that can only produce a cut-off answer must not be made at all.
 * Provider calls are injected or answered by a loopback server: nothing here reaches a real API.
 */

/** @type {Server} */
let site;
/** @type {string} */
let siteUrl;

const PAGE =
  '<!doctype html><html><head><title>Resume</title></head><body><main><h1>Resume</h1><p>Shipped 4 projects in 2024. Contract signed 3 March 2024 for $12,500.</p></main></body></html>';

beforeAll(async () => {
  site = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
  await /** @type {Promise<void>} */ (new Promise((resolve) => site.listen(0, '127.0.0.1', resolve)));
  siteUrl = `http://127.0.0.1:${/** @type {AddressInfo} */ (site.address()).port}`;
});

afterAll(async () => {
  await /** @type {Promise<void>} */ (new Promise((resolve) => site.close(() => resolve())));
});

/** @returns {LoadedConfig} */
function project() {
  return { config: defaultConfig(siteUrl), root: mkdtempSync(join(tmpdir(), 'opengeo-cost-')), exists: true };
}

/**
 * @param {Omit<EnhanceOutput, 'markdown'>} output
 * @returns {{ calls: () => number; enhance: (input: EnhanceInput) => Promise<EnhanceOutput> }}
 */
function countingEnhancer(output) {
  let calls = 0;
  return {
    calls: () => calls,
    enhance: async (input) => {
      calls += 1;
      return { markdown: input.algorithmicMarkdown, ...output };
    },
  };
}

describe('a page whose AI rewrite was rejected', () => {
  it('is not sent to the model again while its content is unchanged', async () => {
    const loaded = project();
    const model = countingEnhancer({ warnings: ['Kept the algorithmic version'], fellBack: true, fallback: 'fidelity' });
    const first = await generatePages({ site: siteUrl, routes: ['/'], loaded, tier: 'ai', enhance: model.enhance });
    expect(first.pages[0]?.tier).toBe('free');
    expect(first.manifest.pages['/']?.aiFallback).toBe('fidelity');

    const second = await generatePages({ site: siteUrl, routes: ['/'], loaded, tier: 'ai', enhance: model.enhance });
    expect(second.pages[0]?.status).toBe('cached');
    expect(model.calls()).toBe(1);
    expect(second.manifest.pages['/']?.aiFallback).toBe('fidelity');
  });

  it('is tried again after a provider error, which costs nothing to retry', async () => {
    const loaded = project();
    const model = countingEnhancer({ warnings: ['AI tier unavailable'], fellBack: true, fallback: 'unavailable' });
    await generatePages({ site: siteUrl, routes: ['/'], loaded, tier: 'ai', enhance: model.enhance });
    await generatePages({ site: siteUrl, routes: ['/'], loaded, tier: 'ai', enhance: model.enhance });
    expect(model.calls()).toBe(2);
  });

  it('is retried when the user forces it', async () => {
    const loaded = project();
    const model = countingEnhancer({ warnings: [], fellBack: true, fallback: 'fidelity' });
    await generatePages({ site: siteUrl, routes: ['/'], loaded, tier: 'ai', enhance: model.enhance });
    await generatePages({ site: siteUrl, routes: ['/'], loaded, tier: 'ai', force: true, enhance: model.enhance });
    expect(model.calls()).toBe(2);
  });
});

describe('the AI enhancer', () => {
  const SOURCE = '# Resume\n\nShipped 4 projects in 2024. Contract signed 3 March 2024 for $12,500.';
  /** @type {EnhanceInput} */
  const input = { url: 'https://example.com/resume', title: 'Resume', html: '', algorithmicMarkdown: SOURCE };

  it('keeps the algorithmic version when the model stopped at its output cap', async () => {
    const enhance = createAiEnhancer({
      provider: 'anthropic',
      apiKey: 'k',
      env: {},
      call: async () => {
        throw new TruncatedOutputError('Anthropic');
      },
    });
    const result = await enhance(input);
    expect(result.fellBack).toBe(true);
    expect(result.fallback).toBe('truncated');
    expect(result.markdown).toBe(SOURCE);
  });

  it('does not pay for a page that cannot fit in the output cap', async () => {
    let calls = 0;
    const enhance = createAiEnhancer({
      provider: 'anthropic',
      apiKey: 'k',
      env: {},
      maxTokens: 100,
      call: async () => {
        calls += 1;
        return SOURCE;
      },
    });
    const long = `${SOURCE}\n\n${'word '.repeat(400)}`;
    const result = await enhance({ ...input, algorithmicMarkdown: long });
    expect(calls).toBe(0);
    expect(result.fellBack).toBe(true);
    expect(result.fallback).toBe('too-long');
    expect(result.markdown).toBe(long);
  });
});

describe('a provider answer cut off at the output cap', () => {
  /** @type {Record<ProviderApi, object>} */
  const CUT_OFF = {
    anthropic: { content: [{ type: 'text', text: '# Resume\n\nShipped 4' }], stop_reason: 'max_tokens' },
    openai: { choices: [{ message: { content: '# Resume\n\nShipped 4' }, finish_reason: 'length' }] },
    gemini: { candidates: [{ content: { parts: [{ text: '# Resume\n\nShipped 4' }] }, finishReason: 'MAX_TOKENS' }] },
  };

  for (const api of /** @type {ProviderApi[]} */ (['anthropic', 'openai', 'gemini'])) {
    it(`is refused rather than accepted, on the ${api} wire format`, async () => {
      const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(CUT_OFF[api])));
      await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
      const base = `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`;
      try {
        /** @type {ProviderCall} */
        const call = { provider: 'custom', model: 'm', apiKey: '', system: 's', prompt: 'p', overrides: { baseUrl: base, api, auth: 'none' } };
        await expect(callProvider(call)).rejects.toBeInstanceOf(TruncatedOutputError);
      } finally {
        await /** @type {Promise<void>} */ (new Promise((resolve) => server.close(() => resolve())));
      }
    });
  }
});
