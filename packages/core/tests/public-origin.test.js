import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configPatchProblem, defaultConfig, loadConfig, mergeConfig } from '@opengeo/core/shared';
import { generateSite } from '@opengeo/core/generate';
/** @import { Server } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */
/** @import { LoadedConfig } from '@opengeo/core/shared' */

/**
 * Generate usually runs against a dev server, and every absolute URL it wrote came from that
 * server's origin: the sitemap, robots.txt's Sitemap line, llms.txt, each twin's frontmatter and the
 * links inside it. Deployed, all of them pointed at http://localhost:3000.
 */

/** @type {Record<string, string>} */
const PAGES = {
  '/': '<main><h1>Home</h1><p>Read <a href="/about">about us</a> for the rest of the story.</p></main>',
  '/about': '<main><h1>About</h1><p>We make things, and this sentence is here so there are words.</p></main>',
};

/** @type {Server} */
let server;
/** @type {string} */
let site;

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = PAGES[new URL(req.url ?? '/', 'http://localhost').pathname];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`);
  });
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  site = `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`;
});

afterAll(async () => {
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.close(() => resolve())));
});

/**
 * @param {string} [publicOrigin]
 * @returns {LoadedConfig}
 */
function project(publicOrigin) {
  const config = defaultConfig(site);
  if (publicOrigin) config.publicOrigin = publicOrigin;
  return { config, root: mkdtempSync(join(tmpdir(), 'opengeo-origin-')), exists: true };
}

/**
 * @param {LoadedConfig} loaded
 * @param {string} name
 */
const read = (loaded, name) => readFileSync(join(loaded.root, 'public', name), 'utf8');

describe('publicOrigin', () => {
  it('is the origin every generated URL points at, while the crawl still reads the dev server', async () => {
    const loaded = project('https://example.com');
    const result = await generateSite({ target: `${site}/`, loaded });

    expect(result.generate.pages.map((page) => page.status)).toEqual(['written', 'written']);
    expect(read(loaded, 'sitemap.xml')).toContain('<loc>https://example.com/about</loc>');
    expect(read(loaded, 'robots.txt')).toContain('Sitemap: https://example.com/sitemap.xml');
    expect(read(loaded, 'llms.txt')).toContain('(https://example.com/about.md)');
    const home = read(loaded, 'md/index.md');
    expect(home).toContain('url: "https://example.com/"');
    expect(home).toContain('[about us](https://example.com/about)');
    expect(result.generate.manifest.pages['/about']?.url).toBe('https://example.com/about');

    for (const name of ['sitemap.xml', 'robots.txt', 'llms.txt', 'md/index.md', 'md/about.md']) {
      expect(read(loaded, name)).not.toContain('127.0.0.1');
    }
    expect(result.warnings.join('\n')).not.toContain('publicOrigin');
  });

  it('warns loudly when the URLs it writes would point at a loopback address', async () => {
    const loaded = project();
    const result = await generateSite({ target: `${site}/`, loaded });
    expect(result.warnings[0]).toContain(site);
    expect(result.warnings[0]).toContain('publicOrigin');
  });

  it('regenerates a cached twin when the origin it should name has changed', async () => {
    const loaded = project();
    await generateSite({ target: `${site}/`, loaded });
    loaded.config.publicOrigin = 'https://example.com';
    const again = await generateSite({ target: `${site}/`, loaded });
    expect(again.generate.pages.map((page) => page.status)).toEqual(['written', 'written']);
    expect(read(loaded, 'md/about.md')).toContain('url: "https://example.com/about"');
  });

  it('is validated as an origin when the config is loaded or patched', () => {
    expect(configPatchProblem({ publicOrigin: 'https://example.com' })).toBeUndefined();
    expect(configPatchProblem({ publicOrigin: 'https://example.com/' })).toBeUndefined();
    expect(configPatchProblem({ publicOrigin: 'example.com' })).toContain('publicOrigin');
    expect(configPatchProblem({ publicOrigin: 'https://example.com/blog' })).toContain('publicOrigin');
    expect(configPatchProblem({ publicOrigin: 'ftp://example.com' })).toContain('publicOrigin');

    const root = mkdtempSync(join(tmpdir(), 'opengeo-origin-config-'));
    writeFileSync(join(root, 'opengeo.config.json'), JSON.stringify({ publicOrigin: 'https://example.com' }));
    expect(loadConfig(root).config.publicOrigin).toBe('https://example.com');
    expect(mergeConfig(defaultConfig(), {}).publicOrigin).toBeUndefined();
  });
});
