import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MARKDOWN_ROUTING, HEADERS, MARKDOWN_CONTENT_TYPE, createMemoryStore, handleRequest } from '@opengeo/core/prod';
/** @import { Server, IncomingMessage, ServerResponse } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */

/**
 * The middleware in front of a whole application, over real HTTP.
 *
 * `prod.test.js` checks decisions one at a time. This file puts `handleRequest` in front of an app
 * that also has an API, an event stream and a feed, because the failures that matter in production
 * are the ones where prod answers a request that was never its business.
 */

const store = createMemoryStore([
  { route: '/resume', title: 'Resume', body: '# Resume\n\nShipped 4 projects in 2024.', tokens: 12, lastUpdated: '' },
]);

/** What the application itself answers, keyed by path, when prod passes a request through. */
/** @type {Record<string, { type: string; body: string }>} */
const APP = {
  '/resume': { type: 'text/html; charset=utf-8', body: '<h1>Resume</h1>' },
  '/api/users': { type: 'application/json', body: '[{"id":1}]' },
  '/events': { type: 'text/event-stream', body: 'data: hello\n\n' },
  '/feed': { type: 'application/rss+xml', body: '<rss version="2.0"></rss>' },
};

/** @type {Server} */
let server;
/** @type {string} */
let site;

/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 */
async function serve(req, res) {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const decision = handleRequest(
    {
      url,
      method: req.method,
      headers: { get: (name) => /** @type {string | undefined} */ (req.headers[name.toLowerCase()]) ?? null },
    },
    { store, markdownRouting: DEFAULT_MARKDOWN_ROUTING },
  );
  if (decision.type !== 'passthrough') {
    res.writeHead(decision.response.status, Object.fromEntries(decision.response.headers.entries()));
    res.end(await decision.response.text());
    return;
  }
  const page = APP[new URL(url).pathname];
  if (!page) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': page.type, ...decision.headers });
  res.end(page.body);
}

beforeAll(async () => {
  server = createServer((req, res) => void serve(req, res));
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  site = `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`;
});

afterAll(async () => {
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.close(() => resolve())));
});

describe('406 is only for routes prod can actually answer', () => {
  it.each([
    ['/api/users', 'application/json'],
    ['/events', 'text/event-stream'],
    ['/feed', 'application/rss+xml'],
  ])('passes %s with Accept: %s through to the application', async (path, accept) => {
    const response = await fetch(`${site}${path}`, { headers: { accept } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(accept);
    expect(await response.text()).toBe(APP[path]?.body);
  });

  it('still answers 406 on a route with a twin when neither format was asked for', async () => {
    const response = await fetch(`${site}/resume`, { headers: { accept: 'application/pdf' } });
    expect(response.status).toBe(406);
    expect(response.headers.get(HEADERS.vary)).toBe('Accept');
  });

  it('still answers 406 on the twin URL itself when markdown is excluded', async () => {
    const response = await fetch(`${site}/resume.md`, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(406);
  });

  it('serves the twin as before', async () => {
    const response = await fetch(`${site}/resume`, { headers: { accept: 'text/markdown' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(MARKDOWN_CONTENT_TYPE);
  });
});
