import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '../src/server/server.js';
/** @import { Server } from 'node:http' */
/** @import { RunningServer } from '../src/server/server.js' */

/**
 * The parts of the dashboard server's wire contract that `server-http.test.js` and `server.test.js`
 * leave out: what a refusal looks like (its type and its headers, not only its status), the full
 * table of static content types, a traversal that `fetch` would have normalised away before it was
 * sent, a token that has to survive a redirect without dragging the rest of the query with it, and
 * a generate run streamed from its first frame to its last.
 */

const OPTIONS = { version: '0.0.0-test', packageName: 'omnigeo' };

/** @type {string} */
let root;
/** @type {string} */
let webRoot;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omnigeo-wire-'));
  webRoot = join(root, 'web');
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>dash</title>');
  writeFileSync(join(root, 'secret.txt'), 'not for the browser');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * @typedef {{ status: number; headers: Record<string, string | string[] | undefined>; body: string }} RawResponse
 */

/**
 * A request with every header chosen by the caller, Host included, which `fetch` will not allow.
 *
 * @param {number} port
 * @param {{ method?: string; path: string; headers: Record<string, string>; body?: string }} init
 * @returns {Promise<RawResponse>}
 */
function raw(port, init) {
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, method: init.method ?? 'GET', path: init.path, headers: init.headers, setHost: false },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolveResponse({ status: response.statusCode ?? 0, headers: response.headers, body }));
      },
    );
    request.on('error', rejectResponse);
    request.end(init.body);
  });
}

/**
 * The request line exactly as written, for paths an HTTP client would clean up first.
 *
 * @param {number} port
 * @param {string} target
 * @returns {Promise<{ status: string; body: string }>}
 */
function rawLine(port, target) {
  return new Promise((resolveLine, rejectLine) => {
    const socket = connect(port, '127.0.0.1', () =>
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`),
    );
    let received = '';
    socket.on('data', (chunk) => (received += chunk));
    socket.on('end', () => {
      const [head, ...rest] = received.split('\r\n\r\n');
      resolveLine({ status: head.split('\r\n')[0], body: rest.join('\r\n\r\n') });
    });
    socket.on('error', rejectLine);
  });
}

/** @param {RawResponse} response */
function expectHardened(response) {
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['x-frame-options']).toBe('DENY');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
}

describe('a refusal, on a loopback launch', () => {
  /** @type {RunningServer} */
  let running;
  /** @type {Record<string, string>} */
  let host;

  beforeEach(async () => {
    running = await startServer({ ...OPTIONS, root, port: 0, webRoot });
    host = { host: `127.0.0.1:${running.port}` };
  });

  afterEach(async () => {
    await running.close();
  });

  it('refuses a foreign Host in JSON on the API and in plain text on a page', async () => {
    const forged = { host: `evil.example:${running.port}` };
    const api = await raw(running.port, { path: '/api/state', headers: forged });
    expect(api.status).toBe(403);
    expect(api.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(api.body).error).toContain('evil.example');

    const page = await raw(running.port, { path: '/', headers: forged });
    expect(page.status).toBe(403);
    expect(page.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(page.body).not.toContain('<title>dash</title>');
  });

  it('refuses a cross-origin read as well as a write, and lets a same-origin one through', async () => {
    const foreign = await raw(running.port, { path: '/api/state', headers: { ...host, origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body).error).toContain('evil.example');

    const sameOrigin = await raw(running.port, {
      path: '/api/state',
      headers: { ...host, origin: `http://127.0.0.1:${running.port}` },
    });
    expect(sameOrigin.status).toBe(200);
  });

  it('refuses a cross-origin stream before running anything', async () => {
    const response = await raw(running.port, {
      method: 'POST',
      path: '/api/generate/stream',
      headers: { ...host, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1/' }),
    });
    expect(response.status).toBe(403);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(existsSync(join(root, '.omnigeo'))).toBe(false);
  });

  it('refuses a JSON body that does not parse, and treats an empty one as no body', async () => {
    const broken = await raw(running.port, {
      method: 'POST',
      path: '/api/config',
      headers: { ...host, 'content-type': 'application/json' },
      body: '{"site": "http://localhost:4000",',
    });
    expect(broken.status).toBe(400);
    expect(JSON.parse(broken.body).error).toContain('not valid JSON');
    expect(existsSync(join(root, 'omnigeo.config.json'))).toBe(false);

    // An empty body reaches the handler as no body, so it is the missing URL that is refused.
    const empty = await raw(running.port, {
      method: 'POST',
      path: '/api/preview',
      headers: { ...host, 'content-type': 'application/json' },
      body: '',
    });
    expect(empty.status).toBe(400);
    expect(JSON.parse(empty.body).error).not.toContain('not valid JSON');
  });

  it('sends the hardening headers on every refusal, not only on the happy path', async () => {
    const refusals = {
      host: await raw(running.port, { path: '/api/state', headers: { host: `evil.example:${running.port}` } }),
      origin: await raw(running.port, { path: '/api/state', headers: { ...host, origin: 'https://evil.example' } }),
      notJson: await raw(running.port, {
        method: 'POST',
        path: '/api/config',
        headers: { ...host, 'content-type': 'text/plain' },
        body: '{}',
      }),
      badJson: await raw(running.port, {
        method: 'POST',
        path: '/api/config',
        headers: { ...host, 'content-type': 'application/json' },
        body: '{',
      }),
      method: await raw(running.port, { method: 'DELETE', path: '/', headers: host }),
    };
    expect(Object.values(refusals).map((response) => response.status)).toEqual([403, 403, 415, 400, 405]);
    for (const response of Object.values(refusals)) expectHardened(response);
  });
});

describe('a refusal, on a token-gated launch', () => {
  /** @type {RunningServer} */
  let running;
  /** @type {Record<string, string>} */
  let host;

  beforeEach(async () => {
    running = await startServer({ ...OPTIONS, root, port: 0, webRoot, token: 'launch-token' });
    host = { host: `127.0.0.1:${running.port}` };
  });

  afterEach(async () => {
    await running.close();
  });

  it('answers a missing token in JSON on the API and in plain text on a page, hardened both ways', async () => {
    const api = await raw(running.port, { path: '/api/state', headers: host });
    expect(api.status).toBe(401);
    expect(api.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(api.body).error).toBeTruthy();
    expectHardened(api);

    const page = await raw(running.port, { path: '/', headers: host });
    expect(page.status).toBe(401);
    expect(page.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(page.body).not.toContain('<title>dash</title>');
    expectHardened(page);
  });

  it('never echoes the token in a refusal', async () => {
    const wrong = await raw(running.port, { path: '/api/state?token=launch-tokeX', headers: host });
    expect(wrong.status).toBe(401);
    expect(wrong.body).not.toContain('launch-tok');
  });

  it('strips only the token from the redirect, keeping the path and the rest of the query', async () => {
    const exchange = await raw(running.port, { path: '/settings?tab=bots&token=launch-token', headers: host });
    expect(exchange.status).toBe(303);
    expect(exchange.headers.location).toBe('/settings?tab=bots');
    expect(String(exchange.headers['set-cookie'])).toContain(`omnigeo_token_${running.port}=launch-token`);
    expectHardened(exchange);
  });

  it('still checks the Host before the token, so a rebound page holding the token is refused', async () => {
    const response = await raw(running.port, {
      path: '/api/state',
      headers: { host: `evil.example:${running.port}`, authorization: 'Bearer launch-token' },
    });
    expect(response.status).toBe(403);
  });

  it('opens a stream for a bearer token, and refuses one without it', async () => {
    const body = JSON.stringify({ url: 'not-a-url' });
    const refused = await raw(running.port, {
      method: 'POST',
      path: '/api/test/stream',
      headers: { ...host, 'content-type': 'application/json' },
      body,
    });
    expect(refused.status).toBe(401);

    const allowed = await raw(running.port, {
      method: 'POST',
      path: '/api/test/stream',
      headers: { ...host, 'content-type': 'application/json', authorization: 'Bearer launch-token' },
      body,
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(allowed.body).toContain('event: done');
  });
});

describe('static serving, type by type', () => {
  /** @type {RunningServer} */
  let running;

  beforeEach(async () => {
    const files = {
      'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'data.json': '{}',
      'app.js.map': '{}',
      'favicon.ico': 'ico',
      'logo.png': 'png',
      'font.woff2': 'woff2',
      'UPPER.JS': 'export {};',
      'notes.xyz': 'unknown',
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(webRoot, name), content);
    running = await startServer({ ...OPTIONS, root, port: 0, webRoot });
  });

  afterEach(async () => {
    await running.close();
  });

  it('sends each asset with the type a browser needs, and an unknown one as opaque bytes', async () => {
    const expected = {
      '/icon.svg': 'image/svg+xml',
      '/data.json': 'application/json; charset=utf-8',
      '/app.js.map': 'application/json; charset=utf-8',
      '/favicon.ico': 'image/x-icon',
      '/logo.png': 'image/png',
      '/font.woff2': 'font/woff2',
      '/UPPER.JS': 'text/javascript; charset=utf-8',
      '/notes.xyz': 'application/octet-stream',
    };
    for (const [path, type] of Object.entries(expected)) {
      const response = await fetch(`${running.url}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toBe(type);
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff');
      await response.arrayBuffer();
    }
  });

  it('refuses a literal climb that only a raw socket can send', async () => {
    for (const target of ['/../secret.txt', '/../../secret.txt', '/..%5csecret.txt', '/.%2e/secret.txt', '/web/../../secret.txt']) {
      const response = await rawLine(running.port, target);
      expect(response.body, target).not.toContain('not for the browser');
      expect(response.status, target).toBe('HTTP/1.1 404 Not Found');
    }
  });

  it('answers a path that does not decode with a 404, not a crash', async () => {
    const response = await rawLine(running.port, '/%E0%A4%A');
    expect(response.status).toBe('HTTP/1.1 404 Not Found');
    // The server is still answering afterwards.
    expect((await fetch(`${running.url}/`)).status).toBe(200);
  });
});

/**
 * Splits a finished stream into comments and `{ event, data }` frames, in order.
 *
 * @param {string} text
 * @returns {Array<string | { event: string; data: any }>}
 */
function framesOf(text) {
  expect(text.endsWith('\n\n')).toBe(true);
  return text
    .slice(0, -2)
    .split('\n\n')
    .map((block) => {
      if (block.startsWith(':')) return block;
      const [eventLine, dataLine, ...rest] = block.split('\n');
      expect(rest).toEqual([]);
      return { event: eventLine.replace(/^event: /, ''), data: JSON.parse(dataLine.replace(/^data: /, '')) };
    });
}

describe('a streamed generate run, frame by frame', () => {
  /** @type {Server} */
  let site;
  /** @type {string} */
  let siteUrl;
  /** @type {RunningServer} */
  let running;

  beforeEach(async () => {
    site = createServer((request, response) => {
      const pages = /** @type {Record<string, string>} */ ({
        '/': '<a href="/about">About</a>',
        '/about': '<a href="/">Home</a>',
      });
      const links = pages[request.url ?? ''];
      if (links === undefined) {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('nope');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        `<!doctype html><html lang="en"><head><title>Page ${request.url}</title></head><body><main><h1>Page</h1><p>Enough words to make this a page worth a twin.</p>${links}</main></body></html>`,
      );
    });
    await new Promise((resolveListen) => site.listen(0, '127.0.0.1', () => resolveListen(undefined)));
    const address = site.address();
    siteUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
    running = await startServer({ ...OPTIONS, root, port: 0, webRoot });
  });

  afterEach(async () => {
    await running.close();
    await new Promise((resolveClose) => site.close(() => resolveClose(undefined)));
  });

  it('crawls, then generates page by page, then writes the site files, then ends on one done', async () => {
    const response = await fetch(`${running.url}/api/generate/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: siteUrl, tier: 'free' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const frames = framesOf(await response.text());
    expect(frames[0]).toBe(': open');
    const events = /** @type {Array<{ event: string; data: any }>} */ (frames.filter((frame) => typeof frame !== 'string'));
    const done = events.at(-1);
    expect(done?.event).toBe('done');
    expect(events.filter((frame) => frame.event === 'done')).toHaveLength(1);
    const progress = events.slice(0, -1);
    expect(progress.every((frame) => frame.event === 'progress')).toBe(true);

    // Phases arrive in blocks and never go back: all of the crawl, then the pages, then the files.
    const phases = progress.map((frame) => frame.data.phase);
    const blocks = phases.filter((phase, index) => phase !== phases[index - 1]);
    expect(blocks).toEqual(['crawl', 'generate', 'files']);

    // Flattened for the browser: a crawl frame has its fields at the top, a generate frame says its
    // own step under `step` so it does not shadow `phase`.
    const crawl = progress.find((frame) => frame.data.phase === 'crawl')?.data;
    expect(crawl).toMatchObject({ route: expect.any(String), visited: expect.any(Number) });
    expect(crawl).not.toHaveProperty('crawl');
    const steps = progress.filter((frame) => frame.data.phase === 'generate').map((frame) => frame.data.step);
    expect(steps).toContain('write');
    expect(steps.indexOf('fetch')).toBeLessThan(steps.indexOf('write'));

    expect(done?.data.status).toBe(200);
    expect(done?.data.body.pages.map((/** @type {{ route: string }} */ page) => page.route).sort()).toEqual(['/', '/about']);
    expect(existsSync(join(root, '.omnigeo', 'manifest.json'))).toBe(true);
  });
});
