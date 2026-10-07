import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '@opengeo/core/shared';
import { generatePages } from '@opengeo/core/generate';
/** @import { Server } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */
/** @import { LoadedConfig } from '@opengeo/core/shared' */

/**
 * Two routes, one twin file: `/` and `/index` both become md/index.md, and on a case-insensitive
 * filesystem (macOS and Windows by default) `/About` and `/about` are one file too. The second
 * write used to replace the first without a word.
 */

/** @type {Record<string, string>} */
const PAGES = {
  '/': 'Home page words.',
  '/index': 'An index page with different words.',
  '/about': 'About us in lower case.',
  '/About': 'About us in title case.',
};

/** @type {Server} */
let server;
/** @type {string} */
let site;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const body = PAGES[path];
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<html><body>nope</body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>${path}</title></head><body><main><h1>${path}</h1><p>${body}</p></main></body></html>`);
  });
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  site = `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`;
});

afterAll(async () => {
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.close(() => resolve())));
});

/** @returns {LoadedConfig} */
function project() {
  return { config: defaultConfig(site), root: mkdtempSync(join(tmpdir(), 'opengeo-collide-')), exists: true };
}

describe('two routes that would share a twin file', () => {
  it('writes the first, reports the second, and never lets one overwrite the other', async () => {
    const loaded = project();
    const result = await generatePages({ site, routes: ['/', '/index', '/about', '/About'], loaded });
    const byRoute = Object.fromEntries(result.pages.map((page) => [page.route, page]));

    expect(byRoute['/']?.status).toBe('written');
    expect(byRoute['/index']?.status).toBe('failed');
    expect(byRoute['/index']?.reason).toContain('md/index.md');
    expect(readFileSync(join(loaded.root, 'public', 'md', 'index.md'), 'utf8')).toContain('Home page words.');

    const lower = byRoute['/about'];
    const title = byRoute['/About'];
    expect([lower?.status, title?.status].sort()).toEqual(['failed', 'written']);
    expect(Object.keys(result.manifest.pages).sort()).toEqual(['/', lower?.status === 'written' ? '/about' : '/About'].sort());
  });

  it('is caught on a single-page run against what the manifest already has', async () => {
    const loaded = project();
    await generatePages({ site, routes: ['/'], loaded });
    const single = await generatePages({ site, routes: ['/index'], loaded, merge: true });
    expect(single.pages[0]?.status).toBe('failed');
    expect(readFileSync(join(loaded.root, 'public', 'md', 'index.md'), 'utf8')).toContain('Home page words.');
    expect(Object.keys(single.manifest.pages)).toEqual(['/']);
  });
});
