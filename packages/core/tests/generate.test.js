import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '@opengso/core/shared';
import { generatePages, parseFrontmatter, readManifest, withFrontmatter } from '@opengso/core/generate';
/** @import { Server } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */
/** @import { LoadedConfig } from '@opengso/core/shared' */

/**
 * Generate is exercised against a real HTTP server rather than a stubbed fetch: it is a
 * fetch-parse-write pipeline, and stubbing the fetch would test almost none of it.
 */

/** @type {Record<string, string>} */
const PAGES = {
  '/': '<!doctype html><html><head><title>Home</title></head><body><main><h1>Home</h1><p>A small site used by the OpenGSO test suite. It links to the other two pages so the crawl has something real to follow.</p><a href="/about">About</a><a href="/resume">Resume</a></main></body></html>',
  '/about': '<!doctype html><html><head><title>About</title></head><body><main><h1>About</h1><p>Founded in 2019, three people, one office, and a stubbornly small dependency list that has stayed under ten packages for six years.</p></main></body></html>',
  '/resume': '<!doctype html><html><head><title>Resume</title></head><body><main><h1>Resume</h1><p>Shipped 4 projects in 2024. Contract signed 3 March 2024 for $12,500. Response times improved 42% year over year.</p></main></body></html>',
  // Not linked from the home page, so a crawl never reaches it; only a single-page run does.
  '/blog': '<!doctype html><html><head><title>Blog</title><link rel="canonical" href="/blog/"></head><body><main><h1>Blog</h1><p>Notes on building small, dependable tools, published whenever there is something worth writing down.</p></main></body></html>',
};

/** @type {Server} */
let server;
/** @type {string} */
let site;

/**
 * Stands in for the build-id, nonce and chunk-hash noise every framework injects. Changing it
 * simulates a redeploy in which not one word of the page changed.
 */
let buildId = 'build-1';

/** Paths that answer 503 for now, as a page does while its server restarts. */
const down = /** @type {Set<string>} */ (new Set());
/**
 * @param {string} html
 * @returns {string}
 */
function wrapper(html) {
  return html.replace('<body>', `<body><script src="/_next/static/${buildId}/main.js"></script>`);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (down.has(path) || down.has('*')) {
      res.writeHead(503, { 'content-type': 'text/plain' }).end('Service Unavailable');
      return;
    }
    const body = PAGES[path] === undefined ? undefined : wrapper(PAGES[path]);
    if (!body) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body>Not found</body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  site = `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`;
});

afterAll(async () => {
  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
});

/**
 * @returns {LoadedConfig}
 */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'opengso-gen-'));
  return { config: defaultConfig(site), root, exists: true };
}

describe('generatePages', () => {
  it('writes a twin per route, with frontmatter, into publicDir/md', async () => {
    const loaded = project();
    const result = await generatePages({ site, routes: ['/', '/about', '/resume'], loaded });

    expect(result.pages.map((p) => p.status)).toEqual(['written', 'written', 'written']);
    const file = join(loaded.root, 'public', 'md', 'resume.md');
    expect(existsSync(file)).toBe(true);

    const parsed = parseFrontmatter(readFileSync(file, 'utf8'));
    expect(parsed.data.title).toBe('Resume');
    expect(parsed.data.generated_by).toBe('opengso-free');
    expect(parsed.data.url).toBe(`${site}/resume`);
    expect(typeof parsed.data.tokens).toBe('number');
    expect(/** @type {number} */ (parsed.data.tokens)).toBeGreaterThan(0);
    expect(String(parsed.data.last_updated)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.body).toContain('$12,500');
  });

  it('puts the manifest in the internal directory, never in the web root', async () => {
    const loaded = project();
    await generatePages({ site, routes: ['/resume'], loaded });
    expect(existsSync(join(loaded.root, '.opengso', 'manifest.json'))).toBe(true);
    expect(existsSync(join(loaded.root, 'public', 'manifest.json'))).toBe(false);

    const manifest = readManifest(join(loaded.root, '.opengso'));
    expect(manifest.pages['/resume']?.file).toBe('md/resume.md');
    expect(manifest.pages['/resume']?.tier).toBe('free');
  });

  it('skips unchanged pages on a second run', async () => {
    const loaded = project();
    await generatePages({ site, routes: ['/', '/about'], loaded });
    const second = await generatePages({ site, routes: ['/', '/about'], loaded });
    expect(second.pages.map((p) => p.status)).toEqual(['cached', 'cached']);
    expect(second.pages[0]?.reason).toContain('unchanged');
  });

  it('leaves the manifest byte-identical when nothing changed', async () => {
    const loaded = project();
    await generatePages({ site, routes: ['/', '/about'], loaded });
    const path = join(loaded.root, '.opengso', 'manifest.json');
    const stamped = readFileSync(path, 'utf8').replace(/"generatedAt": "[^"]+"/, '"generatedAt": "2020-01-01T00:00:00.000Z"');
    writeFileSync(path, stamped, 'utf8');

    const second = await generatePages({ site, routes: ['/', '/about'], loaded });
    expect(second.pages.map((p) => p.status)).toEqual(['cached', 'cached']);
    expect(readFileSync(path, 'utf8')).toBe(stamped);

    const third = await generatePages({ site, routes: ['/', '/about'], loaded, force: true });
    expect(third.manifest.generatedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('regenerates everything when forced', async () => {
    const loaded = project();
    await generatePages({ site, routes: ['/resume'], loaded });
    const forced = await generatePages({ site, routes: ['/resume'], loaded, force: true });
    expect(forced.pages[0]?.status).toBe('written');
  });

  it('never overwrites a file the user marked as hand-written', async () => {
    const loaded = project();
    await generatePages({ site, routes: ['/resume'], loaded });
    const file = join(loaded.root, 'public', 'md', 'resume.md');
    writeFileSync(file, withFrontmatter({ title: 'Mine', url: `${site}/resume`, generated_by: 'manual' }, '# Hand written'), 'utf8');

    const second = await generatePages({ site, routes: ['/resume'], loaded });
    expect(second.pages[0]?.status).toBe('skipped-manual');
    expect(readFileSync(file, 'utf8')).toContain('# Hand written');

    const forced = await generatePages({ site, routes: ['/resume'], loaded, force: true });
    expect(forced.pages[0]?.status).toBe('written');
  });

  it('never overwrites a file in public/md/ that OpenGSO did not write', async () => {
    const loaded = project();
    await generatePages({ site, routes: ['/about', '/resume'], loaded });
    const file = join(loaded.root, 'public', 'md', 'about.md');
    writeFileSync(file, '# My notes\n\nNo frontmatter, so nothing says OpenGSO owns this.\n', 'utf8');

    const second = await generatePages({ site, routes: ['/about', '/resume'], loaded });
    const about = second.pages.find((page) => page.route === '/about');
    expect(about?.status).toBe('proposed');
    expect(about?.reason).toContain('md/about.md');
    expect(readFileSync(file, 'utf8')).toContain('# My notes');
    expect(parseFrontmatter(readFileSync(`${file}.opengso-proposed`, 'utf8')).data.generated_by).toBe('opengso-free');
    // The manifest is what prod serves from, and it must not vouch for a file OpenGSO did not write.
    expect(Object.keys(readManifest(join(loaded.root, '.opengso'), site).pages).sort()).toEqual(['/resume']);

    const forced = await generatePages({ site, routes: ['/about'], loaded, force: true });
    expect(forced.pages[0]?.status).toBe('written');
    expect(readFileSync(file, 'utf8')).not.toContain('# My notes');
  });

  it('treats frontmatter from another tool as not OpenGSO\'s either', async () => {
    const loaded = project();
    const file = join(loaded.root, 'public', 'md', 'resume.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, withFrontmatter({ title: 'Theirs', url: `${site}/resume`, generated_by: 'some-other-tool' }, '# Theirs'), 'utf8');
    const result = await generatePages({ site, routes: ['/resume'], loaded });
    expect(result.pages[0]?.status).toBe('proposed');
    expect(readFileSync(file, 'utf8')).toContain('# Theirs');
  });

  it('records a failed route without losing the twin it produced last time', async () => {
    const loaded = project();
    await generatePages({ site, routes: ['/resume'], loaded });
    const result = await generatePages({ site, routes: ['/resume', '/missing'], loaded });
    const missing = result.pages.find((p) => p.route === '/missing');
    expect(missing?.status).toBe('failed');
    expect(missing?.reason).toContain('404');
    expect(result.manifest.pages['/resume']).toBeDefined();
  });

  it('deduplicates and orders routes so the run is stable', async () => {
    const loaded = project();
    const result = await generatePages({ site, routes: ['/about', '/', '/about/', '/resume'], loaded });
    expect(result.pages.map((p) => p.route)).toEqual(['/', '/about', '/resume']);
  });

  it('reports progress per route, per phase', async () => {
    const loaded = project();
    /** @type {string[]} */
    const phases = [];
    await generatePages({ site, routes: ['/resume'], loaded, onProgress: (e) => phases.push(e.phase) });
    expect(phases).toEqual(['fetch', 'extract', 'write']);
  });

  it('hands the AI tier the algorithmic markdown and records which tier actually produced the file', async () => {
    const loaded = project();
    const result = await generatePages({
      site,
      routes: ['/resume'],
      loaded,
      tier: 'ai',
      enhance: async (input) => {
        expect(input.algorithmicMarkdown).toContain('$12,500');
        expect(input.html).toContain('<main>');
        return { markdown: `${input.algorithmicMarkdown}\n\nPolished.`, warnings: [], fellBack: false };
      },
    });
    expect(result.pages[0]?.tier).toBe('ai');
    const parsed = parseFrontmatter(readFileSync(join(loaded.root, 'public', 'md', 'resume.md'), 'utf8'));
    expect(parsed.data.generated_by).toBe('opengso-ai');
    expect(parsed.body).toContain('Polished.');
  });

  it('marks the file as free-tier when the AI output was rejected and the algorithmic one kept', async () => {
    const loaded = project();
    const result = await generatePages({
      site,
      routes: ['/resume'],
      loaded,
      tier: 'ai',
      enhance: async (input) => ({ markdown: input.algorithmicMarkdown, warnings: ['fidelity check failed'], fellBack: true }),
    });
    expect(result.pages[0]?.tier).toBe('free');
    expect(result.pages[0]?.warnings).toContain('fidelity check failed');
  });
});

describe('one bad page cannot take the run down with it', () => {
  // Thirty characters of Japanese percent-encode to 270 bytes, past the 255 most filesystems allow.
  const longRoute = `/${encodeURIComponent('日'.repeat(30))}`;
  // The extractor recurses per element and overflows somewhere past 2,000 levels.
  const deep = `<!doctype html><html><head><title>Deep</title></head><body><main>${'<div>'.repeat(4000)}deep${'</div>'.repeat(4000)}</main></body></html>`;

  it('fails the page whose twin cannot be written and finishes the rest', async () => {
    const loaded = project();
    const result = await generatePages({
      loaded,
      site,
      routes: ['/about', longRoute, '/resume'],
      sources: new Map([[longRoute, PAGES['/about']]]),
    });
    const status = Object.fromEntries(result.pages.map((page) => [page.route, page.status]));
    expect(status).toEqual({ '/about': 'written', [longRoute]: 'failed', '/resume': 'written' });
    expect(result.pages.find((page) => page.route === longRoute)?.reason).toBeTruthy();
    expect(Object.keys(readManifest(join(loaded.root, '.opengso'), site).pages).sort()).toEqual(['/about', '/resume']);
  });

  it('fails a page the extractor cannot handle and finishes the rest', async () => {
    const loaded = project();
    // Both pages are handed in rather than fetched. The deep parse holds the event loop for seconds,
    // and with the test server in this same process a concurrent fetch can time out behind it.
    const sources = new Map([['/deep', deep], ['/resume', PAGES['/resume']]]);
    const result = await generatePages({ loaded, site, routes: ['/deep', '/resume'], sources });
    expect(result.pages.find((page) => page.route === '/resume')?.status).toBe('written');
    expect(readManifest(join(loaded.root, '.opengso'), site).pages['/resume']).toBeDefined();
  }, 30_000);

  it('keeps going when the AI step throws instead of returning', async () => {
    const loaded = project();
    const result = await generatePages({
      loaded,
      site,
      tier: 'ai',
      routes: ['/about', '/resume'],
      // Handed in rather than fetched: on a slow runner the fetch itself failed first and the reason
      // read "fetch failed", which is a different failure from the one under test.
      sources: new Map([
        ['/about', PAGES['/about']],
        ['/resume', PAGES['/resume']],
      ]),
      enhance: async (input) => {
        if (input.url.endsWith('/about')) throw new Error('socket hang up');
        return { markdown: input.algorithmicMarkdown, warnings: [], fellBack: false };
      },
    });
    expect(result.pages.map((page) => page.status)).toEqual(['failed', 'written']);
    expect(result.pages[0]?.reason).toContain('socket hang up');
    expect(readManifest(join(loaded.root, '.opengso'), site).pages['/resume']).toBeDefined();
  });
});

describe('a manifest that cannot be read', () => {
  it('is reported, not silently treated as a first run', async () => {
    const loaded = project();
    mkdirSync(join(loaded.root, '.opengso'), { recursive: true });
    writeFileSync(join(loaded.root, '.opengso', 'manifest.json'), '{"version":1,"pages":{"/about":');
    const { generateSite } = await import('@opengso/core/generate');
    const result = await generateSite({ target: site, loaded });
    expect(result.warnings.some((warning) => warning.includes('manifest.json') && /could not be read/i.test(warning))).toBe(true);
    expect(Object.keys(readManifest(join(loaded.root, '.opengso'), site).pages)).toHaveLength(3);
  });
});

describe('generateSite', () => {
  it('crawls, writes a twin per page, and writes the three site files from the same crawl', async () => {
    const { generateSite } = await import('@opengso/core/generate');
    const loaded = project();
    const result = await generateSite({ target: site, loaded });

    expect(result.crawl?.pages.map((p) => p.route).sort()).toEqual(['/', '/about', '/resume']);
    expect(result.generate.pages.map((p) => p.status)).toEqual(['written', 'written', 'written']);
    expect(result.files.map((f) => f.name)).toEqual(['robots.txt', 'llms.txt', 'sitemap.xml']);

    const publicDir = join(loaded.root, 'public');
    expect(readFileSync(join(publicDir, 'llms.txt'), 'utf8')).toContain(`${site}/resume.md`);
    expect(readFileSync(join(publicDir, 'sitemap.xml'), 'utf8')).toContain(`<loc>${site}/resume</loc>`);
    expect(readFileSync(join(publicDir, 'robots.txt'), 'utf8')).toContain(`Sitemap: ${site}/sitemap.xml`);
  });

  it('does not fetch a page twice: the crawl HTML is reused by the generator', async () => {
    const { generateSite } = await import('@opengso/core/generate');
    const loaded = project();
    /** @type {string[]} */
    const phases = [];
    await generateSite({
      target: site,
      loaded,
      onProgress: (event) => {
        if (event.phase === 'generate') phases.push(event.generate.phase);
      },
    });
    expect(phases).not.toContain('fetch');
  });

  it('reports every page as cached on an unchanged second run', async () => {
    const { generateSite } = await import('@opengso/core/generate');
    const loaded = project();
    await generateSite({ target: site, loaded });
    const second = await generateSite({ target: site, loaded });
    expect(second.generate.pages.every((p) => p.status === 'cached')).toBe(true);
    expect(second.files.every((f) => f.status === 'unchanged')).toBe(true);
  });

  it('still describes the whole site when only one page is regenerated', async () => {
    const { generateSite } = await import('@opengso/core/generate');
    const loaded = project();
    await generateSite({ target: site, loaded });
    const single = await generateSite({ target: `${site}/resume`, loaded, single: true, force: true });

    expect(single.crawl).toBeUndefined();
    expect(single.generate.pages.map((p) => p.route)).toEqual(['/resume']);
    // The other two must survive in the manifest, or prod would stop serving them at the next boot.
    expect(Object.keys(single.generate.manifest.pages).sort()).toEqual(['/', '/about', '/resume']);
    expect(readFileSync(join(loaded.root, 'public', 'llms.txt'), 'utf8')).toContain(`${site}/about.md`);
  });

  it('surfaces a crawl failure as a warning rather than failing the run', async () => {
    const { generateSite } = await import('@opengso/core/generate');
    const loaded = project();
    loaded.config.extraRoutes = ['/nope'];
    const result = await generateSite({ target: site, loaded });
    expect(result.warnings.join(' ')).toContain('/nope');
    expect(result.generate.pages.some((p) => p.status === 'written')).toBe(true);
  });

  it('never writes outside the twin directory for a route with dot segments', async () => {
    const { generateSite } = await import('@opengso/core/generate');
    const loaded = project();
    // Fetched as /resume, because the URL parser resolves the dots. The route kept them, and the
    // twin was written to <root>/resume.md, outside public/.
    loaded.config.extraRoutes = ['/../../resume'];
    const result = await generateSite({ target: site, loaded });
    expect(existsSync(join(loaded.root, 'resume.md'))).toBe(false);
    expect(result.warnings.join(' ')).toContain('/../../resume');
    expect(Object.keys(result.generate.manifest.pages).some((route) => route.includes('..'))).toBe(false);
  });

  it('refuses a dot-segment route handed to generatePages directly', async () => {
    const loaded = project();
    // A page that exists, so the fetch succeeds and only the write is left to stop it.
    const result = await generatePages({ loaded, routes: ['/x/../../../resume', '/resume'], site });
    const escaped = result.pages.find((page) => page.route.includes('..'));
    expect(escaped?.status).toBe('failed');
    expect(existsSync(join(loaded.root, 'resume.md'))).toBe(false);
    expect(result.pages.find((page) => page.route === '/resume')?.status).toBe('written');
  });

  it('keeps a page it could not fetch this time in the manifest and the sitemap', async () => {
    const { generateSite } = await import('@opengso/core/generate');
    const loaded = project();
    await generateSite({ target: site, loaded });
    down.add('/about');
    try {
      const second = await generateSite({ target: site, loaded });
      expect(Object.keys(second.generate.manifest.pages).sort()).toEqual(['/', '/about', '/resume']);
      expect(readFileSync(join(loaded.root, 'public', 'sitemap.xml'), 'utf8')).toContain(`${site}/about`);
      expect(second.warnings.join(' ')).toContain('/about');
    } finally {
      down.clear();
    }
  });

  it('keeps the whole manifest when the site cannot be reached at all', async () => {
    const { generateSite } = await import('@opengso/core/generate');
    const loaded = project();
    await generateSite({ target: site, loaded });
    down.add('*');
    try {
      const second = await generateSite({ target: site, loaded });
      // prod serves from the manifest, so shrinking it here would un-serve every twin.
      expect(Object.keys(second.generate.manifest.pages).sort()).toEqual(['/', '/about', '/resume']);
      expect(readManifest(join(loaded.root, '.opengso'), site).pages['/resume']).toBeDefined();
      expect(second.warnings.join(' ')).toMatch(/kept/i);
    } finally {
      down.clear();
    }
  });

  it('writes nothing at all on a first run that cannot reach the site', async () => {
    const { generateSite } = await import('@opengso/core/generate');
    const loaded = project();
    down.add('*');
    try {
      const result = await generateSite({ target: site, loaded });
      expect(result.generate.pages.map((page) => page.status)).toEqual(['failed']);
      expect(result.files).toEqual([]);
      expect(result.warnings).toEqual([`Could not fetch ${site} (HTTP 503), so nothing was written. Start the site, with \`npm run dev\` or however you run it, and run generate again.`]);
      // An empty llms.txt and sitemap.xml, or a manifest with no page in it, would say the site was
      // generated when all the run learned is that its server is down.
      expect(existsSync(join(loaded.root, 'public'))).toBe(false);
      expect(existsSync(join(loaded.root, '.opengso', 'manifest.json'))).toBe(false);
    } finally {
      down.clear();
    }
  });

  it('stops part way when abandoned, and keeps every twin the manifest already vouched for', async () => {
    const { generateSite } = await import('@opengso/core/generate');
    const loaded = project();
    await generateSite({ target: site, loaded, force: true });
    const controller = new AbortController();
    /** @type {string[]} */
    const written = [];
    const run = generateSite({
      target: site,
      loaded,
      force: true,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.phase !== 'generate' || event.generate.phase !== 'write') return;
        written.push(event.generate.route);
        controller.abort();
      },
    });
    await expect(run).rejects.toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(written).toHaveLength(1);
    // prod serves from the manifest, so a run nobody is watching any more must not shrink it.
    expect(Object.keys(readManifest(join(loaded.root, '.opengso'), site).pages).sort()).toEqual(['/', '/about', '/resume']);
  });

  it('writes nothing when abandoned during the crawl', async () => {
    const { generateSite } = await import('@opengso/core/generate');
    const loaded = project();
    const controller = new AbortController();
    const run = generateSite({
      target: site,
      loaded,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.phase === 'crawl') controller.abort();
      },
    });
    await expect(run).rejects.toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(existsSync(join(loaded.root, '.opengso', 'manifest.json'))).toBe(false);
    expect(existsSync(join(loaded.root, 'public'))).toBe(false);
  });

  it('lists the canonical URL a page declares in sitemap.xml', async () => {
    const { generateSite } = await import('@opengso/core/generate');
    const loaded = project();
    const result = await generateSite({ target: `${site}/blog`, loaded, single: true });
    expect(result.generate.manifest.pages['/blog']?.canonical).toBe(`${site}/blog/`);
    const xml = readFileSync(join(loaded.root, 'public', 'sitemap.xml'), 'utf8');
    expect(xml).toContain(`<loc>${site}/blog/</loc>`);
    expect(xml).not.toContain(`<loc>${site}/blog</loc>`);
  });

  it('dates sitemap entries by what the page declares, not by when generate ran', async () => {
    const loaded = project();
    const dated = PAGES['/about']?.replace('</head>', '<meta property="article:modified_time" content="2023-09-10"></head>') ?? '';
    const result = await generatePages({ site, routes: ['/about', '/resume'], loaded, sources: new Map([['/about', dated]]) });
    expect(result.manifest.pages['/about']?.lastModified).toBe('2023-09-10');
    expect(result.manifest.pages['/resume']?.lastModified).toBeUndefined();

    const { generateSite } = await import('@opengso/core/generate');
    await generateSite({ target: `${site}/resume`, loaded, single: true });
    const xml = readFileSync(join(loaded.root, 'public', 'sitemap.xml'), 'utf8');
    expect(xml.match(/<lastmod>[^<]*<\/lastmod>/g)).toEqual(['<lastmod>2023-09-10</lastmod>']);
  });

  it('leaves the site files alone when asked for twins only', async () => {
    const { generateSite } = await import('@opengso/core/generate');
    const loaded = project();
    const result = await generateSite({ target: site, loaded, skipSiteFiles: true });
    expect(result.files).toEqual([]);
    expect(existsSync(join(loaded.root, 'public', 'llms.txt'))).toBe(false);
  });
});

describe('twins whose page the crawl no longer reaches', () => {
  /**
   * A first run that also covers /blog, which nothing links to, then a run that no longer lists it:
   * the same thing a page deleted from the site, or unlinked from it, looks like to generate.
   */
  async function orphanBlog() {
    const { generateSite } = await import('@opengso/core/generate');
    const loaded = project();
    loaded.config.extraRoutes = ['/blog'];
    await generateSite({ target: site, loaded });
    loaded.config.extraRoutes = [];
    return { generateSite, loaded, blog: join(loaded.root, 'public', 'md', 'blog.md') };
  }

  it('reports the orphan on every run and deletes nothing unless asked', async () => {
    const { generateSite, loaded, blog } = await orphanBlog();
    const second = await generateSite({ target: site, loaded });
    expect(second.generate.orphans).toEqual([{ route: '/blog', url: `${site}/blog`, file: 'md/blog.md' }]);
    expect(second.generate.pruned).toEqual([]);
    expect(existsSync(blog)).toBe(true);
    expect(second.generate.manifest.pages['/blog']).toBeUndefined();

    // Reported once and then forgotten would make --prune useless on the run after.
    const third = await generateSite({ target: site, loaded });
    expect(third.generate.orphans.map((o) => o.route)).toEqual(['/blog']);
  });

  it('deletes only orphaned files OpenGSO wrote when asked to prune', async () => {
    const { generateSite, loaded, blog } = await orphanBlog();
    const handWritten = join(loaded.root, 'public', 'md', 'notes.md');
    writeFileSync(handWritten, '# Notes\n\nWritten by hand, listed nowhere.\n');

    const result = await generateSite({ target: site, loaded, prune: true });
    expect(result.generate.pruned.map((o) => o.route)).toEqual(['/blog']);
    expect(result.generate.orphans).toEqual([]);
    expect(existsSync(blog)).toBe(false);
    expect(existsSync(handWritten)).toBe(true);
    expect(existsSync(join(loaded.root, 'public', 'md', 'about.md'))).toBe(true);
    expect(readManifest(join(loaded.root, '.opengso'), site).orphans).toBeUndefined();
  });

  it('never prunes a twin someone has since made their own', async () => {
    const { generateSite, loaded, blog } = await orphanBlog();
    writeFileSync(blog, '---\ntitle: Blog\ngenerated_by: manual\n---\n\n# Blog\n\nKept by hand.\n');
    const result = await generateSite({ target: site, loaded, prune: true });
    expect(existsSync(blog)).toBe(true);
    expect(result.generate.pruned).toEqual([]);
    expect(result.generate.orphans).toEqual([]);
  });

  it('never prunes on a run that reached no page', async () => {
    const { generateSite, loaded, blog } = await orphanBlog();
    await generateSite({ target: site, loaded });
    down.add('*');
    try {
      const result = await generateSite({ target: site, loaded, prune: true });
      expect(existsSync(blog)).toBe(true);
      expect(result.generate.pruned).toEqual([]);
      expect(result.warnings.join(' ')).toMatch(/nothing was pruned/i);
    } finally {
      down.clear();
    }
  });

  it('never prunes when the crawl stopped at a cap', async () => {
    const { generateSite, loaded } = await orphanBlog();
    const result = await generateSite({ target: site, loaded, prune: true, maxPages: 1 });
    // About and resume exist; the crawl just did not get to them.
    expect(existsSync(join(loaded.root, 'public', 'md', 'about.md'))).toBe(true);
    expect(result.generate.pruned).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/nothing was pruned/i);
  });
});

describe('hashing what a reader receives, not the markup around it', () => {
  it('still reports cached after a redeploy that only changed the build id', async () => {
    const loaded = project();
    const first = await generatePages({ site, routes: ['/resume'], loaded });
    expect(first.pages[0]?.status).toBe('written');

    buildId = 'build-2';
    try {
      const second = await generatePages({ site, routes: ['/resume'], loaded });
      expect(second.pages[0]?.status).toBe('cached');
    } finally {
      buildId = 'build-1';
    }
  });

  it('regenerates when only the meta description or the head title changed', async () => {
    const loaded = project();
    /** @param {string} title @param {string} description */
    const html = (title, description) =>
      `<!doctype html><html><head><title>${title}</title><meta name="description" content="${description}"></head><body><main><p>${PAGES['/about']?.match(/<p>(.*?)<\/p>/)?.[1]}</p></main></body></html>`;
    await generatePages({ site, routes: ['/about'], loaded, sources: new Map([['/about', html('About', 'Old summary.')]]) });

    const described = await generatePages({ site, routes: ['/about'], loaded, sources: new Map([['/about', html('About', 'New summary.')]]) });
    expect(described.pages[0]?.status).toBe('written');
    const file = join(loaded.root, 'public', 'md', 'about.md');
    expect(parseFrontmatter(readFileSync(file, 'utf8')).data.description).toBe('New summary.');
    expect(described.manifest.pages['/about']?.description).toBe('New summary.');

    const retitled = await generatePages({ site, routes: ['/about'], loaded, sources: new Map([['/about', html('About us', 'New summary.')]]) });
    expect(retitled.pages[0]?.status).toBe('written');
    expect(retitled.manifest.pages['/about']?.title).toBe('About us');
  });

  it('records no source hash for a hand-written twin, rather than inventing one', async () => {
    const loaded = project();
    const file = join(loaded.root, 'public', 'md', 'resume.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, withFrontmatter({ title: 'Resume', generated_by: 'manual' }, '# Resume\n\nBy hand.'), 'utf8');

    const result = await generatePages({ site, routes: ['/resume'], loaded });
    expect(result.pages[0]?.status).toBe('skipped-manual');
    expect(result.manifest.pages['/resume']?.sourceHash).toBeUndefined();
  });
});
