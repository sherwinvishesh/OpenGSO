import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseRobots, robotsAllows } from '../src/shared/robots.js';
import { summarizeRobots } from '../src/prod/startup.js';
import { discoverTwins, renderReport, scoreChecks, scoreGain, sitemapTwins, testUrl } from '@omnigeo/core/test';
/** @import { IncomingMessage, Server, ServerResponse } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */
/** @import { TestResult } from '@omnigeo/core/test' */

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

describe('a site with no twin', () => {
  /** @type {Record<string, string>} */
  let extra = {};

  beforeEach(() => {
    extra = {};
    handler = (_req, res, path) => {
      if (path !== '/docs/page') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...extra });
      res.end(PAGE);
    };
  });

  it('does not lose points for a header that only half-applies without a twin', async () => {
    const bare = await testUrl(`${site}/docs/page`);
    extra = { vary: 'Accept', link: '</feed.xml>; rel="alternate"; type="application/rss+xml"' };
    const withHeaders = await testUrl(`${site}/docs/page`);
    expect(check(withHeaders, 'B7').status).toBe('locked');
    expect(check(withHeaders, 'B8').status).toBe('locked');
    expect(withHeaders.score.value).toBe(bare.score.value);
  });
});

describe('robots.txt, read for the path under test', () => {
  let robots = '';

  beforeEach(() => {
    robots = '';
    handler = (_req, res, path) => {
      if (path === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(robots);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    };
  });

  it('fails A1 when a directory rule covers the page, not only `Disallow: /`', async () => {
    robots = 'User-agent: OAI-SearchBot\nDisallow: /docs/\n';
    const a1 = check(await testUrl(`${site}/docs/page`), 'A1');
    expect(a1.status).toBe('fail');
    expect(a1.reason).toContain('OAI-SearchBot');
    expect(a1.reason).toContain('/docs/page');
  });

  it('passes A1 when the rule covers some other path', async () => {
    robots = 'User-agent: OAI-SearchBot\nDisallow: /private/\n';
    expect(check(await testUrl(`${site}/docs/page`), 'A1').status).toBe('pass');
  });

  it('lets a longer Allow win over a shorter Disallow', async () => {
    robots = 'User-agent: *\nDisallow: /\nAllow: /docs/\n';
    expect(check(await testUrl(`${site}/docs/page`), 'A1').status).toBe('pass');
  });
});

describe('robotsAllows', () => {
  /**
   * @param {string} rules
   * @param {string} path
   */
  const allows = (rules, path) => robotsAllows(parseRobots(`User-agent: *\n${rules}`).get('*') ?? [], path);

  it('uses the longest matching rule, and Allow on a tie', () => {
    expect(allows('Disallow: /docs/', '/docs/page')).toBe(false);
    expect(allows('Disallow: /docs/\nAllow: /docs/page', '/docs/page')).toBe(true);
    expect(allows('Disallow: /\nAllow: /', '/anything')).toBe(true);
    expect(allows('Disallow:', '/anything')).toBe(true);
  });

  it('understands * and $', () => {
    expect(allows('Disallow: /*.pdf$', '/files/a.pdf')).toBe(false);
    expect(allows('Disallow: /*.pdf$', '/files/a.pdf.html')).toBe(true);
    expect(allows('Disallow: /*/drafts', '/blog/drafts/one')).toBe(false);
  });

  it('is what the prod startup summary reads, so an Allow is honoured there too', () => {
    const summary = summarizeRobots('User-agent: GPTBot\nDisallow: /\nAllow: /\n', [
      { name: 'GPTBot', vendor: 'OpenAI', uaPatterns: ['GPTBot'], robotsToken: 'GPTBot', kind: 'training' },
    ]);
    expect(summary.blocked).toEqual([]);
  });
});

describe('fix prices, in the headline\'s unit', () => {
  beforeEach(() => {
    handler = (_req, res, path) => {
      if (path === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('User-agent: *\nAllow: /\n');
        return;
      }
      res.writeHead(path === '/docs/page' ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    };
  });

  it('prices each fix as the change it makes to the 0-100 score, not as its check weight', async () => {
    const result = await testUrl(`${site}/docs/page`);
    const priced = result.checks.filter((entry) => entry.scored && (entry.status === 'fail' || entry.status === 'partial') && entry.fix);
    expect(priced.length).toBeGreaterThan(0);
    for (const entry of priced) {
      const fixed = result.checks.map((other) => (other.id === entry.id ? { ...other, status: /** @type {const} */ ('pass'), earned: other.weight } : other));
      const moved = Math.max(1, scoreChecks(fixed).value - result.score.value);
      expect(entry.fix, entry.id).toContain(`(+${moved})`);
      expect(entry.fix, entry.id).not.toMatch(/\(\+0\)/);
    }
  });

  it('drops the price from a locked check, whose points only exist once its blocker passes', async () => {
    const result = await testUrl(`${site}/docs/page`);
    for (const entry of result.checks.filter((other) => other.status === 'locked')) {
      expect(entry.fix ?? '', entry.id).not.toMatch(/\(\+\d+\)/);
    }
  });

  it('drops the price from a suggestion, since adopting one moves no score', async () => {
    const result = await testUrl(`${site}/docs/page`);
    const suggestions = result.checks.filter((entry) => !entry.scored && entry.fix);
    expect(suggestions.length).toBeGreaterThan(0);
    for (const entry of suggestions) {
      expect(entry.fix ?? '', entry.id).not.toMatch(/\(\+\d+\)/);
      expect(entry.price, entry.id).toBeUndefined();
    }
  });

  it('ranks the next steps in score points, and lists B1 as a suggestion rather than selling it as points', async () => {
    const result = await testUrl(`${site}/docs/page`);
    const report = renderReport(result);
    const top = scoreGain(result.score, 9);
    expect(report).toMatch(new RegExp(`\\+${top}\\s+A3`));
    expect(report).toMatch(/tip\s+B1/);
    expect(report).not.toMatch(/\+\d+\s+B1/);
    expect(result.score.value + top).toBeLessThanOrEqual(100);
  });
});

describe('markdown reached by redirect rather than rewrite', () => {
  beforeEach(() => {
    handler = (req, res, path) => {
      if (path === '/docs/page.md') {
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
        res.end('# Docs');
        return;
      }
      const wantsMarkdown = (req.headers.accept ?? '').includes('text/markdown') || /GPTBot/.test(req.headers['user-agent'] ?? '');
      if (path === '/docs/page' && wantsMarkdown) {
        res.writeHead(302, { location: '/docs/page.md' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    };
  });

  it('does not pass B9 or B10, and does not claim the same URL', async () => {
    const result = await testUrl(`${site}/docs/page`);
    for (const id of ['B9', 'B10']) {
      const found = check(result, id);
      expect(found.status, id).not.toBe('pass');
      expect(found.reason, id).toContain('redirect');
      expect(found.reason, id).not.toContain('at the same URL');
    }
  });
});
