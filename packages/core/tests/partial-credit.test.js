import { describe, expect, it } from 'vitest';
import { AEO_SPEC_VERSION, MARKDOWN_CONTENT_TYPE } from '@opengeo/core/shared';
import { checkDefinition, partial, ramp, runChecks, scoreChecks } from '@opengeo/core/test';
import { liveContentHash } from './helpers/live-hash.js';
/** @import { ProbeResult } from '@opengeo/core/shared' */
/** @import { CheckResult, Evidence } from '@opengeo/core/test' */

/**
 * Partial credit, band by band.
 *
 * The score used to be binary, which meant a site one header away from correct and a site that had
 * never heard of any of this got the same zero on the same check. Every band below is a claim about
 * how close something is, so every band is pinned: a future edit that quietly turns a 6 into a 3
 * changes what users are told to do first, and should have to say so here.
 *
 * The rule that keeps the scale honest is at the bottom: locked checks stay out of the denominator,
 * which is what stops one missing file from being charged thirteen times.
 */

const PAGE = `<!doctype html><html><head><title>Resume</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"A"}</script>
</head><body><main><h1>Resume</h1>
<p>Shipped four projects in 2024 across three teams, including a platform migration that moved
forty-two services onto a shared runtime, and a pricing change worth twelve thousand five hundred
dollars a month to the business. Earlier work covered data pipelines and developer tooling, with a
long stretch owning the build system and the release process for a codebase of roughly two hundred
thousand lines. Before that, three years on an internal analytics product used by every team in the
company, where the work was mostly about making slow queries fast and making failures legible.</p>
</main></body></html>`;

const TWIN = `# Resume

Shipped four projects in 2024 across three teams, including a platform migration that moved
forty-two services onto a shared runtime, and a pricing change worth twelve thousand five hundred
dollars a month to the business. Earlier work covered data pipelines and developer tooling, with a
long stretch owning the build system and the release process for a codebase of roughly two hundred
thousand lines. Before that, three years on an internal analytics product used by every team in the
company, where the work was mostly about making slow queries fast and making failures legible.`;

/**
 * @param {Partial<ProbeResult>} [overrides]
 * @returns {ProbeResult}
 */
function probe(overrides = {}) {
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

/**
 * A site with everything right, so each test can break exactly one thing and read the band.
 *
 * @returns {Evidence}
 */
function perfect() {
  const target = new URL('https://example.com/resume');
  return {
    target,
    origin: target.origin,
    html: probe({
      body: PAGE,
      headers: new Headers({
        'content-type': 'text/html; charset=utf-8',
        vary: 'Accept',
        link: '</resume.md>; rel="alternate"; type="text/markdown"',
        'strict-transport-security': 'max-age=63072000',
      }),
    }),
    robots: probe({ url: 'https://example.com/robots.txt', body: 'User-agent: *\nAllow: /\n' }),
    llms: probe({ url: 'https://example.com/llms.txt', body: '# Example\n\n> A site.\n\n- [Resume](https://example.com/resume.md)\n' }),
    sitemap: probe({
      url: 'https://example.com/sitemap.xml',
      body: '<?xml version="1.0"?><urlset><url><loc>https://example.com/resume</loc></url></urlset>',
    }),
    twin: probe({
      url: 'https://example.com/resume.md',
      body: TWIN,
      headers: new Headers({
        'content-type': MARKDOWN_CONTENT_TYPE,
        'x-markdown-tokens': '42',
        'x-content-type-options': 'nosniff',
        'x-robots-tag': 'noindex',
        vary: 'Accept',
        'x-aeo-version': AEO_SPEC_VERSION,
        'x-markdown-source-hash': liveContentHash(PAGE),
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

/**
 * @param {Evidence} evidence
 * @param {string} id
 * @returns {CheckResult}
 */
function check(evidence, id) {
  const found = runChecks(evidence).find((result) => result.id === id);
  if (!found) throw new Error(`No result for ${id}`);
  return found;
}

/**
 * Every band asserts the same four things, so the assertions are written once.
 *
 * @param {CheckResult} result
 * @param {number} earned
 * @returns {void}
 */
function expectBand(result, earned) {
  expect(`${result.id} ${result.status}`).toBe(`${result.id} partial`);
  expect(result.earned).toBe(earned);
  expect(result.earned).toBeGreaterThan(0);
  expect(result.earned).toBeLessThan(result.weight);
  // A partial with no fix is just a lower score with no way out of it.
  expect(result.fix, `${result.id} needs a fix line`).toBeTruthy();
}

describe('the perfect fixture', () => {
  it('scores 100, so every band below is measuring one deliberate break', () => {
    const score = scoreChecks(runChecks(perfect()));
    expect(score.value).toBe(100);
    expect(score.counts.partial).toBe(0);
    expect(score.counts.locked).toBe(0);
  });
});

describe('category A bands', () => {
  it('A1 earns 6 of 9 when only bulk training crawlers are turned away', () => {
    const evidence = perfect();
    evidence.robots = probe({ body: 'User-agent: CCBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n' });
    expectBand(check(evidence, 'A1'), 6);
  });

  it('A2 earns 1 of 3 for an empty llms.txt and 1 for a linkless one', () => {
    const evidence = perfect();
    evidence.llms = probe({ body: '   \n' });
    expectBand(check(evidence, 'A2'), 1);
    evidence.llms = probe({ body: '# Example\n\nProse and no links at all.\n' });
    expectBand(check(evidence, 'A2'), 1);
  });

  it('A2 earns 2 of 3 when the links are there and the title is not', () => {
    const evidence = perfect();
    evidence.llms = probe({ body: '- [Resume](https://example.com/resume.md)\n- [About](https://example.com/about.md)\n' });
    expectBand(check(evidence, 'A2'), 2);
  });

  it('A3 earns 3 of 9 for something that answers but is not a sitemap', () => {
    const evidence = perfect();
    evidence.sitemap = probe({ body: '<html><body>Not found</body></html>' });
    expectBand(check(evidence, 'A3'), 3);
  });

  it('A3 earns 3 of 9 for a urlset with no entries in it', () => {
    const evidence = perfect();
    evidence.sitemap = probe({ body: '<urlset></urlset>' });
    expectBand(check(evidence, 'A3'), 3);
  });

  it('A3 earns 6 of 9 for a valid sitemap that leaves a real page out', () => {
    const evidence = perfect();
    evidence.sitemap = probe({ body: '<urlset><url><loc>https://example.com/about</loc></url></urlset>' });
    const result = check(evidence, 'A3');
    expectBand(result, 6);
    expect(result.reason).toContain('/resume');
  });

  it('A3 does not credit a homepage to a sitemap that leaves the homepage out', () => {
    // "/" is a substring of every sitemap ever written, so the page most people test first was the
    // one page a sitemap could omit and still score full marks.
    const evidence = perfect();
    evidence.target = new URL('https://example.com/');
    evidence.sitemap = probe({ body: '<urlset><url><loc>https://example.com/about</loc></url></urlset>' });
    expectBand(check(evidence, 'A3'), 6);
  });

  it('A3 accepts the target however the sitemap spells it', () => {
    for (const loc of ['https://example.com/resume', 'https://example.com/resume/', '/resume']) {
      const evidence = perfect();
      evidence.sitemap = probe({ body: `<urlset><url><loc>${loc}</loc></url></urlset>` });
      expect(check(evidence, 'A3').status, loc).toBe('pass');
    }
  });

  it('A4 earns 1 of 2 for JSON-LD that is present but unusable', () => {
    const broken = perfect();
    broken.html = probe({ body: PAGE.replace('{"@context":"https://schema.org","@type":"Person","name":"A"}', '{oops'), headers: broken.html.headers });
    expectBand(check(broken, 'A4'), 1);

    const typeless = perfect();
    typeless.html = probe({ body: PAGE.replace('"@type":"Person",', ''), headers: typeless.html.headers });
    expectBand(check(typeless, 'A4'), 1);
  });

  it('A5 ramps with how much of the page is actually in the raw HTML', () => {
    const evidence = perfect();
    /** @param {number} count */
    const words = (count) => Array.from({ length: count }, (_, index) => `word${index}`).join(' ');
    // Thirty words: half way between the fifteen-word floor and the sixty-word target.
    evidence.html = probe({ body: `<!doctype html><html><body><main><h1>T</h1><p>${words(30)}</p></main></body></html>` });
    const middling = check(evidence, 'A5');
    expect(middling.status).toBe('partial');
    expect(middling.earned).toBeGreaterThan(1);
    expect(middling.earned).toBeLessThan(9);

    evidence.html = probe({ body: `<!doctype html><html><body><main><h1>T</h1><p>${words(50)}</p></main></body></html>` });
    const nearly = check(evidence, 'A5');
    expect(nearly.status).toBe('partial');
    // Closer to the target has to be worth more, or the ramp is not a ramp.
    expect(nearly.earned).toBeGreaterThan(middling.earned);
  });

  it('A5 still fails outright on an empty client-rendered shell', () => {
    const evidence = perfect();
    evidence.html = probe({ body: '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>' });
    const result = check(evidence, 'A5');
    expect(result.status).toBe('fail');
    expect(result.earned).toBe(0);
    expect(result.reason).toContain('client-rendered');
  });

  it('A6 is full marks under 400ms, nothing over 1500ms, and a slide between', () => {
    /** @param {number} ttfbMs */
    const at = (ttfbMs) => {
      const evidence = perfect();
      evidence.html = probe({ ...evidence.html, ttfbMs });
      return check(evidence, 'A6');
    };
    expect(at(120).status).toBe('pass');
    expect(at(400).status).toBe('pass');
    expect(at(3200).status).toBe('fail');
    expect(at(1500).status).toBe('fail');

    const quick = at(600);
    const slow = at(1300);
    expectBand(quick, quick.earned);
    expectBand(slow, slow.earned);
    expect(quick.earned).toBeGreaterThan(slow.earned);
  });

  it('A8 earns 6 of 9 for HTTPS without HSTS, and nothing for plain HTTP', () => {
    const noHsts = perfect();
    noHsts.html.headers.delete('strict-transport-security');
    expectBand(check(noHsts, 'A8'), 6);

    const insecure = perfect();
    insecure.target = new URL('http://example.com/resume');
    expect(check(insecure, 'A8').status).toBe('fail');
  });

  it('A8 judges where an http:// target ends up, not the scheme the user typed', () => {
    const upgraded = perfect();
    upgraded.target = new URL('http://example.com/resume');
    upgraded.html = { ...upgraded.html, redirected: true, finalUrl: 'https://example.com/resume' };
    const result = check(upgraded, 'A8');
    expect(result.status).toBe('pass');
    expect(result.earned).toBe(9);

    const noHsts = perfect();
    noHsts.target = new URL('http://example.com/resume');
    noHsts.html = { ...noHsts.html, redirected: true, finalUrl: 'https://example.com/resume' };
    noHsts.html.headers = new Headers(noHsts.html.headers);
    noHsts.html.headers.delete('strict-transport-security');
    expectBand(check(noHsts, 'A8'), 6);

    // A redirect that stays on plain HTTP upgrades nothing.
    const sideways = perfect();
    sideways.target = new URL('http://example.com/resume');
    sideways.html = { ...sideways.html, redirected: true, finalUrl: 'http://www.example.com/resume' };
    expect(check(sideways, 'A8').status).toBe('fail');
  });

  it('A8 is still not applicable on localhost, which is not the same as partial', () => {
    const evidence = perfect();
    evidence.target = new URL('http://localhost:3000/resume');
    const result = check(evidence, 'A8');
    expect(result.status).toBe('na');
    expect(result.earned).toBe(0);
  });
});

describe('category B bands', () => {
  it('B2 earns 3 of 5 for text/markdown with no charset', () => {
    const evidence = perfect();
    evidence.twin.headers.set('content-type', 'text/markdown');
    expectBand(check(evidence, 'B2'), 3);
  });

  it('B2 earns 2 of 5 for text/plain and nothing for text/html', () => {
    const plain = perfect();
    plain.twin.headers.set('content-type', 'text/plain; charset=utf-8');
    expectBand(check(plain, 'B2'), 2);

    const html = perfect();
    html.twin.headers.set('content-type', 'text/html; charset=utf-8');
    expect(check(html, 'B2').status).toBe('fail');
  });

  it('B3 ramps on how much of the page reached the twin', () => {
    const evidence = perfect();
    evidence.twin = probe({ body: '# Resume\n\nA stub.', headers: evidence.twin.headers });
    const stub = check(evidence, 'B3');
    expectBand(stub, stub.earned);
    expect(stub.reason).toContain('did not make it');

    // Half the page is the full-credit line: markdown is denser and drops the chrome.
    const half = TWIN.split(/\s+/).slice(0, Math.ceil(TWIN.split(/\s+/).length * 0.6)).join(' ');
    evidence.twin = probe({ body: half, headers: evidence.twin.headers });
    expect(check(evidence, 'B3').status).toBe('pass');
  });

  it('B6 earns 1 of 3 for an X-Robots-Tag that forgot noindex', () => {
    const evidence = perfect();
    evidence.twin.headers.set('x-robots-tag', 'nosnippet');
    expectBand(check(evidence, 'B6'), 1);
  });

  it('B7 earns 2 of 4 when one of the two responses carries Vary: Accept', () => {
    const evidence = perfect();
    evidence.html.headers.set('vary', 'Accept-Encoding');
    const result = check(evidence, 'B7');
    expectBand(result, 2);
    expect(result.reason).toContain('the HTML response');
    // This is the Next.js App Router case, and the fix has to say so rather than blaming the user.
    expect(result.fix).toContain('middleware');
  });

  it('B8 earns 1 of 3 for a Link header that advertises the wrong thing', () => {
    const evidence = perfect();
    evidence.advertisedTwinUrl = undefined;
    evidence.html.headers.set('link', '</style.css>; rel="preload"; as="style"');
    expectBand(check(evidence, 'B8'), 1);
  });

  it('B14 earns 2 of 4 when the hash is stale but every fact still matches', () => {
    const evidence = perfect();
    evidence.twin.headers.set('x-markdown-source-hash', 'stale0000000000');
    const result = check(evidence, 'B14');
    expectBand(result, 2);
    expect(result.reason).toContain('cosmetic');
  });
});

describe('locked checks', () => {
  /**
   * @returns {Evidence}
   */
  function noTwin() {
    const evidence = perfect();
    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', 'strict-transport-security': 'max-age=63072000' });
    evidence.twin = probe({ ok: false, status: 404, body: '<!doctype html><html><body>404</body></html>' });
    evidence.advertisedTwinUrl = undefined;
    evidence.html = probe({ body: PAGE, headers });
    evidence.acceptMarkdown = probe({ headers });
    evidence.botUa = probe({ headers });
    evidence.notAcceptable = probe({ status: 200, headers });
    return evidence;
  }

  it('name what unlocks them, which is the whole point of the status', () => {
    for (const result of runChecks(noTwin()).filter((r) => r.status === 'locked')) {
      expect(result.lockedBy).toBe('B1');
      expect(result.earned).toBe(0);
    }
  });

  it('stay out of the denominator and are priced as one number', () => {
    const score = scoreChecks(runChecks(noTwin()));
    expect(score.counts.locked).toBe(12);
    expect(score.locked.points).toBe(46);
    expect(score.locked.unlockedBy).toEqual(['B1']);
    // 46 points of questions nobody can answer yet must not appear in `possible`.
    expect(score.possible).toBe(76);
    expect(score.lost.map((entry) => entry.id)).not.toContain('B2');
  });

  it('do not fail a build, because only a real failure should', () => {
    const results = runChecks(noTwin());
    const failures = results.filter((result) => result.status === 'fail');
    // B1 is the one charge for the missing twin. Nothing downstream adds a second.
    expect(failures.map((result) => result.id)).toEqual(['B1']);
  });
});

describe('score arithmetic', () => {
  it('counts a partial\'s shortfall in `lost`, not its whole weight', () => {
    const evidence = perfect();
    evidence.html.headers.set('vary', 'Accept-Encoding');
    const score = scoreChecks(runChecks(evidence));
    expect(score.lost).toContainEqual({ id: 'B7', points: 2 });
    expect(score.counts.partial).toBe(1);
    expect(score.counts.fail).toBe(0);
  });

  it('ranks a big shortfall above a small one, so "do this next" is a real ranking', () => {
    const evidence = perfect();
    evidence.html.headers.set('vary', 'Accept-Encoding');
    evidence.llms = probe({ ok: false, status: 404, body: '' });
    const ranked = [...scoreChecks(runChecks(evidence)).lost].sort((a, b) => b.points - a.points);
    expect(ranked[0]).toEqual({ id: 'A2', points: 3 });
    expect(ranked[1]).toEqual({ id: 'B7', points: 2 });
  });

  it('never lets a partial be worth zero or full marks', () => {
    // A ramp that rounds to the edges would print "0 of 4" or "4 of 4" on a partial row.
    expect(partial('B7', 0, 'r').earned).toBe(1);
    expect(partial('B7', 99, 'r').earned).toBe(3);
    expect(partial('A4', 0, 'r').earned).toBe(1);
  });

  it('ramps linearly between the floor and the target', () => {
    const weight = checkDefinition('A5').weight;
    expect(ramp(15, 15, 60, weight)).toBe(0);
    expect(ramp(60, 15, 60, weight)).toBe(weight);
    expect(ramp(37.5, 15, 60, weight)).toBeCloseTo(weight / 2);
    // Clamped at both ends, so a measurement outside the range cannot produce a negative score.
    expect(ramp(-100, 15, 60, weight)).toBe(0);
    expect(ramp(1000, 15, 60, weight)).toBe(weight);
  });
});
