import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateFrame, handleApi, readGeneratedFile, testFrame, type StateResponse } from '../src/server/api.js';
import { crossOriginDenial, resolveStaticPath, sseFrame } from '../src/server/server.js';
import { AI_BOTS } from '../src/shared/bots.js';
import { CONFIG_FILENAME, defaultConfig } from '../src/shared/config.js';
import { ENV_FILENAME, KEY_VAR } from '../src/shared/env.js';
import type { Evidence, TestResult } from '../src/test/index.js';

/**
 * The dashboard server is the only part of OpenGEO that listens on a socket, which makes it the
 * only part with an attack surface worth the name. Two properties are worth more than the rest of
 * this file put together, and both are asserted here rather than argued for in a comment:
 *
 *   1. A page on another origin cannot drive this API, because it can write an API key to disk.
 *   2. A path from a browser cannot escape the directory it is scoped to, in either handler.
 *
 * Everything else is a thin wrapper over functions their own tests already cover, so the API tests
 * check the wrapping, not the pipeline.
 */

const OPTIONS = { version: '0.0.0-test', packageName: 'opengeo' };
const KEY = 'sk-test-not-a-real-key';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opengeo-server-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function post(path: string, body: unknown) {
  return handleApi({ method: 'POST', path, body }, { ...OPTIONS, root });
}

function get(path: string) {
  return handleApi({ method: 'GET', path, body: undefined }, { ...OPTIONS, root });
}

describe('same-origin enforcement', () => {
  it('allows a request with no Origin at all, which is what curl and a same-origin fetch send', () => {
    expect(crossOriginDenial({ headers: { host: '127.0.0.1:4321' } })).toBeUndefined();
  });

  it('allows an Origin that matches the host being served', () => {
    expect(
      crossOriginDenial({ headers: { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321' } }),
    ).toBeUndefined();
  });

  it('refuses a page on any other origin, because that page could otherwise write an API key', () => {
    const denial = crossOriginDenial({ headers: { host: '127.0.0.1:4321', origin: 'https://evil.example' } });
    expect(denial).toMatch(/same-origin/);
  });

  it('refuses a different port on the same host, which is a different origin', () => {
    expect(crossOriginDenial({ headers: { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:9999' } })).toBeDefined();
  });

  it('refuses an unparseable Origin rather than guessing what was meant', () => {
    expect(crossOriginDenial({ headers: { host: '127.0.0.1:4321', origin: 'not a url' } })).toBeDefined();
  });
});

describe('static paths', () => {
  let webRoot: string;

  beforeEach(() => {
    webRoot = join(root, 'web');
    mkdirSync(join(webRoot, 'assets'), { recursive: true });
    writeFileSync(join(webRoot, 'index.html'), '<div id="root"></div>');
    writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(root, 'secret.txt'), 'do not serve me');
  });

  it('serves a file that exists', () => {
    expect(resolveStaticPath('/assets/app.js', webRoot)).toBe(join(webRoot, 'assets', 'app.js'));
  });

  it('refuses to climb out of the web root', () => {
    expect(resolveStaticPath('/../secret.txt', webRoot)).toBeUndefined();
    expect(resolveStaticPath('/assets/../../secret.txt', webRoot)).toBeUndefined();
  });

  it('refuses a percent-encoded climb, which is the version that gets past a naive check', () => {
    expect(resolveStaticPath('/%2e%2e/secret.txt', webRoot)).toBeUndefined();
  });

  it('falls through to index.html for an app route, but not for a missing asset', () => {
    expect(resolveStaticPath('/settings', webRoot)).toBe(join(webRoot, 'index.html'));
    expect(resolveStaticPath('/assets/missing.js', webRoot)).toBeUndefined();
  });
});

describe('the API', () => {
  it('reports state without a config file, using defaults', async () => {
    const response = await get('/api/state');
    expect(response.status).toBe(200);
    const state = response.body as StateResponse;
    expect(state.configExists).toBe(false);
    expect(state.config.site).toBe(defaultConfig().site);
    expect(state.key.present).toBe(false);
    expect(state.manifest).toBeUndefined();
  });

  it('serves the bot list the config UI is built from', async () => {
    const response = await get('/api/bots');
    expect((response.body as { bots: unknown[] }).bots).toHaveLength(AI_BOTS.length);
  });

  it('404s an endpoint that does not exist, naming what was asked for', async () => {
    const response = await get('/api/nope');
    expect(response.status).toBe(404);
    expect(String((response.body as { error: string }).error)).toContain('GET /api/nope');
  });

  it('writes a config patch and merges it into the defaults', async () => {
    const response = await post('/api/config', { site: 'http://localhost:5173' });
    expect(response.status).toBe(200);
    const written = JSON.parse(readFileSync(join(root, CONFIG_FILENAME), 'utf8'));
    expect(written.site).toBe('http://localhost:5173');
    // Untouched sections survive rather than being dropped by the patch.
    expect(written.bots.markdownRouting.length).toBeGreaterThan(0);
  });

  it('refuses a site that is not a URL instead of writing it', async () => {
    const response = await post('/api/config', { site: 'not-a-url' });
    expect(response.status).toBe(400);
    expect(existsSync(join(root, CONFIG_FILENAME))).toBe(false);
  });
});

/**
 * The dashboard's crawler table is where a project adds an agent OpenGEO has never heard of, so
 * everything on this path arrives as free text from a form. It is normalized rather than trusted,
 * and a patch that cannot be normalized is refused whole rather than half-written.
 */
describe('custom crawlers through the API', () => {
  const acme = { name: 'AcmeBot', vendor: 'Acme Inc', uaPatterns: ['acme-crawler'], kind: 'assistant' };

  it('shows a configured crawler beside the shipped ones, so the table is not quietly incomplete', async () => {
    await post('/api/config', { bots: { custom: [acme] } });
    const bots = (await get('/api/bots')).body as { bots: { name: string; custom?: boolean }[] };
    expect(bots.bots).toHaveLength(AI_BOTS.length + 1);
    expect(bots.bots.at(-1)).toMatchObject({ name: 'AcmeBot', custom: true });
  });

  it('fills in the fields the form left blank rather than storing them empty', async () => {
    await post('/api/config', { bots: { custom: [{ name: '  AcmeBot  ' }] } });
    const written = JSON.parse(readFileSync(join(root, CONFIG_FILENAME), 'utf8'));
    expect(written.bots.custom[0]).toMatchObject({
      name: 'AcmeBot',
      vendor: 'Custom',
      uaPatterns: ['acmebot'],
      robotsToken: 'AcmeBot',
      kind: 'assistant',
    });
  });

  it('refuses a nameless crawler, a duplicate, and a name a shipped crawler already owns', async () => {
    expect((await post('/api/config', { bots: { custom: [{ name: '   ' }] } })).status).toBe(400);
    expect((await post('/api/config', { bots: { custom: [acme, { name: 'acmebot' }] } })).status).toBe(400);

    const clash = await post('/api/config', { bots: { custom: [{ name: 'GPTBot' }] } });
    expect(clash.status).toBe(400);
    expect(String((clash.body as { error: string }).error)).toContain('already one of the crawlers');

    expect((await post('/api/config', { bots: { custom: 'AcmeBot' } })).status).toBe(400);
    // Refused whole: nothing on the path wrote a partial config on the way to the error.
    expect(existsSync(join(root, CONFIG_FILENAME))).toBe(false);
  });

  it('removes a crawler when the list comes back without it', async () => {
    await post('/api/config', { bots: { custom: [acme] } });
    await post('/api/config', { bots: { custom: [] } });
    const written = JSON.parse(readFileSync(join(root, CONFIG_FILENAME), 'utf8'));
    expect(written.bots.custom).toEqual([]);
  });
});

describe('the key never leaks through the API (§11)', () => {
  it('gitignores .env before writing the key, and says where it went without echoing it', async () => {
    const response = await post('/api/key', { provider: 'anthropic', apiKey: KEY, model: 'claude-test' });
    expect(response.status).toBe(200);

    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.env');
    expect(readFileSync(join(root, ENV_FILENAME), 'utf8')).toContain(`${KEY_VAR}=${KEY}`);
    expect(JSON.stringify(response.body)).not.toContain(KEY);
  });

  /**
   * The ordering assertion. `.gitignore` is a directory here, so ensuring it throws - and if the
   * key were written first, `.env` would exist anyway. It must not.
   */
  it('writes no key at all when the gitignore step fails', async () => {
    mkdirSync(join(root, '.gitignore'));
    await expect(post('/api/key', { provider: 'anthropic', apiKey: KEY })).rejects.toThrow();
    expect(existsSync(join(root, ENV_FILENAME))).toBe(false);
  });

  it('never writes the key into the config file', async () => {
    await post('/api/key', { provider: 'anthropic', apiKey: KEY, model: 'claude-test' });
    const config = readFileSync(join(root, CONFIG_FILENAME), 'utf8');
    expect(config).not.toContain(KEY);
    expect(JSON.parse(config).ai).toEqual({ provider: 'anthropic', model: 'claude-test' });
  });

  it('never returns the key from state, only that one exists', async () => {
    await post('/api/key', { provider: 'anthropic', apiKey: KEY });
    const state = (await get('/api/state')).body as StateResponse;
    expect(state.key.present).toBe(true);
    expect(state.key.provider).toBe('anthropic');
    expect(JSON.stringify(state)).not.toContain(KEY);
  });

  it('rejects an unknown provider and an empty key without touching the disk', async () => {
    expect((await post('/api/key', { provider: 'sqlite', apiKey: KEY })).status).toBe(400);
    expect((await post('/api/key', { provider: 'anthropic', apiKey: '  ' })).status).toBe(400);
    expect(existsSync(join(root, ENV_FILENAME))).toBe(false);
  });
});

describe('reading generated files', () => {
  beforeEach(() => {
    mkdirSync(join(root, 'public', 'md'), { recursive: true });
    writeFileSync(join(root, 'public', 'md', 'index.md'), '# Hello');
    writeFileSync(join(root, 'private.txt'), 'not public');
    writeFileSync(join(root, CONFIG_FILENAME), JSON.stringify(defaultConfig()));
  });

  it('reads a file inside the public directory', async () => {
    const response = await post('/api/file', { path: 'md/index.md' });
    expect((response.body as { content: string }).content).toBe('# Hello');
  });

  it('refuses a path that escapes the public directory', () => {
    expect(readGeneratedFile(root, '../private.txt')).toBeUndefined();
    expect(readGeneratedFile(root, '../../etc/passwd')).toBeUndefined();
  });

  it('404s a file that has not been generated', async () => {
    expect((await post('/api/file', { path: 'md/nothing.md' })).status).toBe(404);
  });
});

/**
 * Streaming, for the two endpoints that can run for minutes.
 *
 * Three properties, and the middle one is the reason this exists as its own layer rather than as a
 * second copy of the handlers:
 *
 *   1. `/api/test/stream` and `/api/test` reach the same code, so there is one implementation.
 *   2. A progress frame carries what a browser can use and nothing it cannot. `structure-done`
 *      arrives holding the whole `TestResult`, evidence included, which is every byte of every
 *      document the probe fetched and a `URL` that does not survive `JSON.stringify`.
 *   3. A frame ends with a blank line, which is the only thing that tells a client it is complete.
 */
describe('the streaming endpoints', () => {
  it('sends a test run down the same handler as the plain path', async () => {
    // A 404 would mean the route was never wired, and the browser would be told the endpoint does
    // not exist rather than that the URL it typed is not a URL.
    const response = await post('/api/test/stream', { url: 'not-a-url' });
    expect(response.status).toBe(400);
    expect(String((response.body as { error: string }).error)).not.toContain('No such endpoint');
  });

  it('sends a generate run down the same handler as the plain path', async () => {
    const response = await post('/api/generate/stream', { url: 'not-a-url' });
    expect(response.status).toBe(400);
    expect(String((response.body as { error: string }).error)).not.toContain('No such endpoint');
  });

  it('formats one frame as an event line, a data line and the blank line that ends it', () => {
    expect(sseFrame('progress', { phase: 'discover' })).toBe('event: progress\ndata: {"phase":"discover"}\n\n');
  });

  it('ends every frame with the blank line, whatever is in it', () => {
    expect(sseFrame('done', { status: 200, body: null }).endsWith('\n\n')).toBe(true);
  });

  it('keeps the evidence out of a structure-done frame', () => {
    const frame = testFrame({ phase: 'structure-done', result: structuralResult() });
    const wire = JSON.stringify(frame);
    expect(wire).not.toContain('<html>');
    expect(wire).not.toContain('user-agent');
  });

  it('sends the four fields the dashboard reads at the top level of a finished run', () => {
    const frame = testFrame({ phase: 'structure-done', result: structuralResult() });
    expect(frame).toEqual({
      phase: 'structure-done',
      structure: {
        url: 'https://example.com/resume',
        twinUrl: 'https://example.com/resume.md',
        framework: undefined,
        score: structuralResult().score,
        checks: [],
      },
    });
  });

  it('survives the round trip it is about to be put through', () => {
    const wire = JSON.stringify(testFrame({ phase: 'structure-done', result: structuralResult() }));
    // A URL instance stringifies to `{}` rather than throwing, which is the failure that would go
    // unnoticed: the frame would arrive, and the field inside it would be an empty object.
    expect(wire).toContain('"twinUrl":"https://example.com/resume.md"');
    expect(JSON.parse(wire).structure.score.locked.points).toBe(46);
  });

  it('passes a review phase through as it is, since there is nothing in it a browser cannot read', () => {
    const event = { phase: 'review', done: 2, total: 5, url: 'https://example.com/a.md' } as const;
    expect(testFrame(event)).toEqual(event);
  });

  it('flattens a crawl event, so a client switches on one field instead of two', () => {
    expect(generateFrame({ phase: 'crawl', crawl: { route: '/a', depth: 1, found: 4, visited: 2 } })).toEqual({
      phase: 'crawl',
      route: '/a',
      depth: 1,
      found: 4,
      visited: 2,
    });
  });

  it('renames generate\'s own phase to step, so the outer discriminant is not shadowed', () => {
    expect(
      generateFrame({ phase: 'generate', generate: { route: '/a', index: 2, total: 5, phase: 'ai' } }),
    ).toEqual({ phase: 'generate', step: 'ai', route: '/a', index: 2, total: 5 });
  });

  it('carries the files phase across with nothing attached to it', () => {
    expect(generateFrame({ phase: 'files' })).toEqual({ phase: 'files' });
  });
});

/**
 * A finished structural run, with the evidence filled in only far enough to be recognisable in a
 * frame that should not contain it. The checks are empty because none of these tests score
 * anything: what is under test is which fields cross the wire.
 */
function structuralResult(): TestResult {
  const evidence = {
    target: new URL('https://example.com/resume'),
    origin: 'https://example.com',
    html: { body: '<html>a page</html>', headers: new Headers({ 'user-agent': 'probe' }) },
  } as unknown as Evidence;
  return {
    url: 'https://example.com/resume',
    twinUrl: 'https://example.com/resume.md',
    checks: [],
    score: {
      value: 78,
      earned: 52,
      possible: 67,
      counts: { pass: 5, partial: 3, fail: 1, locked: 12, na: 1 },
      lost: [{ id: 'B1', points: 10 }],
      locked: { count: 12, points: 46, unlockedBy: ['B1'] },
    },
    evidence,
  };
}
