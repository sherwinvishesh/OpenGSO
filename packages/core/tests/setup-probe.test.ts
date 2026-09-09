import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectWebRoot, previewLines, previewSite, type SitePreview } from '../src/cli/setup-probe.js';
import { stripAnsi } from '../src/cli/tui/paint.js';
import { BROWSER_UA, type ProbeOptions, type ProbeResult } from '../src/shared/http.js';
import { HEADERS } from '../src/shared/version.js';

/**
 * The two questions setup answers for itself, and the sentences it says about the answers.
 *
 * Everything here is offline. `previewSite` takes its fetcher as an option for exactly this reason:
 * a setup diagnostic that could only be tested against a live server would never be tested.
 */

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
  ttfbMs?: number;
}

/** A `probe` that answers from a map of URL to reply, and records how it was called. */
function fakeProbe(replies: Record<string, Reply>) {
  const calls: Array<{ url: string; options: ProbeOptions }> = [];
  const fetchPage = async (url: string, options: ProbeOptions = {}): Promise<ProbeResult> => {
    calls.push({ url, options });
    const reply = replies[url] ?? { status: 404 };
    const status = reply.status ?? 200;
    return {
      url,
      ok: !reply.error && status >= 200 && status < 300,
      status: reply.error ? 0 : status,
      headers: new Headers(reply.headers ?? {}),
      body: reply.body ?? '',
      ttfbMs: reply.ttfbMs ?? 12,
      totalMs: reply.ttfbMs ?? 12,
      redirected: false,
      finalUrl: url,
      ...(reply.error ? { error: reply.error } : {}),
    };
  };
  return { fetchPage, calls };
}

const SITE = 'http://localhost:3000/pricing';
const TWIN = 'http://localhost:3000/pricing.md';

describe('previewSite', () => {
  it('asks as a browser, because what a browser is served is the question', async () => {
    const { fetchPage, calls } = fakeProbe({ [SITE]: { body: '<h1>Pricing</h1>' } });

    await previewSite(SITE, { fetchPage });

    expect(calls[0]?.options.headers?.['User-Agent']).toBe(BROWSER_UA);
  });

  it('reports the status and the time to first byte', async () => {
    const { fetchPage } = fakeProbe({ [SITE]: { status: 200, ttfbMs: 87, body: '<h1>Pricing</h1>' } });

    const preview = await previewSite(SITE, { fetchPage });

    expect(preview).toMatchObject({ url: SITE, ok: true, status: 200, ttfbMs: 87 });
  });

  it('carries a connection failure through instead of throwing', async () => {
    const { fetchPage } = fakeProbe({ [SITE]: { error: 'connect ECONNREFUSED 127.0.0.1:3000' } });

    const preview = await previewSite(SITE, { fetchPage });

    expect(preview.ok).toBe(false);
    expect(preview.error).toContain('ECONNREFUSED');
    // Nothing else was probed: there is no point asking about a twin of a site that is not up.
    expect(preview.twin).toBeUndefined();
  });

  it('names the framework from the header before it looks at the markup', async () => {
    const { fetchPage } = fakeProbe({ [SITE]: { headers: { 'x-powered-by': 'Next.js' }, body: '<div>plain</div>' } });

    expect((await previewSite(SITE, { fetchPage })).framework).toBe('Next.js');
  });

  it('names the framework from the markup when there is no header', async () => {
    const cases: Array<[string, string]> = [
      ['Next.js', '<script id="__NEXT_DATA__">{}</script>'],
      ['Nuxt', '<script>window.__NUXT__={}</script>'],
      ['SvelteKit', '<link href="/_app/immutable/x.js">'],
      ['Astro', '<astro-island></astro-island>'],
      ['Gatsby', '<div id="___gatsby"></div>'],
      ['Docusaurus', '<div id="__docusaurus"></div>'],
      ['WordPress', '<link href="/wp-content/themes/x.css">'],
    ];
    for (const [name, body] of cases) {
      const { fetchPage } = fakeProbe({ [SITE]: { body } });
      expect((await previewSite(SITE, { fetchPage })).framework, name).toBe(name);
    }
  });

  it('leaves the framework unset rather than guessing', async () => {
    const { fetchPage } = fakeProbe({ [SITE]: { body: '<html><body><h1>Hand written</h1></body></html>' } });

    expect((await previewSite(SITE, { fetchPage })).framework).toBeUndefined();
  });

  it('flags an empty mount element, which is the shape generate cannot read', async () => {
    const { fetchPage } = fakeProbe({ [SITE]: { body: '<body><div id="root"></div><script src="/app.js"></script></body>' } });

    expect((await previewSite(SITE, { fetchPage })).clientRendered).toBe(true);
  });

  it('does not flag a page whose mount element has content in it', async () => {
    const { fetchPage } = fakeProbe({ [SITE]: { body: '<div id="root"><h1>Pricing</h1><p>From $9.</p></div>' } });

    expect((await previewSite(SITE, { fetchPage })).clientRendered).toBeUndefined();
  });

  it('head-probes the twin rather than downloading a document nobody asked for', async () => {
    const { fetchPage, calls } = fakeProbe({ [SITE]: { body: '<h1>Pricing</h1>' }, [TWIN]: { body: '# Pricing' } });

    await previewSite(SITE, { fetchPage });

    const twinCall = calls.find((call) => call.url === TWIN);
    expect(twinCall?.options.headOnly).toBe(true);
  });

  it('tells a twin served by opengeo-prod apart from one that merely answers', async () => {
    const served = fakeProbe({
      [SITE]: { body: '<h1>Pricing</h1>' },
      [TWIN]: { headers: { [HEADERS.aeoVersion]: '1' } },
    });
    const foreign = fakeProbe({ [SITE]: { body: '<h1>Pricing</h1>' }, [TWIN]: {} });

    expect((await previewSite(SITE, { fetchPage: served.fetchPage })).twin).toMatchObject({ ok: true, served: true });
    expect((await previewSite(SITE, { fetchPage: foreign.fetchPage })).twin).toMatchObject({ ok: true, served: false });
  });

  it('reports no twin as a fact, not a failure', async () => {
    const { fetchPage } = fakeProbe({ [SITE]: { body: '<h1>Pricing</h1>' } });

    expect((await previewSite(SITE, { fetchPage })).twin).toMatchObject({ url: TWIN, ok: false, served: false });
  });
});

describe('previewLines', () => {
  const say = (preview: SitePreview) => previewLines(preview).map(stripAnsi).join('\n');

  it('says setup carries on when the site is unreachable', () => {
    const text = say({ url: SITE, ok: false, status: 0, ttfbMs: 0, error: 'ECONNREFUSED' });

    expect(text).toContain('Could not reach');
    expect(text).toContain('nothing here is a blocker');
  });

  it('quotes the status when the site answers with one', () => {
    expect(say({ url: SITE, ok: false, status: 502, ttfbMs: 40 })).toContain('answered 502');
  });

  it('puts the framework and the timing in the reachable line', () => {
    const text = say({ url: SITE, ok: true, status: 200, ttfbMs: 87, framework: 'Next.js', twin: { url: TWIN, ok: false, status: 404, served: false } });

    expect(text).toContain('Reachable');
    expect(text).toContain('200 in 87ms');
    expect(text).toContain('Next.js');
  });

  it('explains what a client-rendered page costs, in the terms generate will use', () => {
    const text = say({ url: SITE, ok: true, status: 200, ttfbMs: 20, clientRendered: true, twin: { url: TWIN, ok: false, status: 404, served: false } });

    expect(text).toContain('empty mount element');
    expect(text).toContain('Server-rendering is the fix');
  });

  it('names opengeo-prod when the twin is already being served by it', () => {
    const text = say({ url: SITE, ok: true, status: 200, ttfbMs: 20, twin: { url: TWIN, ok: true, status: 200, served: true } });

    expect(text).toContain('markdown twin is already being served');
    expect(text).toContain('opengeo-prod');
  });

  it('points a missing twin at the two commands that create one', () => {
    const text = say({ url: SITE, ok: true, status: 200, ttfbMs: 20, twin: { url: TWIN, ok: false, status: 404, served: false } });

    expect(text).toContain('No twin at');
    expect(text).toContain('generate and prod');
  });
});

describe('detectWebRoot', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opengeo-webroot-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const pkg = (deps: Record<string, string>) => writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: deps }), 'utf8');

  it('reads the convention off the framework in package.json', () => {
    pkg({ next: '15.0.0' });

    expect(detectWebRoot(root)).toMatchObject({ dir: 'public', found: true });
    expect(detectWebRoot(root).why).toContain('Next.js');
  });

  it('knows the frameworks that serve static/ rather than public/', () => {
    for (const [dep, dir] of [['gatsby', 'static'], ['@sveltejs/kit', 'static'], ['@docusaurus/core', 'static'], ['nuxt', 'public']] as const) {
      pkg({ [dep]: '1.0.0' });
      expect(detectWebRoot(root).dir, dep).toBe(dir);
    }
  });

  it('finds a devDependency too, which is where most of these actually live', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { astro: '4.0.0' } }), 'utf8');

    expect(detectWebRoot(root)).toMatchObject({ dir: 'public', found: true });
  });

  it('falls back to what is on disk when package.json says nothing', () => {
    pkg({ express: '4.0.0' });
    mkdirSync(join(root, 'static'));

    expect(detectWebRoot(root)).toMatchObject({ dir: 'static', found: true });
  });

  it('prefers the dependency to the directory, because one is a decision and one is a coincidence', () => {
    pkg({ next: '15.0.0' });
    mkdirSync(join(root, 'static'));

    expect(detectWebRoot(root).dir).toBe('public');
  });

  it('warns about dist/, because a build wipes it', () => {
    mkdirSync(join(root, 'dist'));

    const guess = detectWebRoot(root);
    expect(guess.dir).toBe('dist');
    expect(guess.why).toContain('build output');
  });

  it('survives a package.json that does not parse', () => {
    writeFileSync(join(root, 'package.json'), '{ not json', 'utf8');
    mkdirSync(join(root, 'public'));

    expect(detectWebRoot(root)).toMatchObject({ dir: 'public', found: true });
  });

  it('says so when nothing pointed anywhere, rather than pretending it detected something', () => {
    const guess = detectWebRoot(root);

    expect(guess.found).toBe(false);
    expect(guess.dir).toBe('public');
  });
});
