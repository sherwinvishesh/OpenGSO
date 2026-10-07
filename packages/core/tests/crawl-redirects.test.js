import { createServer } from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '@opengeo/core/shared';
import { crawlSite, generatePages, generateSite } from '@opengeo/core/generate';
/** @import { Server } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */
/** @import { LoadedConfig } from '@opengeo/core/shared' */

/**
 * Two real servers: the site, and somebody else's. The site redirects some routes to the other
 * one, which is what an apex-to-www hop, an http-to-https hop, or a hostile link does.
 */

/** @type {Server} */
let site;
/** @type {Server} */
let elsewhere;
/** @type {string} */
let siteUrl;
/** @type {string} */
let elsewhereUrl;

/**
 * @param {Server} server
 * @returns {Promise<string>}
 */
async function listen(server) {
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  return `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`;
}

const page = (/** @type {string} */ body) =>
  `<!doctype html><html><head><title>T</title></head><body><main>${body}</main></body></html>`;

beforeAll(async () => {
  elsewhere = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end(page('<h1>Not yours</h1><p>Another server entirely, with its own words.</p><a href="/more">More</a>'));
  });
  elsewhereUrl = await listen(elsewhere);

  site = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(page('<h1>Home</h1><p>The real site.</p><a href="/away">Away</a><a href="/moved">Moved</a>'));
      return;
    }
    if (path === '/away' || path === '/gone') {
      res.writeHead(302, { location: `${elsewhereUrl}/landing` }).end();
      return;
    }
    if (path === '/moved') {
      res.writeHead(301, { location: '/new-home' }).end();
      return;
    }
    if (path === '/new-home') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(page('<h1>New home</h1><p>Moved here, same site.</p>'));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html' }).end(page('nope'));
  });
  siteUrl = await listen(site);
});

afterAll(async () => {
  for (const server of [site, elsewhere]) {
    await /** @type {Promise<void>} */ (new Promise((resolve) => server.close(() => resolve())));
  }
});

/** @returns {LoadedConfig} */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'opengeo-redirect-'));
  return { config: defaultConfig(siteUrl), root, exists: true };
}

describe('a redirect to another origin', () => {
  it('is a crawl failure, not a page', async () => {
    const result = await crawlSite({ site: siteUrl });
    const routes = result.pages.map((p) => p.route);
    expect(routes).toContain('/');
    expect(routes).not.toContain('/away');
    expect(result.failures.find((f) => f.route === '/away')?.reason).toContain(elsewhereUrl);
  });

  it('still follows a redirect that stays on the site', async () => {
    const result = await crawlSite({ site: siteUrl });
    expect(result.pages.find((p) => p.route === '/moved')?.html).toContain('New home');
  });

  it('says so loudly when the start URL itself redirects away, instead of a quiet one-page run', async () => {
    const result = await crawlSite({ site: siteUrl, startRoutes: ['/gone'] });
    expect(result.pages).toEqual([]);
    expect(result.warnings.join(' ')).toContain(elsewhereUrl);
  });

  it('never writes the other server\'s content as a twin', async () => {
    const loaded = project();
    const single = await generatePages({ site: siteUrl, routes: ['/away'], loaded });
    expect(single.pages[0]?.status).toBe('failed');
    expect(single.pages[0]?.reason).toContain(elsewhereUrl);
    expect(existsSync(join(loaded.root, 'public', 'md', 'away.md'))).toBe(false);

    const crawled = await generateSite({ target: `${siteUrl}/gone`, loaded: project() });
    expect(crawled.generate.pages.some((p) => p.status === 'written')).toBe(false);
  });
});
