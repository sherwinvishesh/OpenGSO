import { describe, expect, it } from 'vitest';
import type { ProbeResult } from '@opengeo/core/shared';
import { AEO_SPEC_VERSION, MARKDOWN_CONTENT_TYPE } from '@opengeo/core/shared';
import { liveContentHash } from './helpers/live-hash.js';
import type { Evidence } from '@opengeo/core/test';
import { renderReport, runChecks, scoreChecks, testEvidence } from '@opengeo/core/test';

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

const GOOD_TWIN = `# Resume

Shipped four projects in 2024 across three teams, including a platform migration that moved
forty-two services onto a shared runtime, and a pricing change worth twelve thousand five hundred
dollars a month to the business. Earlier work covered data pipelines and developer tooling, with a
long stretch owning the build system and the release process for a codebase of roughly two hundred
thousand lines. Before that, three years on an internal analytics product used by every team in the
company, where the work was mostly about making slow queries fast and making failures legible.`;

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
      body: GOOD_TWIN,
      headers: new Headers({
        'content-type': MARKDOWN_CONTENT_TYPE,
        'x-markdown-tokens': '42',
        'x-content-type-options': 'nosniff',
        'x-robots-tag': 'noindex',
        vary: 'Accept',
        'x-aeo-version': AEO_SPEC_VERSION,
        // What prod actually sends: the body has no frontmatter, so provenance rides in headers.
        'x-markdown-source-hash': liveContentHash(GOOD_HTML),
        'last-modified': new Date().toUTCString(),
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

describe('B14 staleness and drift', () => {
  it('passes on an exact hash match, which is the only path that proves freshness', () => {
    const check = byId(goodEvidence()).get('B14');
    expect(check?.status).toBe('pass');
    expect(check?.reason).toContain('exactly this version');
  });

  it('fails when the live page has moved on since the twin was generated', () => {
    const evidence = goodEvidence();
    evidence.twin.headers.set('x-markdown-source-hash', 'deadbeefdeadbeef');
    const check = byId(evidence).get('B14');
    expect(check?.status).toBe('fail');
    expect(check?.reason).toContain('changed since the twin was generated');
    expect(check?.reason).toContain('opengeo generate');
    expect(check?.detail).toContain('deadbeefdeadbeef');
  });

  it('reads the hash out of frontmatter when the twin is served as a plain static file', () => {
    const evidence = goodEvidence();
    evidence.twin.headers.delete('x-markdown-source-hash');
    evidence.twin.body = `---\nsource_hash: "${liveContentHash(GOOD_HTML)}"\n---\n\n${GOOD_TWIN}`;
    const check = byId(evidence).get('B14');
    expect(check?.status).toBe('pass');
    expect(check?.reason).toContain('exactly this version');
  });

  it('falls back to comparing facts for a hand-written twin with no hash anywhere', () => {
    const evidence = goodEvidence();
    evidence.twin.headers.delete('x-markdown-source-hash');
    const check = byId(evidence).get('B14');
    expect(check?.status).toBe('pass');
    expect(check?.reason).toContain('no source hash');
  });

  it('catches a hashless twin that has lost the facts on the live page', () => {
    const evidence = goodEvidence();
    evidence.twin.headers.delete('x-markdown-source-hash');
    evidence.twin.body = '# Resume\n\nA summary of some work.';
    const check = byId(evidence).get('B14');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('fact by fact');
  });

  it('fails rather than guessing when there is no twin to compare at all', () => {
    const evidence = goodEvidence();
    evidence.twin = probe({ ok: false, status: 404, body: '' });
    expect(byId(evidence).get('B14')?.reason).toContain('no markdown twin');
  });

  it('is not applicable when the live page itself is unreachable', () => {
    const evidence = goodEvidence();
    evidence.html = probe({ ok: false, status: 500, body: '' });
    expect(byId(evidence).get('B14')?.status).toBe('na');
  });
});

describe('the score stays honest when most of the checklist cannot apply', () => {
  /** Synthetic checks, so the weighting can be reasoned about without the whole catalogue. */
  function synthetic(spec: Array<[string, 'pass' | 'fail' | 'na', number]>) {
    return spec.map(([id, status, weight]) => ({
      id,
      category: 'A' as const,
      importance: 'required' as const,
      weight,
      title: id,
      status,
      reason: id,
    }));
  }

  it('scores only what applied, never counting an n/a as a failure', () => {
    const score = scoreChecks(synthetic([
      ['X1', 'pass', 10],
      ['X2', 'na', 10],
      ['X3', 'na', 10],
      ['X4', 'na', 10],
    ]));
    expect(score.value).toBe(100);
    expect(score.possible).toBe(10);
    expect(score.counts.na).toBe(3);
    expect(score.lost).toEqual([]);
  });

  it('does not let one heavy n/a check drag the number around', () => {
    const score = scoreChecks(synthetic([
      ['X1', 'pass', 10],
      ['X2', 'fail', 10],
      ['X3', 'na', 80],
    ]));
    expect(score.value).toBe(50);
  });

  it('gives a localhost run the same number a public run would, minus the checks that cannot run', () => {
    const local = goodEvidence();
    local.target = new URL('http://localhost:3000/resume');
    local.origin = 'http://localhost:3000';
    const checks = runChecks(local);
    const naIds = checks.filter((check) => check.status === 'na').map((check) => check.id);
    // A8 is HSTS. It is meaningless over plain http on a loopback address, and reporting it as a
    // failure would cap every local score below what the same site scores in production.
    expect(naIds).toEqual(['A8']);
    expect(scoreChecks(checks).value).toBe(100);
  });

  it('never returns a letter grade or a tier label anywhere in the report', () => {
    const report = renderReport(testEvidence(goodEvidence()), { verbose: true });
    const plain = report.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
    expect(plain).toMatch(/\d+\/100/);
    expect(plain).not.toMatch(/\bgrade\b/i);
    expect(plain).not.toMatch(/\b(bronze|silver|gold|platinum)\b/i);
  });
});
