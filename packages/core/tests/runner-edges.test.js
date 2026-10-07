import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { discoverTwins, sitemapTwins, testUrl } from '@opengeo/core/test';
/** @import { IncomingMessage, Server, ServerResponse } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */
/** @import { TestResult } from '@opengeo/core/test' */

/**
 * Sites that answer in ways a well-behaved one would not, run through the real probe and the real
 * checks over loopback. Each test installs its own handler, so every case is one site's behaviour.
 */

/** @typedef {(req: IncomingMessage, res: ServerResponse, path: string) => void} Handler */

/** @type {Handler} */
let handler = (_req, res) => {
  res.end();
};

/** @type {Server} */
let server;
/** @type {string} */
let site;

const PAGE = `<!doctype html><html><head><title>Docs</title></head><body><main><h1>Docs</h1>
<p>Shipped four projects in 2024 across three teams, including a platform migration that moved
forty-two services onto a shared runtime, and a pricing change worth twelve thousand five hundred
dollars a month to the business. Earlier work covered data pipelines and developer tooling, with a
long stretch owning the build system and the release process for a codebase of roughly two hundred
thousand lines.</p></main></body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res, new URL(req.url ?? '/', 'http://localhost').pathname));
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  site = `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`;
});

afterAll(async () => {
  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
});

beforeEach(() => {
  handler = (_req, res) => {
    res.end();
  };
});

/**
 * @param {TestResult} result
 * @param {string} id
 */
function check(result, id) {
  const found = result.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
}

describe('a single-page app that answers 200 with its shell for every path', () => {
  beforeEach(() => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    };
  });

  it('does not credit robots.txt, llms.txt or a twin it does not have', async () => {
    const result = await testUrl(`${site}/docs/page`);
    expect(check(result, 'A1').status).toBe('fail');
    expect(check(result, 'A1').reason).toContain('HTML');
    expect(check(result, 'A2').status).toBe('fail');
    expect(check(result, 'A2').reason).toContain('HTML');
    expect(check(result, 'B1').status).toBe('fail');
    expect(check(result, 'B1').reason).toContain('HTML');
  });

  it('locks the twin cascade behind B1, since the HTML shell is not a twin', async () => {
    const result = await testUrl(`${site}/docs/page`);
    for (const id of ['B2', 'B3', 'B4', 'B5', 'B6', 'B12', 'B14']) {
      expect(check(result, id).status, id).toBe('locked');
    }
  });
});

describe('a sitemap index', () => {
  /** @type {string[]} */
  let pages = [];

  beforeEach(() => {
    pages = ['/docs/page'];
    handler = (_req, res, path) => {
      if (path === '/sitemap.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(`<?xml version="1.0"?><sitemapindex><sitemap><loc>${site}/sitemap-pages.xml</loc></sitemap></sitemapindex>`);
        return;
      }
      if (path === '/sitemap-pages.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(`<?xml version="1.0"?><urlset>${pages.map((page) => `<url><loc>${site}${page}</loc></url>`).join('')}</urlset>`);
        return;
      }
      if (path === '/docs/page.md') {
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
        res.end('# Docs');
        return;
      }
      res.writeHead(path === '/docs/page' ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    };
  });

  it('passes A3 when one of its sitemaps lists the page', async () => {
    const result = await testUrl(`${site}/docs/page`);
    expect(check(result, 'A3').status).toBe('pass');
    expect(check(result, 'A3').reason).toContain('index');
  });

  it('names the sitemaps it read when none of them lists the page', async () => {
    pages = ['/other'];
    const result = await testUrl(`${site}/docs/page`);
    const a3 = check(result, 'A3');
    expect(a3.status).toBe('partial');
    expect(a3.reason).toContain('sitemap index');
    expect(a3.reason).toContain('/docs/page');
  });

  it('reads the child sitemaps for discovery, rather than guessing a twin of each sitemap file', async () => {
    const discovery = await discoverTwins(new URL(`${site}/`));
    const urls = [...discovery.twins.map((twin) => twin.url), ...discovery.rejected.map((entry) => entry.url)];
    expect(urls).toContain(`${site}/docs/page.md`);
    expect(urls.some((url) => url.endsWith('.xml.md'))).toBe(false);
  });

  it('does not map an index body through the twin convention', () => {
    const body = '<sitemapindex><sitemap><loc>https://x.example/sitemap-1.xml</loc></sitemap></sitemapindex>';
    expect(sitemapTwins(body, 'https://x.example')).toEqual([]);
  });
});
