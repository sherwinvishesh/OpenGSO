import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MARKDOWN_CONTENT_TYPE, createFsStore } from '@opengeo/core/prod';
import { createNextMiddleware } from '@opengeo/core/prod/next';
/** @import { Server } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */
/** @import { NextMiddlewareResult } from '@opengeo/core/prod/next' */

/**
 * The Next adapter is built at module scope in the user's middleware.ts, so anything it throws while
 * loading the project takes down every request the site serves, pages included. A config file it
 * cannot use has to cost the site its markdown, never its HTML.
 */

/** @type {Server[]} */
const servers = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))),
  );
});

/**
 * A project directory with one generated twin and the given config file text.
 *
 * @param {string | undefined} configText
 */
function project(configText) {
  const root = mkdtempSync(join(tmpdir(), 'opengeo-next-'));
  mkdirSync(join(root, 'public', 'md'), { recursive: true });
  mkdirSync(join(root, '.opengeo'), { recursive: true });
  writeFileSync(join(root, 'public', 'md', 'resume.md'), '---\ntitle: "Resume"\n---\n# Resume\n');
  writeFileSync(
    join(root, '.opengeo', 'manifest.json'),
    JSON.stringify({ pages: { '/resume': { route: '/resume', file: 'md/resume.md', tokens: 3 } } }),
  );
  if (configText !== undefined) writeFileSync(join(root, 'opengeo.config.json'), configText);
  return root;
}

/**
 * The adapter in front of a one-page app, over real HTTP.
 *
 * @param {(request: Request) => NextMiddlewareResult} middleware
 */
async function listen(middleware) {
  const server = createServer((req, res) => {
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: /** @type {Record<string, string>} */ (req.headers),
    });
    const { response, headers } = middleware(request);
    if (response) {
      void response.text().then((body) => {
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(body);
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end('<h1>Resume</h1>');
  });
  servers.push(server);
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  return `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`;
}

describe('a config file the adapter cannot use', () => {
  it.each([
    ['malformed JSON', '{ "site": "http://x", '],
    ['a wrongly typed bots.markdownRouting', '{ "bots": { "markdownRouting": "GPTBot" } }'],
    ['a publicDir outside the project', '{ "publicDir": "/etc" }'],
  ])('fails open on %s: one log line, and every request reaches the site', async (_label, text) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const middleware = createNextMiddleware({ root: project(text) });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toMatch(/^\[opengeo-prod\] .*opengeo\.config\.json/);
    expect(String(errors.mock.calls[0]?.[0])).not.toContain('\n');
    expect(log).not.toHaveBeenCalled();

    const site = await listen(middleware);
    for (const accept of ['text/markdown', 'application/pdf', 'text/html']) {
      const response = await fetch(`${site}/resume`, { headers: { accept } });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    }
  });

  it('serves the twin as usual when the config is fine', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const site = await listen(createNextMiddleware({ root: project('{ "site": "http://localhost:3000" }'), logStartup: false }));
    const response = await fetch(`${site}/resume`, { headers: { accept: 'text/markdown' } });
    expect(response.headers.get('content-type')).toBe(MARKDOWN_CONTENT_TYPE);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('a manifest entry that points outside publicDir', () => {
  it('is skipped and reported, and never served', async () => {
    const root = project(undefined);
    writeFileSync(join(root, 'secret.md'), '# DATABASE_PASSWORD=hunter2\n');
    writeFileSync(
      join(root, '.opengeo', 'manifest.json'),
      JSON.stringify({
        pages: {
          '/resume': { route: '/resume', file: 'md/resume.md', tokens: 3 },
          '/leak': { route: '/leak', file: '../secret.md', tokens: 3 },
          '/deep': { route: '/deep', file: 'md/../../secret.md', tokens: 3 },
        },
      }),
    );

    const store = createFsStore({ root });
    expect(store.routes()).toEqual(['/resume']);
    expect(store.problems).toHaveLength(2);
    expect(store.problems.join('\n')).toMatch(/\/leak.*outside/);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const site = await listen(createNextMiddleware({ root, store, logStartup: false }));
    const leak = await fetch(`${site}/leak`, { headers: { accept: 'text/markdown' } });
    expect(await leak.text()).not.toContain('hunter2');
  });

  it('still loads a file whose name merely starts with two dots', () => {
    const root = project(undefined);
    writeFileSync(join(root, 'public', 'md', '..notes.md'), '# Notes\n');
    writeFileSync(
      join(root, '.opengeo', 'manifest.json'),
      JSON.stringify({ pages: { '/notes': { route: '/notes', file: 'md/..notes.md', tokens: 1 } } }),
    );
    expect(createFsStore({ root }).routes()).toEqual(['/notes']);
  });
});
