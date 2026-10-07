import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '../src/server/server.js';
/** @import { Server } from 'node:http' */
/** @import { RunningServer } from '../src/server/server.js' */

/**
 * The dashboard server over a real socket, request by request, the way a browser meets it.
 *
 * `server.test.js` covers the gates and the handlers as functions. This file is the contract the
 * dashboard is written against: which file a path resolves to and with what type, which headers
 * every response carries, what the body limits do, and the exact order a streamed run arrives in.
 * A client that relies on any of these can change only if this file changes with it.
 */

const OPTIONS = { version: '0.0.0-test', packageName: 'opengeo' };

/** @type {string} */
let root;
/** @type {string} */
let webRoot;
/** @type {RunningServer} */
let running;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'opengeo-http-'));
  webRoot = join(root, 'web');
  mkdirSync(join(webRoot, 'views'), { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>dash</title>');
  writeFileSync(join(webRoot, 'app.js'), 'export {};\n');
  writeFileSync(join(webRoot, 'styles.css'), 'body {}\n');
  writeFileSync(join(webRoot, 'views', 'test.js'), 'export {};\n');
  running = await startServer({ ...OPTIONS, root, port: 0, webRoot });
});

afterEach(async () => {
  await running.close();
  rmSync(root, { recursive: true, force: true });
});

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
function hit(path, init) {
  return fetch(`${running.url}${path}`, init);
}

/** @param {unknown} body */
function postJson(body) {
  return /** @type {RequestInit} */ ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('static files', () => {
  it('serves the page at the root and at any application route', async () => {
    for (const path of ['/', '/settings', '/a/deeper/route']) {
      const response = await hit(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toBe('text/html; charset=utf-8');
      expect(await response.text(), path).toContain('<title>dash</title>');
    }
  });

  it('serves a module with a type a browser will execute as one, including from a subdirectory', async () => {
    for (const path of ['/app.js', '/views/test.js']) {
      const response = await hit(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toBe('text/javascript; charset=utf-8');
    }
    expect((await hit('/styles.css')).headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  /** A mistyped import has to fail loudly in the console, not arrive as HTML and fail to parse. */
  it('answers a missing asset with a 404, never with the page', async () => {
    for (const path of ['/missing.js', '/views/missing.js', '/styles.missing.css']) {
      const response = await hit(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe('Not found');
    }
  });

  it('refuses to climb out of the web root over the wire', async () => {
    writeFileSync(join(root, 'secret.txt'), 'not for the browser');
    for (const path of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/views/..%2f..%2fsecret.txt']) {
      const response = await hit(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain('not for the browser');
    }
  });

  it('never lets a browser keep a stale copy of the page', async () => {
    expect((await hit('/')).headers.get('cache-control')).toBe('no-store');
  });

  /**
   * The modules are served as they sit on disk, under the same names in every release. A browser
   * that kept last version's `app.js` would run it against this version's `views/test.js`.
   */
  it('makes the browser revalidate every module and stylesheet', async () => {
    for (const path of ['/app.js', '/views/test.js', '/styles.css']) {
      expect((await hit(path)).headers.get('cache-control'), path).toBe('no-cache');
    }
  });

  it('answers only GET and HEAD, and says which', async () => {
    const head = await hit('/app.js', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await hit('/index.html', { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow'), method).toBe('GET, HEAD');
      expect(await response.text(), method).not.toContain('<title>dash</title>');
    }
  });

  /** fetch normalises the request line, so this has to go over a raw socket to say what it says. */
  it('answers a request line it cannot parse with a 400, not a crash', async () => {
    const { connect } = await import('node:net');
    const statusLine = await new Promise((resolveLine, rejectLine) => {
      const socket = connect(running.port, '127.0.0.1', () =>
        socket.write(`GET http://x:99999/ HTTP/1.1\r\nHost: 127.0.0.1:${running.port}\r\nConnection: close\r\n\r\n`),
      );
      let received = '';
      socket.on('data', (chunk) => (received += chunk));
      socket.on('end', () => resolveLine(received.split('\r\n')[0]));
      socket.on('error', rejectLine);
    });
    expect(statusLine).toBe('HTTP/1.1 400 Bad Request');
  });

  // The dashboard has no build step, so the fix is never "build it first".
  it('names the folder and how to get it back when the dashboard files are missing', async () => {
    rmSync(webRoot, { recursive: true, force: true });
    const response = await hit('/');
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain(webRoot);
    expect(body).toContain('reinstalling opengeo');
    expect(body).not.toContain('npm run build');
  });
});

describe('headers on every kind of response', () => {
  it('sends the hardening headers on a page, a module, a 404, an API answer and a stream', async () => {
    const responses = {
      page: await hit('/'),
      module: await hit('/app.js'),
      missing: await hit('/missing.js'),
      api: await hit('/api/state'),
      apiMissing: await hit('/api/nothing-here'),
      stream: await hit('/api/test/stream', postJson({ url: 'not-a-url' })),
    };
    for (const [name, response] of Object.entries(responses)) {
      expect(response.headers.get('x-content-type-options'), name).toBe('nosniff');
      expect(response.headers.get('x-frame-options'), name).toBe('DENY');
      expect(response.headers.get('referrer-policy'), name).toBe('no-referrer');
      expect(response.headers.get('content-security-policy'), name).toContain("default-src 'self'");
      await response.arrayBuffer();
    }
  });

  it('answers the API in JSON, including when it refuses', async () => {
    for (const response of [await hit('/api/state'), await hit('/api/nothing-here')]) {
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      await response.json();
    }
  });
});

describe('what the API refuses over the wire', () => {
  it('refuses a cross-origin request with a 403 before doing anything', async () => {
    const response = await hit('/api/config', {
      ...postJson({ site: 'http://localhost:4000' }),
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
    expect(/** @type {{ error: string }} */ (await response.json()).error).toBeTruthy();
  });

  it('answers a body that is not JSON with a 400 that says so', async () => {
    const response = await hit('/api/config', postJson('{"site":'));
    expect(response.status).toBe(400);
    expect(/** @type {{ error: string }} */ (await response.json()).error).toContain('not valid JSON');
  });

  /**
   * It used to destroy the request on the spot, which closed the socket before the 400 was written,
   * so every client saw a reset and the dashboard reported an unreachable server instead.
   */
  it('refuses a body past the 2 MiB cap with a 400 the client actually receives', async () => {
    for (const size of [2 * 1024 * 1024 + 16, 8 * 1024 * 1024]) {
      const response = await hit('/api/config', postJson({ site: 'x'.repeat(size) }));
      expect(response.status, String(size)).toBe(400);
      expect(/** @type {{ error: string }} */ (await response.json()).error).toContain('too large');
    }
    expect(existsSync(join(root, 'opengeo.config.json'))).toBe(false);
  });

  it('still reads a body right up to the cap', async () => {
    const padding = ' '.repeat(2 * 1024 * 1024 - JSON.stringify({ site: 'http://localhost:4000' }).length);
    const response = await hit('/api/config', postJson(`${JSON.stringify({ site: 'http://localhost:4000' })}${padding}`));
    expect(response.status).toBe(200);
  });

  it('names a missing endpoint with a 404', async () => {
    const response = await hit('/api/nothing-here');
    expect(response.status).toBe(404);
    expect(/** @type {{ error: string }} */ (await response.json()).error).toContain('/api/nothing-here');
  });
});

/**
 * Splits a finished stream into what a client sees, in order: comments as `:<text>` and frames as
 * `{ event, data }`.
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
      expect(eventLine.startsWith('event: ')).toBe(true);
      expect(dataLine.startsWith('data: ')).toBe(true);
      return { event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) };
    });
}

describe('a streamed run, frame by frame', () => {
  /** @type {Server} */
  let site;
  /** @type {string} */
  let siteUrl;

  beforeEach(async () => {
    site = createServer((request, response) => {
      if (request.url === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1><p>Hello.</p></main></body></html>');
        return;
      }
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('nope');
    });
    await new Promise((resolveListen) => site.listen(0, '127.0.0.1', () => resolveListen(undefined)));
    const address = site.address();
    siteUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
  });

  afterEach(async () => {
    await new Promise((resolveClose) => site.close(() => resolveClose(undefined)));
  });

  it('opens with a comment, narrates, and ends on exactly one done frame carrying the result', async () => {
    const response = await hit('/api/test/stream', postJson({ url: siteUrl, mode: 'structure' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const frames = framesOf(await response.text());
    expect(frames[0]).toBe(': open');
    const events = frames.filter((frame) => typeof frame !== 'string');
    const last = events.at(-1);
    expect(last).toMatchObject({ event: 'done', data: { status: 200 } });
    expect(events.filter((frame) => frame.event === 'done')).toHaveLength(1);
    expect(events.slice(0, -1).every((frame) => frame.event === 'progress')).toBe(true);

    const phases = events.slice(0, -1).map((frame) => frame.data.phase);
    expect(phases[0]).toBe('structure');
    expect(phases).toContain('structure-done');
    expect(phases.indexOf('structure')).toBeLessThan(phases.indexOf('structure-done'));
    expect(last && typeof last !== 'string' ? last.data.body.score.value : undefined).toEqual(expect.any(Number));
  });

  /** The 200 went out before the handler ran, so a refusal has to travel inside the last frame. */
  it('carries a refusal in the done frame with its own status', async () => {
    for (const path of ['/api/test/stream', '/api/generate/stream']) {
      const response = await hit(path, postJson({ url: 'not-a-url' }));
      expect(response.status, path).toBe(200);
      const frames = framesOf(await response.text());
      expect(frames[0], path).toBe(': open');
      expect(frames.at(-1), path).toMatchObject({ event: 'done', data: { status: 400, body: { error: expect.any(String) } } });
    }
  });

  it('keeps the plain JSON endpoints for anything that is not a browser', async () => {
    const response = await hit('/api/test', postJson({ url: siteUrl, mode: 'structure' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(/** @type {{ score: { value: number } }} */ (await response.json()).score.value).toEqual(expect.any(Number));
  });
});

describe('a run nobody is watching', () => {
  /** @type {Server} */
  let site;
  /** @type {string} */
  let siteUrl;
  /** @type {string[]} */
  let requested;
  /** @type {() => void} */
  let release;
  /** @type {Promise<void>} */
  let held;

  beforeEach(async () => {
    requested = [];
    /** @type {() => void} */
    let reached = () => {};
    held = new Promise((resolveHeld) => {
      reached = resolveHeld;
    });
    /** @type {Promise<void>} */
    const released = new Promise((resolveRelease) => {
      release = () => resolveRelease(undefined);
    });
    site = createServer(async (request, response) => {
      requested.push(request.url ?? '');
      // `/a` hangs until the test lets it go, so the run is reliably mid-crawl when the client leaves.
      if (request.url === '/a') {
        reached();
        await released;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        `<!doctype html><html lang="en"><head><title>${request.url}</title></head><body><main><h1>Page</h1><p>Words enough to be a page.</p><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a></main></body></html>`,
      );
    });
    await new Promise((resolveListen) => site.listen(0, '127.0.0.1', () => resolveListen(undefined)));
    const address = site.address();
    siteUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
  });

  afterEach(async () => {
    release();
    site.closeAllConnections();
    await new Promise((resolveClose) => site.close(() => resolveClose(undefined)));
  });

  /** Waits until no generate is running, without starting one: a bad URL is refused either way. */
  async function settled() {
    for (let i = 0; i < 100; i += 1) {
      if ((await hit('/api/generate', postJson({ url: 'not-a-url' }))).status !== 409) return;
      await new Promise((wait) => setTimeout(wait, 20));
    }
    throw new Error('The run never finished.');
  }

  it('stops crawling and writes nothing once the browser goes away', async () => {
    const controller = new AbortController();
    const response = await hit('/api/generate/stream', { ...postJson({ url: siteUrl }), signal: controller.signal });
    expect(response.status).toBe(200);
    await held;
    controller.abort();
    // Long enough for the socket close to reach the server before `/a` answers.
    await new Promise((wait) => setTimeout(wait, 100));
    release();
    await settled();
    await new Promise((wait) => setTimeout(wait, 100));

    expect(requested).not.toContain('/b');
    expect(existsSync(join(root, '.opengeo', 'manifest.json'))).toBe(false);
  });

  it('refuses a second run of the same kind while the first is going, and allows one after', async () => {
    const first = hit('/api/generate/stream', postJson({ url: siteUrl }));
    await held;
    const second = await hit('/api/generate', postJson({ url: siteUrl }));
    expect(second.status).toBe(409);
    expect(/** @type {{ error: string }} */ (await second.json()).error).toMatch(/already running/i);

    release();
    await (await first).text();
    expect((await hit('/api/generate', postJson({ url: 'not-a-url' }))).status).toBe(400);
  });
});
