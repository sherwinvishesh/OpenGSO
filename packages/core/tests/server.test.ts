import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateFrame, handleApi, readGeneratedFile, testFrame, type StateResponse } from '../src/server/api.js';
import {
  crossOriginDenial,
  hostDenial,
  resolveStaticPath,
  sseFrame,
  startServer,
  type RunningServer,
} from '../src/server/server.js';
import { AI_BOTS } from '../src/shared/bots.js';
import { CONFIG_FILENAME, defaultConfig, loadConfig } from '../src/shared/config.js';
import { ENV_FILENAME, KEY_VAR, readCredentials } from '../src/shared/env.js';
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

/** A raw request, because `fetch` will not let a caller choose the Host header. */
function rawRequest(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolveStatus, rejectStatus) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers, setHost: false }, (response) => {
      response.resume();
      resolveStatus(response.statusCode ?? 0);
    });
    request.on('error', rejectStatus);
    request.end();
  });
}

describe('the Host gate, against DNS rebinding', () => {
  let running: RunningServer;
  let port: number;

  beforeEach(async () => {
    const webRoot = join(root, 'web');
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>dash</title>');
    running = await startServer({ ...OPTIONS, root, port: 0, webRoot });
    port = running.port;
  });

  afterEach(async () => {
    await running.close();
  });

  it('answers the loopback names it is actually reachable by', async () => {
    expect(await rawRequest(port, '/api/state', { host: `127.0.0.1:${port}` })).toBe(200);
    expect(await rawRequest(port, '/api/state', { host: `localhost:${port}` })).toBe(200);
    expect(await rawRequest(port, '/', { host: `localhost:${port}` })).toBe(200);
  });

  it('refuses a rebound name even when the Origin agrees with it, which is the whole attack', async () => {
    const forged = { host: `evil.example:${port}`, origin: `http://evil.example:${port}` };
    expect(await rawRequest(port, '/api/state', forged)).toBe(403);
    expect(await rawRequest(port, '/api/key', forged)).toBe(403);
    expect(await rawRequest(port, '/', forged)).toBe(403);
  });

  it('refuses the right name on the wrong port, a missing Host and one that does not parse', async () => {
    expect(await rawRequest(port, '/api/state', { host: `127.0.0.1:${port + 1}` })).toBe(403);
    expect(await rawRequest(port, '/api/state', { host: '[' })).toBe(403);
    // Node's own parser answers this one with a 400 before the handler runs. Refused either way.
    expect(await rawRequest(port, '/api/state', {})).toBe(400);
    expect(hostDenial(undefined, { host: '127.0.0.1', port })).toBeDefined();
  });
});

describe('the Host gate, as a function', () => {
  it('accepts an explicit --host name and refuses a wildcard bind as a name', () => {
    expect(hostDenial('my-laptop.local:4321', { host: 'my-laptop.local', port: 4321 })).toBeUndefined();
    expect(hostDenial('[::1]:4321', { host: '127.0.0.1', port: 4321 })).toBeUndefined();
    expect(hostDenial('0.0.0.0:4321', { host: '0.0.0.0', port: 4321 })).toBeDefined();
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

  /**
   * The key form validates the endpoint and saves it together with the key. The config endpoint
   * validated neither, so one POST could point a stored key at any host and the next AI run would
   * send it there. Even a bare provider change re-routes a generic OPENGEO_API_KEY to a new vendor.
   */
  it('refuses any AI provider change through the config endpoint, leaving the config untouched', async () => {
    await post('/api/key', { provider: 'anthropic', apiKey: KEY, model: 'claude-test' });
    const before = readFileSync(join(root, CONFIG_FILENAME), 'utf8');
    for (const ai of [
      { baseUrl: 'https://evil.example/v1' },
      { headers: { 'x-tenant': 'evil' } },
      { api: 'openai' },
      { auth: 'bearer' },
      { provider: 'openai' },
      { model: 'something-else' },
    ]) {
      const response = await post('/api/config', { ai });
      expect(response.status, JSON.stringify(ai)).toBe(400);
      expect(JSON.stringify(response.body)).toContain('/api/key');
    }
    expect(readFileSync(join(root, CONFIG_FILENAME), 'utf8')).toBe(before);
  });

  /**
   * `.env` outranks the config, so an OPENGEO_BASE_URL left over from a gateway sent the next
   * provider's key to the gateway. Saving without a base URL has to mean "no base URL", everywhere.
   */
  it('forgets the old endpoint when a key is saved without one', async () => {
    await post('/api/key', { provider: 'custom', apiKey: 'sk-gateway', model: 'm', baseUrl: 'https://gateway.example/v1' });
    await post('/api/key', { provider: 'openai', apiKey: KEY, model: 'gpt-test' });
    expect(readFileSync(join(root, ENV_FILENAME), 'utf8')).not.toContain('gateway.example');
    expect(readCredentials(root)?.baseUrl).toBeUndefined();

    await post('/api/key', { provider: 'openai', apiKey: KEY, model: 'gpt-test', baseUrl: 'https://proxy.example/v1' });
    await post('/api/key', { provider: 'openai', apiKey: KEY, model: 'gpt-test' });
    expect(readFileSync(join(root, ENV_FILENAME), 'utf8')).not.toContain('proxy.example');
    expect(JSON.parse(readFileSync(join(root, CONFIG_FILENAME), 'utf8')).ai.baseUrl).toBeUndefined();
  });

  it('refuses a model or key with a line break before touching .gitignore or .env', async () => {
    for (const body of [
      { provider: 'anthropic', apiKey: KEY, model: 'claude\nOPENGEO_BASE_URL=https://evil.example' },
      { provider: 'anthropic', apiKey: `${KEY}\rINJECTED=1` },
    ]) {
      const response = await post('/api/key', body);
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain(KEY);
    }
    expect(existsSync(join(root, ENV_FILENAME))).toBe(false);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
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

  it('reads only what generate writes, never another file that happens to sit in the web root', async () => {
    writeFileSync(join(root, 'public', 'robots.txt'), 'User-agent: *');
    writeFileSync(join(root, 'public', 'robots.txt.opengeo-proposed'), 'User-agent: GPTBot');
    writeFileSync(join(root, 'public', '.env'), `KEY=${KEY}`);
    writeFileSync(join(root, 'public', 'secrets.json'), '{}');
    mkdirSync(join(root, 'public', 'md', '.hidden'));
    writeFileSync(join(root, 'public', 'md', '.hidden', 'x.md'), 'x');

    expect(readGeneratedFile(root, 'robots.txt')).toBe('User-agent: *');
    expect(readGeneratedFile(root, 'robots.txt.opengeo-proposed')).toBe('User-agent: GPTBot');
    expect(readGeneratedFile(root, '.env')).toBeUndefined();
    expect(readGeneratedFile(root, 'secrets.json')).toBeUndefined();
    expect(readGeneratedFile(root, 'md/.hidden/x.md')).toBeUndefined();
  });
});

describe('the web root and the internal directory stay inside the project', () => {
  it('refuses a patch that points either one at the project root, above it, or anywhere absolute', async () => {
    for (const patch of [
      { publicDir: '.' },
      { publicDir: '' },
      { publicDir: '/etc' },
      { publicDir: '../sibling' },
      { internalDir: '..' },
      { internalDir: '/tmp/opengeo' },
    ]) {
      const response = await post('/api/config', patch);
      expect(response.status, JSON.stringify(patch)).toBe(400);
    }
    expect(existsSync(join(root, CONFIG_FILENAME))).toBe(false);
  });

  it('still accepts a nested web root', async () => {
    expect((await post('/api/config', { publicDir: 'apps/web/public' })).status).toBe(200);
  });

  it('closes the reported leak: the API key cannot be read back through /api/file', async () => {
    writeFileSync(join(root, ENV_FILENAME), `${KEY_VAR}=${KEY}\n`);
    await post('/api/config', { publicDir: '.' });
    const response = await post('/api/file', { path: ENV_FILENAME });
    expect(JSON.stringify(response.body)).not.toContain(KEY);
  });

  it('refuses a hand-edited config that escapes, so the CLI and prod are covered too', () => {
    writeFileSync(join(root, CONFIG_FILENAME), JSON.stringify({ publicDir: '/etc' }));
    expect(() => loadConfig(root)).toThrow(/publicDir/);
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
