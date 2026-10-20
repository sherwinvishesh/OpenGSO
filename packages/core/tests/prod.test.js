import { describe, expect, it } from 'vitest';
import {
  AEO_SPEC_VERSION,
  AI_BOTS,
  DEFAULT_MARKDOWN_ROUTING,
  HEADERS,
  MARKDOWN_CONTENT_TYPE,
  classify,
  createManifestStore,
  createMemoryStore,
  entityTag,
  handleRequest,
  htmlHeaders,
  identifyBot,
  isNotModified,
  markdownHeaders,
  parseLinkAlternate,
  resolveBots,
  summarizeAccept,
} from '@opengso/core/prod';

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const GPTBOT = 'Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2; +https://openai.com/gptbot)';

const store = createMemoryStore([
  {
    route: '/resume',
    title: 'Resume',
    body: '# Resume\n\nShipped 4 projects in 2024.',
    tokens: 12,
    lastUpdated: '2026-01-01T00:00:00.000Z',
    sourceHash: 'abc123abc123abc1',
  },
]);

/**
 * @param {string} path
 * @param {Record<string, string>} [headers]
 * @param {string} [method]
 */
function request(path, headers = {}, method = 'GET') {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    url: `http://localhost:3000${path}`,
    method,
    headers: { get: /** @param {string} name */ (name) => lower.get(name.toLowerCase()) ?? null },
  };
}

const ctx = { store, markdownRouting: DEFAULT_MARKDOWN_ROUTING };

describe('header contract (§7)', () => {
  it('markdown responses carry the full set', () => {
    const headers = markdownHeaders({ tokens: 120 });
    expect(headers[HEADERS.contentType]).toBe(MARKDOWN_CONTENT_TYPE);
    expect(headers[HEADERS.markdownTokens]).toBe('120');
    expect(headers[HEADERS.contentTypeOptions]).toBe('nosniff');
    expect(headers[HEADERS.robotsTag]).toBe('noindex');
    expect(headers[HEADERS.vary]).toBe('Accept');
    expect(headers[HEADERS.aeoVersion]).toBe(AEO_SPEC_VERSION);
  });

  it('advertises provenance so a drift check does not have to trust the body', () => {
    const headers = markdownHeaders({
      tokens: 120,
      lastUpdated: '2026-01-01T00:00:00.000Z',
      sourceHash: 'abc123abc123abc1',
    });
    expect(headers[HEADERS.markdownSourceHash]).toBe('abc123abc123abc1');
    expect(headers[HEADERS.lastModified]).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
  });

  it('omits provenance rather than inventing it when the manifest has none', () => {
    const headers = markdownHeaders({ tokens: 120, lastUpdated: 'not a date' });
    expect(headers[HEADERS.markdownSourceHash]).toBeUndefined();
    expect(headers[HEADERS.lastModified]).toBeUndefined();
  });

  it('HTML responses always vary on Accept, and advertise the twin only when one exists', () => {
    const withTwin = htmlHeaders({ route: '/resume', hasTwin: true });
    expect(withTwin[HEADERS.vary]).toBe('Accept');
    expect(withTwin[HEADERS.link]).toBe('</resume.md>; rel="alternate"; type="text/markdown"');
    const withoutTwin = htmlHeaders({ route: '/contact', hasTwin: false });
    expect(withoutTwin[HEADERS.vary]).toBe('Accept');
    expect(withoutTwin[HEADERS.link]).toBeUndefined();
  });

  it('round-trips its own Link header', () => {
    const header = htmlHeaders({ route: '/', hasTwin: true })[HEADERS.link];
    expect(parseLinkAlternate(header)).toBe('/index.md');
    expect(parseLinkAlternate('</feed.xml>; rel="alternate"; type="application/rss+xml"')).toBeUndefined();
    expect(parseLinkAlternate(null)).toBeUndefined();
  });
});

describe('Accept parsing', () => {
  it('treats an absent header as accepting anything', () => {
    const summary = summarizeAccept(null);
    expect(summary).toMatchObject({ absent: true, acceptsHtml: true, acceptsMarkdown: true, prefersMarkdown: false });
  });

  it('does not read a browser wildcard as a markdown preference', () => {
    const summary = summarizeAccept(BROWSER_ACCEPT);
    expect(summary.acceptsMarkdown).toBe(true);
    expect(summary.prefersMarkdown).toBe(false);
  });

  it('honours q-values when ranking markdown against HTML', () => {
    expect(summarizeAccept('text/markdown;q=0.9,text/html;q=1.0').prefersMarkdown).toBe(false);
    expect(summarizeAccept('text/markdown;q=1.0,text/html;q=0.8').prefersMarkdown).toBe(true);
    expect(summarizeAccept('text/markdown').prefersMarkdown).toBe(true);
  });
});

describe('classification', () => {
  it('never treats an unknown bot as anything but an ordinary visitor', () => {
    const result = classify({
      pathname: '/resume',
      userAgent: 'BrandNewAiCrawler/0.1 (+https://example.com/bot)',
      accept: BROWSER_ACCEPT,
      markdownRouting: DEFAULT_MARKDOWN_ROUTING,
    });
    expect(result.kind).toBe('human');
    expect(result.serve).toBe('html');
  });

  it('serves the normal site to a known bot that is not on the routing list, never a block', () => {
    const result = classify({ pathname: '/resume', userAgent: GPTBOT, accept: '*/*', markdownRouting: [] });
    expect(result.kind).toBe('unrouted-bot');
    expect(result.serve).toBe('html');
    expect(result.reason).toContain('never blocked');
  });

  it('routes a listed bot to markdown with no Accept header involved', () => {
    const result = classify({ pathname: '/resume', userAgent: GPTBOT, accept: null, markdownRouting: ['GPTBot'] });
    expect(result.kind).toBe('routed-ai');
    expect(result.serve).toBe('markdown');
    expect(result.bot?.name).toBe('GPTBot');
  });

  it('resolves both twin URL shapes back to the same route', () => {
    expect(classify({ pathname: '/resume.md', markdownRouting: [] }).route).toBe('/resume');
    expect(classify({ pathname: '/md/resume.md', markdownRouting: [] }).route).toBe('/resume');
    expect(classify({ pathname: '/index.md', markdownRouting: [] }).route).toBe('/');
  });
});

describe('handleRequest', () => {
  it('serves markdown at the same URL for Accept: text/markdown', () => {
    const decision = handleRequest(request('/resume', { accept: 'text/markdown' }), ctx);
    expect(decision.type).toBe('markdown');
    if (decision.type !== 'markdown') return;
    expect(decision.response.status).toBe(200);
    expect(decision.response.headers.get(HEADERS.contentType)).toBe(MARKDOWN_CONTENT_TYPE);
    expect(decision.response.headers.get(HEADERS.markdownTokens)).toBe('12');
  });

  it('serves markdown to a routed bot that sends no Accept header', () => {
    const decision = handleRequest(request('/resume', { 'user-agent': GPTBOT }), ctx);
    expect(decision.type).toBe('markdown');
  });

  it('leaves a browser request alone but decorates it with the twin advertisement', () => {
    const decision = handleRequest(request('/resume', { accept: BROWSER_ACCEPT }), ctx);
    expect(decision.type).toBe('passthrough');
    if (decision.type !== 'passthrough') return;
    expect(decision.headers[HEADERS.vary]).toBe('Accept');
    expect(decision.headers[HEADERS.link]).toContain('/resume.md');
  });

  it('returns 406 when Accept excludes both HTML and markdown', () => {
    const decision = handleRequest(request('/resume', { accept: 'application/json' }), ctx);
    expect(decision.type).toBe('not-acceptable');
    if (decision.type !== 'not-acceptable') return;
    expect(decision.response.status).toBe(406);
    expect(decision.response.headers.get(HEADERS.vary)).toBe('Accept');
  });

  it('falls through to the real site when a route has no twin', () => {
    const decision = handleRequest(request('/contact', { accept: 'text/markdown' }), ctx);
    expect(decision.type).toBe('passthrough');
    if (decision.type !== 'passthrough') return;
    expect(decision.headers[HEADERS.link]).toBeUndefined();
  });

  it('answers a HEAD request with headers and no body', async () => {
    const decision = handleRequest(request('/resume.md', {}, 'HEAD'), ctx);
    expect(decision.type).toBe('markdown');
    if (decision.type !== 'markdown') return;
    expect(await decision.response.text()).toBe('');
  });

  it('ignores framework internals and static assets', () => {
    for (const path of ['/_next/static/chunk.js', '/logo.svg', '/fonts/inter.woff2']) {
      const decision = handleRequest(request(path, { accept: 'text/markdown' }), ctx);
      expect(decision.type).toBe('passthrough');
      expect(decision.type === 'passthrough' && Object.keys(decision.headers)).toEqual([]);
    }
  });

  it('passes non-GET methods straight through', () => {
    const decision = handleRequest(request('/resume', { accept: 'text/markdown' }, 'POST'), ctx);
    expect(decision.type).toBe('passthrough');
  });
});

describe('conditional requests', () => {
  /** @param {Record<string, string>} [headers] */
  const twin = (headers = {}) => {
    const decision = handleRequest(request('/resume.md', headers), ctx);
    if (decision.type !== 'markdown') throw new Error(`expected markdown, got ${decision.type}`);
    return decision.response;
  };
  const etag = twin().headers.get(HEADERS.etag) ?? '';

  it('sends a quoted ETag that is the same on every request and changes with the body', () => {
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(twin().headers.get(HEADERS.etag)).toBe(etag);
    expect(entityTag('# Resume\n\nShipped 4 projects in 2024.')).toBe(etag);
    expect(entityTag('# Resume\n\nShipped 5 projects in 2024.')).not.toBe(etag);
    expect(entityTag('')).toMatch(/^"[0-9a-f]{16}"$/);
  });

  it('gives the edge store the same tag the memory store gives the same body', () => {
    const edge = createManifestStore({
      manifest: { pages: { '/resume': { route: '/resume', file: 'md/resume.md', tokens: 12 } } },
      contents: { 'md/resume.md': '---\ntitle: "Resume"\n---\n# Resume\n\nShipped 4 projects in 2024.\n' },
    });
    expect(edge.get('/resume')?.etag).toBe(etag);
  });

  it('answers a matching If-None-Match with 304, no body, and the headers a cache updates from', async () => {
    const response = twin({ 'if-none-match': etag });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
    expect(response.headers.get(HEADERS.etag)).toBe(etag);
    expect(response.headers.get(HEADERS.vary)).toBe('Accept');
    expect(response.headers.get(HEADERS.lastModified)).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
    expect(response.headers.get(HEADERS.contentType)).toBeNull();
    expect(response.headers.get(HEADERS.markdownTokens)).toBeNull();
  });

  it('matches weakly, in a list, and on *', () => {
    expect(twin({ 'if-none-match': `W/${etag}` }).status).toBe(304);
    expect(twin({ 'if-none-match': `"0000000000000000", ${etag}` }).status).toBe(304);
    expect(twin({ 'if-none-match': '*' }).status).toBe(304);
    expect(twin({ 'if-none-match': '"0000000000000000"' }).status).toBe(200);
  });

  it('keeps Cache-Control: private on a 304 for markdown the User-Agent chose', () => {
    const decision = handleRequest(request('/resume', { 'user-agent': GPTBOT, 'if-none-match': etag }), ctx);
    expect(decision.type === 'markdown' && decision.response.status).toBe(304);
    expect(decision.type === 'markdown' && decision.response.headers.get(HEADERS.cacheControl)).toBe('private');
  });

  it('uses If-Modified-Since only without If-None-Match, and ignores a date in the future', () => {
    expect(twin({ 'if-modified-since': 'Thu, 01 Jan 2026 00:00:00 GMT' }).status).toBe(304);
    expect(twin({ 'if-modified-since': 'Wed, 31 Dec 2025 23:59:59 GMT' }).status).toBe(200);
    expect(twin({ 'if-modified-since': 'Thu, 01 Jan 2026 00:00:00 GMT', 'if-none-match': '"0000000000000000"' }).status).toBe(200);
    expect(twin({ 'if-modified-since': 'not a date' }).status).toBe(200);
    expect(
      isNotModified({ ifNoneMatch: null, ifModifiedSince: 'Fri, 01 Jan 2100 00:00:00 GMT' }, { lastUpdated: '2026-01-01T00:00:00.000Z' }),
    ).toBe(false);
  });

  it('never answers 304 for a page it does not serve as markdown', () => {
    const decision = handleRequest(request('/resume', { accept: BROWSER_ACCEPT, 'if-none-match': '*' }), ctx);
    expect(decision.type).toBe('passthrough');
  });
});

describe('bot identification', () => {
  it('matches real crawler user agents', () => {
    expect(identifyBot(GPTBOT)?.name).toBe('GPTBot');
    expect(identifyBot('Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)')?.name).toBe('ClaudeBot');
    expect(identifyBot('Mozilla/5.0 ... Chrome/120 Safari/537.36')).toBeUndefined();
    expect(identifyBot(null)).toBeUndefined();
  });

  it('never matches a robots.txt-only opt-out token as a live crawler', () => {
    expect(identifyBot('Google-Extended')).toBeUndefined();
    expect(DEFAULT_MARKDOWN_ROUTING).not.toContain('Google-Extended');
    expect(DEFAULT_MARKDOWN_ROUTING).not.toContain('Applebot-Extended');
  });
});

describe('a project\'s own crawlers (bots.custom)', () => {
  const ACME = 'AcmeCorp/1.0 (+https://acme.test/crawler; acme-crawler)';
  const bots = resolveBots([{ name: 'AcmeBot', uaPatterns: ['acme-crawler'], kind: 'assistant' }]);

  it('is invisible until the project configures it', () => {
    // The default catalogue has never heard of it, so it is an ordinary visitor - not a suspect.
    const decision = handleRequest(request('/resume', { 'user-agent': ACME, accept: BROWSER_ACCEPT }), {
      store,
      markdownRouting: [...DEFAULT_MARKDOWN_ROUTING, 'AcmeBot'],
    });
    expect(decision.type).toBe('passthrough');
  });

  it('gets the twin once it is both resolved and routed', () => {
    const decision = handleRequest(request('/resume', { 'user-agent': ACME, accept: BROWSER_ACCEPT }), {
      store,
      markdownRouting: ['AcmeBot'],
      bots,
    });
    expect(decision.type).toBe('markdown');
    if (decision.type !== 'markdown') return;
    expect(decision.classification.bot?.name).toBe('AcmeBot');
    expect(decision.classification.bot?.custom).toBe(true);
    expect(decision.response.headers.get(HEADERS.contentType)).toBe(MARKDOWN_CONTENT_TYPE);
    expect(decision.doc.body).toContain('# Resume');
  });

  it('gets the ordinary site when it is resolved but not routed, exactly like a shipped crawler', () => {
    const decision = handleRequest(request('/resume', { 'user-agent': ACME, accept: BROWSER_ACCEPT }), {
      store,
      markdownRouting: [],
      bots,
    });
    expect(decision.type).toBe('passthrough');
    expect(classify({ pathname: '/resume', userAgent: ACME, accept: BROWSER_ACCEPT, markdownRouting: [], bots }).kind).toBe(
      'unrouted-bot',
    );
  });

  it('does not displace the shipped crawlers it sits beside', () => {
    const decision = classify({
      pathname: '/resume',
      userAgent: GPTBOT,
      accept: BROWSER_ACCEPT,
      markdownRouting: ['GPTBot'],
      bots,
    });
    expect(decision.bot?.name).toBe('GPTBot');
    expect(decision.serve).toBe('markdown');
  });
});

/**
 * §7's second lever is blocking, and it is expressed exclusively in the robots.txt that `generate`
 * writes. There is no blocking code in prod at all, which is easy to say and worth proving: a
 * single "if bot in blocked list, return 403" added later would turn a format router into an
 * access-control layer, and that is the mistake §16 is aimed at.
 */
describe('prod has no blocking code path', () => {
  const BLOCKING = new Set([401, 403, 405, 429, 451]);

  it('answers every known bot without ever blocking, routed or not', async () => {
    for (const bot of AI_BOTS) {
      for (const pattern of bot.uaPatterns) {
        const ua = `Mozilla/5.0 (compatible; ${pattern}/1.0; +https://example.com/bot)`;
        for (const routing of [DEFAULT_MARKDOWN_ROUTING, /** @type {string[]} */ ([])]) {
          for (const path of ['/resume', '/resume.md', '/unknown-page']) {
            const decision = handleRequest(request(path, { 'user-agent': ua, accept: BROWSER_ACCEPT }), {
              store,
              markdownRouting: routing,
            });
            const status = decision.type === 'passthrough' ? 200 : decision.response.status;
            expect(BLOCKING.has(status), `${bot.name} on ${path} got ${status}`).toBe(false);
          }
        }
      }
    }
  });

  it('treats a bot missing from the routing list as an ordinary visitor, not a suspect', () => {
    const decision = handleRequest(request('/resume', { 'user-agent': GPTBOT, accept: BROWSER_ACCEPT }), {
      store,
      markdownRouting: ['ClaudeBot'],
    });
    expect(decision.type).toBe('passthrough');
    expect(decision.classification.kind).toBe('unrouted-bot');
    expect(decision.classification.reason).toContain('never blocked');
  });

  it('ignores a blocking list even when one is handed to it', async () => {
    // `bots.blocked` is a generate-side setting. Smuggling it into the runtime context must change
    // nothing, because nothing here reads it - the type does not have the field and neither does
    // the code. If prod ever grows a blocking branch, this is where it shows up.
    const withBlocklist = /** @type {never} */ ({ store, markdownRouting: DEFAULT_MARKDOWN_ROUTING, blocked: ['GPTBot'] });
    const decision = handleRequest(request('/resume', { 'user-agent': GPTBOT }), withBlocklist);
    expect(decision.type).toBe('markdown');
    if (decision.type !== 'markdown') return;
    expect(decision.response.status).toBe(200);
    expect(await decision.response.text()).toContain('Shipped 4 projects');
  });
});
