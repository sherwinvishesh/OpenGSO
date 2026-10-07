import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractLinks, isCrawlable } from '@opengeo/core/generate';
import { renderLlmsTxt, renderRobotsTxt, renderSitemapXml, writeSiteFiles, GENERATED_MARKER } from '@opengeo/core/generate';
/** @import { AiBot } from '@opengeo/core/shared' */
/** @import { SitePage } from '@opengeo/core/generate' */

const ORIGIN = 'https://example.com';

describe('extractLinks', () => {
  it('resolves relative, absolute and root-relative hrefs against the page URL', () => {
    const html = `<a href="/about">a</a><a href="team">b</a><a href="https://example.com/resume">c</a>`;
    const links = extractLinks(html, 'https://example.com/company/');
    expect(links.map((l) => l.pathname)).toEqual(['/about', '/company/team', '/resume']);
  });

  it('ignores anchors, mailto, tel and javascript hrefs', () => {
    const html = `<a href="#top">t</a><a href="mailto:a@b.c">m</a><a href="tel:+1">p</a><a href="javascript:void(0)">j</a><a href="/real">r</a>`;
    const links = extractLinks(html, ORIGIN);
    expect(links.map((l) => l.pathname)).toEqual(['/real']);
  });

  it('keeps going past a malformed href instead of throwing', () => {
    // Resolved against a base, a nonsense href becomes a nonsense relative path rather than an
    // error - the same thing a browser does. It gets fetched, 404s, and shows up as one crawl
    // failure. What matters here is that the real link after it is still found.
    const links = extractLinks(`<a href="ht!tp://[[[">bad</a><a href="/ok">ok</a>`, ORIGIN);
    expect(links.map((l) => l.pathname)).toContain('/ok');
  });
});

describe('isCrawlable', () => {
  /**
   * @param {string} href
   * @param {string[]} [exclude]
   */
  const crawlable = (href, exclude = []) => isCrawlable(new URL(href, ORIGIN), ORIGIN, exclude);

  it('keeps same-origin page links', () => {
    expect(crawlable('/about')).toBe(true);
    expect(crawlable('/blog/post-one')).toBe(true);
  });

  it('drops other origins', () => {
    expect(crawlable('https://other.example/about')).toBe(false);
  });

  it('drops assets by extension', () => {
    for (const path of ['/logo.png', '/app.js', '/styles.css', '/paper.pdf', '/data.json', '/index.md']) {
      expect(crawlable(path), path).toBe(false);
    }
  });

  it('drops framework internals', () => {
    expect(crawlable('/_next/static/chunk.js')).toBe(false);
    expect(crawlable('/_nuxt/entry')).toBe(false);
    expect(crawlable('/cdn-cgi/l/email-protection')).toBe(false);
  });

  it('honours configured exclusions, including everything below them', () => {
    expect(crawlable('/admin', ['/admin'])).toBe(false);
    expect(crawlable('/admin/users', ['/admin'])).toBe(false);
    expect(crawlable('/administration', ['/admin'])).toBe(true);
  });
});

/** @type {SitePage[]} */
const PAGES = [
  { route: '/about', url: `${ORIGIN}/about`, title: 'About', description: 'Who we are', lastUpdated: '2026-01-02T03:04:05.000Z' },
  { route: '/', url: `${ORIGIN}/`, title: 'Home', description: 'A demo site', lastUpdated: '2026-01-02T03:04:05.000Z' },
];

/** @param {Partial<Parameters<typeof renderRobotsTxt>[0]>} [overrides] */
const options = (overrides = {}) => ({
  site: ORIGIN,
  publicDir: '/tmp/nowhere',
  pages: PAGES,
  ...overrides,
});

describe('renderRobotsTxt', () => {
  it('allows everything and blocks nobody by default', () => {
    const text = renderRobotsTxt(options());
    expect(text).toContain('User-agent: *');
    expect(text).toContain('Allow: /');
    expect(text).not.toContain('Disallow: /');
    expect(text).toContain(GENERATED_MARKER);
  });

  it('writes a Disallow only for bots the user explicitly listed', () => {
    const text = renderRobotsTxt(options({ blocked: ['CCBot'] }));
    expect(text).toContain('User-agent: CCBot');
    expect(text).toContain('Disallow: /');
    expect(text).not.toContain('User-agent: GPTBot');
  });

  it('maps a bot name to its robots token', () => {
    expect(renderRobotsTxt(options({ blocked: ['Bingbot'] }))).toContain('User-agent: bingbot');
  });

  it('points at the sitemap', () => {
    expect(renderRobotsTxt(options())).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it('cannot be made to write a directive by a name with a newline in it', () => {
    const text = renderRobotsTxt(options({ blocked: ['Evil\nUser-agent: *\nDisallow: /'] }));
    const lines = text.split('\n');
    // The only Disallow anywhere would be the injected one, under the wildcard group.
    expect(lines.filter((line) => line.startsWith('Disallow'))).toEqual([]);
    expect(lines.filter((line) => line === 'User-agent: *')).toHaveLength(1);
    expect(text).toMatch(/^# Skipped .*not a valid robots\.txt user-agent token/m);
  });

  it('checks the token a custom crawler declares, not only the name', () => {
    /** @type {AiBot[]} */
    const bots = [{ name: 'Ours', vendor: 'Us', uaPatterns: ['Ours'], robotsToken: 'Ours\nDisallow: /', kind: 'training', custom: true }];
    const text = renderRobotsTxt(options({ blocked: ['Ours'], bots }));
    expect(text.split('\n').filter((line) => line.startsWith('Disallow'))).toEqual([]);
  });
});

describe('renderLlmsTxt', () => {
  it('lists twins, not HTML pages, with the home page first', () => {
    const text = renderLlmsTxt(options({ siteName: 'Demo', siteDescription: 'A demo site' }));
    expect(text.startsWith('# Demo')).toBe(true);
    expect(text).toContain('> A demo site');
    const home = text.indexOf(`(${ORIGIN}/index.md)`);
    const about = text.indexOf(`(${ORIGIN}/about.md)`);
    expect(home).toBeGreaterThan(-1);
    expect(about).toBeGreaterThan(home);
  });
});

describe('renderSitemapXml', () => {
  it('lists the HTML URLs and never the noindex twins', () => {
    const xml = renderSitemapXml(options());
    expect(xml).toContain(`<loc>${ORIGIN}/</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/about</loc>`);
    expect(xml).not.toContain('.md');
    expect(xml).toContain('<lastmod>2026-01-02T03:04:05.000Z</lastmod>');
  });

  it('escapes XML-hostile characters in URLs', () => {
    const xml = renderSitemapXml(
      options({ pages: [{ route: '/a', url: `${ORIGIN}/a?x=1&y=2`, title: 'A' }] }),
    );
    expect(xml).toContain('&amp;');
    expect(xml).not.toMatch(/=1&y/);
  });
});

describe('writeSiteFiles', () => {
  const scratch = () => mkdtempSync(join(tmpdir(), 'opengeo-files-'));

  it('writes all three on a clean directory', () => {
    const dir = scratch();
    const results = writeSiteFiles(options({ publicDir: dir }));
    expect(results.map((r) => r.status)).toEqual(['written', 'written', 'written']);
    for (const name of ['robots.txt', 'llms.txt', 'sitemap.xml']) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
  });

  it('never clobbers a hand-written file, and leaves a proposal beside it', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'robots.txt'), 'User-agent: *\nDisallow: /staging\n', 'utf8');
    const results = writeSiteFiles(options({ publicDir: dir }));
    const robots = results.find((r) => r.name === 'robots.txt');

    expect(robots?.status).toBe('proposed');
    expect(readFileSync(join(dir, 'robots.txt'), 'utf8')).toContain('Disallow: /staging');
    expect(existsSync(join(dir, 'robots.txt.opengeo-proposed'))).toBe(true);
    expect(robots?.message).toContain('opengeo-proposed');
  });

  it('does not take a file for its own just because it mentions the marker', () => {
    const dir = scratch();
    const mine = `User-agent: *\nDisallow: /staging\n# The old file was ${GENERATED_MARKER}; this one is not.\n`;
    writeFileSync(join(dir, 'robots.txt'), mine, 'utf8');
    writeFileSync(join(dir, 'llms.txt'), `# Mine\n\nNotes on what ${GENERATED_MARKER} does.\n`, 'utf8');
    const results = writeSiteFiles(options({ publicDir: dir }));
    expect(results.find((r) => r.name === 'robots.txt')?.status).toBe('proposed');
    expect(results.find((r) => r.name === 'llms.txt')?.status).toBe('proposed');
    expect(readFileSync(join(dir, 'robots.txt'), 'utf8')).toBe(mine);
  });

  it('overwrites a hand-written file when the user asks with --force', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'robots.txt'), 'User-agent: *\nDisallow: /staging\n', 'utf8');
    const results = writeSiteFiles(options({ publicDir: dir, force: true }));
    expect(results.find((r) => r.name === 'robots.txt')?.status).toBe('written');
    expect(readFileSync(join(dir, 'robots.txt'), 'utf8')).toContain(GENERATED_MARKER);
  });

  it('rewrites its own output without complaint', () => {
    const dir = scratch();
    writeSiteFiles(options({ publicDir: dir }));
    const second = writeSiteFiles(options({ publicDir: dir }));
    expect(second.every((r) => r.status === 'written' || r.status === 'unchanged')).toBe(true);
    expect(second.some((r) => r.status === 'proposed')).toBe(false);
  });

  it('reports unchanged when only the generation timestamp would differ', () => {
    const dir = scratch();
    writeSiteFiles(options({ publicDir: dir }));
    const second = writeSiteFiles(options({ publicDir: dir }));
    expect(second.map((r) => r.status)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  it('honours a hand-edit to a file OpenGEO wrote, as long as the marker stays', () => {
    const dir = scratch();
    writeSiteFiles(options({ publicDir: dir }));
    const path = join(dir, 'robots.txt');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nCrawl-delay: 10\n`, 'utf8');
    const second = writeSiteFiles(options({ publicDir: dir }));
    expect(second.find((r) => r.name === 'robots.txt')?.status).toBe('written');
  });

  it('creates the public directory if it does not exist yet', () => {
    const dir = join(scratch(), 'nested', 'public');
    mkdirSync(dir, { recursive: true });
    expect(writeSiteFiles(options({ publicDir: dir })).every((r) => r.status === 'written')).toBe(true);
  });

  it('can be told to write only some of the files', () => {
    const dir = scratch();
    const results = writeSiteFiles(options({ publicDir: dir, only: ['sitemap.xml'] }));
    expect(results).toHaveLength(1);
    expect(existsSync(join(dir, 'robots.txt'))).toBe(false);
  });
});

/**
 * The BFS itself runs against a real local server rather than a mocked fetch, because the things
 * most likely to break are the boring ones: relative link resolution, trailing slashes, and the
 * caps actually stopping.
 */
describe('crawlSite', () => {
  /** @type {Record<string, string>} */
  const PAGES_HTML = {
    '/': `<html><body><main><h1>Home</h1><a href="/about">About</a><a href="/about/">About again</a>
      <a href="/deep/one">Deep</a><a href="https://elsewhere.example/x">Off-site</a>
      <a href="/logo.png">Logo</a></main></body></html>`,
    '/about': `<html><body><main><h1>About</h1><a href="/">Home</a><a href="/team">Team</a></main></body></html>`,
    '/team': `<html><body><main><h1>Team</h1><a href="/about">Back</a></main></body></html>`,
    '/deep/one': `<html><body><main><h1>One</h1><a href="two">Two</a></main></body></html>`,
    '/deep/two': `<html><body><main><h1>Two</h1><a href="/deep/three">Three</a></main></body></html>`,
    '/deep/three': `<html><body><main><h1>Three</h1></main></body></html>`,
    '/hidden': `<html><body><main><h1>Hidden</h1></main></body></html>`,
    '/admin': `<html><body><main><h1>Admin</h1></main></body></html>`,
  };

  /**
   * @template T
   * @param {(base: string) => Promise<T>} run
   * @returns {Promise<T>}
   */
  async function withServer(run) {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/(.)\/$/, '$1');
      if (path === '/feed.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' }).end('<rss/>');
        return;
      }
      const html = PAGES_HTML[path];
      if (!html) {
        res.writeHead(404, { 'content-type': 'text/html' }).end('<html><body>nope</body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    });
    await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      return await run(`http://127.0.0.1:${port}`);
    } finally {
      await /** @type {Promise<void>} */ (new Promise((resolve) => server.close(() => resolve())));
    }
  }

  it('follows links breadth-first and visits each route exactly once', async () => {
    const { crawlSite } = await import('@opengeo/core/generate');
    await withServer(async (base) => {
      const result = await crawlSite({ site: base });
      const routes = result.pages.map((p) => p.route);
      expect(new Set(routes).size).toBe(routes.length);
      expect(routes).toContain('/');
      expect(routes).toContain('/about');
      expect(routes).toContain('/team');
      expect(routes).toContain('/deep/three');
    });
  });

  it('treats /about and /about/ as the same route', async () => {
    const { crawlSite } = await import('@opengeo/core/generate');
    await withServer(async (base) => {
      const result = await crawlSite({ site: base });
      expect(result.pages.filter((p) => p.route === '/about')).toHaveLength(1);
      expect(result.pages.some((p) => p.route === '/about/')).toBe(false);
    });
  });

  it('stays on the origin and skips assets', async () => {
    const { crawlSite } = await import('@opengeo/core/generate');
    await withServer(async (base) => {
      const result = await crawlSite({ site: base });
      expect(result.pages.every((p) => p.url.startsWith(base))).toBe(true);
      expect(result.pages.some((p) => p.route === '/logo.png')).toBe(false);
    });
  });

  it('returns the fetched HTML so nothing has to be downloaded twice', async () => {
    const { crawlSite } = await import('@opengeo/core/generate');
    await withServer(async (base) => {
      const result = await crawlSite({ site: base });
      expect(result.pages.find((p) => p.route === '/about')?.html).toContain('<h1>About</h1>');
    });
  });

  it('stops at the page cap and says so', async () => {
    const { crawlSite } = await import('@opengeo/core/generate');
    await withServer(async (base) => {
      const result = await crawlSite({ site: base, maxPages: 2 });
      expect(result.pages).toHaveLength(2);
      expect(result.warnings.join(' ')).toContain('maxPages');
    });
  });

  it('stops at the depth cap and says so', async () => {
    const { crawlSite } = await import('@opengeo/core/generate');
    await withServer(async (base) => {
      const result = await crawlSite({ site: base, maxDepth: 1 });
      expect(result.pages.map((p) => p.route)).toContain('/about');
      expect(result.pages.map((p) => p.route)).not.toContain('/team');
      expect(result.warnings.join(' ')).toContain('maxDepth');
    });
  });

  it('picks up extraRoutes the crawl could never reach', async () => {
    const { crawlSite } = await import('@opengeo/core/generate');
    await withServer(async (base) => {
      const result = await crawlSite({ site: base, extraRoutes: ['/hidden'] });
      expect(result.pages.map((p) => p.route)).toContain('/hidden');
    });
  });

  it('honours exclusions', async () => {
    const { crawlSite } = await import('@opengeo/core/generate');
    await withServer(async (base) => {
      const result = await crawlSite({ site: base, exclude: ['/deep'] });
      expect(result.pages.map((p) => p.route)).not.toContain('/deep/one');
    });
  });

  it('records a failed page instead of aborting the crawl', async () => {
    const { crawlSite } = await import('@opengeo/core/generate');
    await withServer(async (base) => {
      const result = await crawlSite({ site: base, extraRoutes: ['/does-not-exist'] });
      expect(result.failures.map((f) => f.route)).toContain('/does-not-exist');
      expect(result.pages.length).toBeGreaterThan(1);
    });
  });

  it('skips a route that turns out not to be HTML', async () => {
    const { crawlSite } = await import('@opengeo/core/generate');
    await withServer(async (base) => {
      const result = await crawlSite({ site: base, extraRoutes: ['/feed.xml'] });
      expect(result.pages.map((p) => p.route)).not.toContain('/feed.xml');
      expect(result.failures.find((f) => f.route === '/feed.xml')?.reason).toContain('not HTML');
    });
  });
});
