import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, type LoadedConfig } from '@opengeo/core/shared';
import { generatePages, parseFrontmatter, readManifest, withFrontmatter } from '@opengeo/core/generate';

/**
 * Generate is exercised against a real HTTP server rather than a stubbed fetch: it is a
 * fetch-parse-write pipeline, and stubbing the fetch would test almost none of it.
 */

const PAGES: Record<string, string> = {
  '/': '<!doctype html><html><head><title>Home</title></head><body><main><h1>Home</h1><p>A small site used by the OpenGEO test suite. It links to the other two pages so the crawl has something real to follow.</p><a href="/about">About</a><a href="/resume">Resume</a></main></body></html>',
  '/about': '<!doctype html><html><head><title>About</title></head><body><main><h1>About</h1><p>Founded in 2019, three people, one office, and a stubbornly small dependency list that has stayed under ten packages for six years.</p></main></body></html>',
  '/resume': '<!doctype html><html><head><title>Resume</title></head><body><main><h1>Resume</h1><p>Shipped 4 projects in 2024. Contract signed 3 March 2024 for $12,500. Response times improved 42% year over year.</p></main></body></html>',
};

let server: Server;
let site: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const body = PAGES[path];
    if (!body) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body>Not found</body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

function project(): LoadedConfig {
  const root = mkdtempSync(join(tmpdir(), 'opengeo-gen-'));
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
    expect(parsed.data.generated_by).toBe('opengeo-free');
    expect(parsed.data.url).toBe(`${site}/resume`);
    expect(typeof parsed.data.tokens).toBe('number');
    expect(parsed.data.tokens as number).toBeGreaterThan(0);
    expect(String(parsed.data.last_updated)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.body).toContain('$12,500');
  });

  it('puts the manifest in the internal directory, never in the web root', async () => {
    const loaded = project();
    await generatePages({ site, routes: ['/resume'], loaded });
    expect(existsSync(join(loaded.root, '.opengeo', 'manifest.json'))).toBe(true);
    expect(existsSync(join(loaded.root, 'public', 'manifest.json'))).toBe(false);

    const manifest = readManifest(join(loaded.root, '.opengeo'));
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
    const phases: string[] = [];
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
    expect(parsed.data.generated_by).toBe('opengeo-ai');
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
