import { describe, expect, it } from 'vitest';
import type { ProbeResult } from '@opengeo/core/shared';
import { AEO_SPEC_VERSION, MARKDOWN_CONTENT_TYPE } from '@opengeo/core/shared';
import type { Evidence } from '@opengeo/core/test';
import { runChecks, scoreChecks, testEvidence } from '@opengeo/core/test';

/**
 * The whole checklist is driven from synthetic evidence, so these tests exercise the real check
 * logic with no network and no timing flakiness.
 */

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    url: 'https://example.com/resume',
    ok: true,
    status: 200,
    headers: new Headers(),
    body: '',
    ttfbMs: 40,
    totalMs: 80,
    redirected: false,
    finalUrl: 'https://example.com/resume',
    ...overrides,
  };
}

const GOOD_HTML = `<!doctype html><html><head><title>Resume</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"A"}</script>
</head><body><main><h1>Resume</h1>
<p>Shipped four projects in 2024 across three teams, including a platform migration that moved
forty-two services onto a shared runtime, and a pricing change worth twelve thousand five hundred
dollars a month to the business. Earlier work covered data pipelines and developer tooling, with a
long stretch owning the build system and the release process for a codebase of roughly two hundred
thousand lines. Before that, three years on an internal analytics product used by every team in the
company, where the work was mostly about making slow queries fast and making failures legible.</p>
</main></body></html>`;

function goodEvidence(): Evidence {
  const target = new URL('https://example.com/resume');
  return {
    target,
    origin: target.origin,
    html: probe({
      body: GOOD_HTML,
      headers: new Headers({
        'content-type': 'text/html; charset=utf-8',
        vary: 'Accept',
        link: '</resume.md>; rel="alternate"; type="text/markdown"',
        'strict-transport-security': 'max-age=63072000',
        'x-aeo-version': AEO_SPEC_VERSION,
      }),
    }),
    robots: probe({ url: 'https://example.com/robots.txt', body: 'User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n' }),
    llms: probe({ url: 'https://example.com/llms.txt', body: '# Example\n\n> A site.\n\n## Pages\n\n- [Resume](https://example.com/resume.md)\n' }),
    sitemap: probe({ url: 'https://example.com/sitemap.xml', body: '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/resume</loc></url></urlset>' }),
    twin: probe({
      url: 'https://example.com/resume.md',
      body: '# Resume\n\nShipped four projects in 2024.',
      headers: new Headers({
        'content-type': MARKDOWN_CONTENT_TYPE,
        'x-markdown-tokens': '42',
        'x-content-type-options': 'nosniff',
        'x-robots-tag': 'noindex',
        vary: 'Accept',
        'x-aeo-version': AEO_SPEC_VERSION,
      }),
    }),
    twinUrl: 'https://example.com/resume.md',
    advertisedTwinUrl: 'https://example.com/resume.md',
    acceptMarkdown: probe({ headers: new Headers({ 'content-type': MARKDOWN_CONTENT_TYPE }), body: '# Resume' }),
    botUa: probe({ headers: new Headers({ 'content-type': MARKDOWN_CONTENT_TYPE }), body: '# Resume' }),
    notAcceptable: probe({ ok: false, status: 406, body: '406 Not Acceptable' }),
  };
}

function byId(evidence: Evidence) {
  return new Map(runChecks(evidence).map((check) => [check.id, check]));
}

describe('a correctly configured site', () => {
  it('passes every check', () => {
    const results = runChecks(goodEvidence());
    const failures = results.filter((check) => check.status === 'fail');
    expect(failures.map((f) => `${f.id}: ${f.reason}`)).toEqual([]);
    expect(scoreChecks(results).value).toBe(100);
  });
});

describe('category A', () => {
  it('A1 fails loudly when robots.txt disallows a live assistant or search agent', () => {
    const evidence = goodEvidence();
    evidence.robots = probe({ body: 'User-agent: OAI-SearchBot\nDisallow: /\n' });
    const check = byId(evidence).get('A1');
    expect(check?.status).toBe('fail');
    expect(check?.reason).toContain('OAI-SearchBot');
    expect(check?.reason).toContain('removes the site from AI answers');
  });

  it('A1 reads a training-crawler-only block as deliberate, not a mistake', () => {
    const evidence = goodEvidence();
    evidence.robots = probe({ body: 'User-agent: CCBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n' });
    const check = byId(evidence).get('A1');
    expect(check?.status).toBe('pass');
    expect(check?.reason).toContain('CCBot');
  });

  it('A2 rejects an llms.txt with no title or no links', () => {
    const evidence = goodEvidence();
    evidence.llms = probe({ body: 'Just some text.' });
    expect(byId(evidence).get('A2')?.status).toBe('fail');
    evidence.llms = probe({ body: '# Title only' });
    expect(byId(evidence).get('A2')?.reason).toContain('no links');
  });

  it('A3 rejects a sitemap with no urlset', () => {
    const evidence = goodEvidence();
    evidence.sitemap = probe({ body: '<html>not a sitemap</html>' });
    expect(byId(evidence).get('A3')?.status).toBe('fail');
  });

  it('A4 fails on unparseable JSON-LD and names the parse error', () => {
    const evidence = goodEvidence();
    evidence.html = probe({ body: GOOD_HTML.replace('{"@context":"https://schema.org","@type":"Person","name":"A"}', '{oops'), headers: evidence.html.headers });
    const check = byId(evidence).get('A4');
    expect(check?.status).toBe('fail');
    expect(check?.reason).toContain('does not parse');
  });

  it('A5 names client-side rendering when the HTML is an empty shell', () => {
    const evidence = goodEvidence();
    evidence.html = probe({ body: '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>' });
    const check = byId(evidence).get('A5');
    expect(check?.status).toBe('fail');
    expect(check?.reason).toContain('client-rendered');
  });

  it('A6 flags a slow time to first byte', () => {
    const evidence = goodEvidence();
    evidence.html = probe({ ...evidence.html, ttfbMs: 3200 });
    expect(byId(evidence).get('A6')?.reason).toContain('3200ms');
  });

  it('A7 catches a noai opt-out in a meta tag and in a header', () => {
    const metaEvidence = goodEvidence();
    metaEvidence.html = probe({ body: GOOD_HTML.replace('<title>', '<meta name="robots" content="noai"><title>') });
    expect(byId(metaEvidence).get('A7')?.status).toBe('fail');

    const headerEvidence = goodEvidence();
    headerEvidence.html = probe({ body: GOOD_HTML, headers: new Headers({ 'x-robots-tag': 'noai, noimageai' }) });
    expect(byId(headerEvidence).get('A7')?.status).toBe('fail');
  });

  it('A8 is not applicable on localhost rather than an automatic failure', () => {
    const evidence = goodEvidence();
    evidence.target = new URL('http://localhost:3000/resume');
    const check = byId(evidence).get('A8');
    expect(check?.status).toBe('na');
  });
});

describe('category B', () => {
  it('B1 through B12 all fail with specific reasons when no middleware is running', () => {
    const evidence = goodEvidence();
    const html404 = probe({ ok: false, status: 404, body: '<!doctype html><html><body>404</body></html>' });
    evidence.twin = html404;
    evidence.advertisedTwinUrl = undefined;
    evidence.html = probe({ body: GOOD_HTML, headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }) });
    evidence.acceptMarkdown = probe({ headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }) });
    evidence.botUa = probe({ headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }) });
    evidence.notAcceptable = probe({ status: 200, headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }) });

    const results = byId(evidence);
    for (const id of ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12']) {
      expect(results.get(id)?.status, `${id} should fail`).toBe('fail');
      expect(results.get(id)?.reason.length).toBeGreaterThan(20);
    }
    // The human-facing site is untouched, which is exactly what "broken state" should still show.
    expect(results.get('B13')?.status).toBe('pass');
  });

  it('B2 rejects text/plain even when the body is real markdown', () => {
    const evidence = goodEvidence();
    evidence.twin = probe({ body: '# Resume', headers: new Headers({ 'content-type': 'text/plain; charset=utf-8' }) });
    expect(byId(evidence).get('B2')?.reason).toContain('text/plain');
  });

  it('B3 catches an HTML document served at the .md URL', () => {
    const evidence = goodEvidence();
    evidence.twin = probe({ body: '<!doctype html><html><body>Not found</body></html>', headers: new Headers({ 'content-type': MARKDOWN_CONTENT_TYPE }) });
    expect(byId(evidence).get('B3')?.reason).toContain('HTML document');
  });

  it('B7 names which side is missing Vary: Accept', () => {
    const evidence = goodEvidence();
    evidence.html = probe({ body: GOOD_HTML, headers: new Headers({ 'content-type': 'text/html' }) });
    expect(byId(evidence).get('B7')?.reason).toContain('the HTML response');
  });

  it('B10 explains why User-Agent routing matters even when B9 passes', () => {
    const evidence = goodEvidence();
    evidence.botUa = probe({ headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }) });
    const results = byId(evidence);
    expect(results.get('B9')?.status).toBe('pass');
    expect(results.get('B10')?.status).toBe('fail');
    expect(results.get('B10')?.reason).toContain('never send Accept');
  });

  it('B13 fails when a browser request is answered with markdown', () => {
    const evidence = goodEvidence();
    evidence.html = probe({ body: '# Resume', headers: new Headers({ 'content-type': MARKDOWN_CONTENT_TYPE }) });
    expect(byId(evidence).get('B13')?.reason).toContain('wrong format');
  });
});

describe('scoring', () => {
  it('excludes not-applicable checks from the denominator instead of counting them as failures', () => {
    const remote = scoreChecks(runChecks(goodEvidence()));
    const local = goodEvidence();
    local.target = new URL('http://localhost:3000/resume');
    const localScore = scoreChecks(runChecks(local));
    expect(localScore.counts.na).toBe(1);
    expect(localScore.possible).toBeLessThan(remote.possible);
    expect(localScore.value).toBe(100);
  });

  it('weights a required failure more heavily than a recommended one', () => {
    const missingRequired = goodEvidence();
    missingRequired.robots = probe({ ok: false, status: 404 });
    const missingRecommended = goodEvidence();
    missingRecommended.twin.headers.delete('x-content-type-options');

    expect(scoreChecks(runChecks(missingRequired)).value).toBeLessThan(
      scoreChecks(runChecks(missingRecommended)).value,
    );
  });

  it('records the points lost per failing check, for the fix prompt', () => {
    const evidence = goodEvidence();
    evidence.llms = probe({ ok: false, status: 404 });
    const score = scoreChecks(runChecks(evidence));
    expect(score.lost).toEqual([{ id: 'A2', points: 8 }]);
  });

  it('reports a score of 0 when nothing can be scored', () => {
    expect(scoreChecks([]).value).toBe(0);
  });
});

describe('testEvidence', () => {
  it('bundles checks and score against the requested URL', () => {
    const result = testEvidence(goodEvidence());
    expect(result.url).toBe('https://example.com/resume');
    expect(result.twinUrl).toBe('https://example.com/resume.md');
    expect(result.score.value).toBe(100);
  });
});

describe('B7 parses Vary as a token list', () => {
  const cases: Array<[string, 'pass' | 'fail']> = [
    ['Accept', 'pass'],
    ['accept', 'pass'],
    ['Accept, Accept-Encoding', 'pass'],
    ['*', 'pass'],
    // The trap: nearly every compressed response carries this, and a substring match passes it.
    ['Accept-Encoding', 'fail'],
    ['rsc, next-router-state-tree, next-router-prefetch, Accept-Encoding', 'fail'],
    ['', 'fail'],
  ];

  for (const [header, expected] of cases) {
    it(`treats "${header || '(absent)'}" as ${expected}`, () => {
      const evidence = goodEvidence();
      evidence.html.headers.set('vary', header);
      expect(byId(evidence).get('B7')?.status).toBe(expected);
    });
  }
});
