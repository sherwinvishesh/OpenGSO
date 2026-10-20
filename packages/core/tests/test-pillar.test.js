import { describe, expect, it } from 'vitest';
import { AEO_SPEC_VERSION, MARKDOWN_CONTENT_TYPE } from '@omnigeo/core/shared';
import { liveContentHash } from './helpers/live-hash.js';
import { CHECKS, failsBuild, fixSteps, renderReport, runChecks, scoreChecks, testEvidence } from '@omnigeo/core/test';
/** @import { ProbeResult } from '@omnigeo/core/shared' */
/** @import { Evidence } from '@omnigeo/core/test' */

/**
 * The whole checklist is driven from synthetic evidence, so these tests exercise the real check
 * logic with no network and no timing flakiness.
 */

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

/**
 * @returns {Evidence}
 */
function goodEvidence() {
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

/**
 * A site that never installed OmniGEO: real HTML, no `.md` layer anywhere. This is what the whole
 * web looks like today, so it is the case the scale has to get right.
 *
 * @returns {Evidence}
 */
function noTwinEvidence() {
  const evidence = goodEvidence();
  // A real site's HTML headers: HTTPS is a solved problem, the two AEO headers are not there.
  const html = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'strict-transport-security': 'max-age=63072000',
  });
  evidence.twin = probe({ ok: false, status: 404, body: '<!doctype html><html><body>404</body></html>' });
  evidence.advertisedTwinUrl = undefined;
  evidence.html = probe({ body: GOOD_HTML, headers: html });
  evidence.acceptMarkdown = probe({ headers: html });
  evidence.botUa = probe({ headers: html });
  evidence.notAcceptable = probe({ status: 200, headers: html });
  return evidence;
}

/**
 * The profile anthropic.com and openai.com actually have, as of this writing: robots.txt open to
 * AI crawlers, a real sitemap, the content server-rendered into the HTML, a fast first byte, no
 * opt-out tag, HTTPS with HSTS - and none of llms.txt, JSON-LD, or a markdown twin.
 *
 * @returns {Evidence}
 */
function unadoptedSiteEvidence() {
  const evidence = noTwinEvidence();
  evidence.llms = probe({ url: 'https://example.com/llms.txt', ok: false, status: 404, body: '' });
  evidence.html = probe({
    body: GOOD_HTML.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, ''),
    headers: evidence.html.headers,
  });
  return evidence;
}

/** @param {Evidence} evidence */
function byId(evidence) {
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

  it('A1 reads a training-crawler-only block as deliberate, and prices it rather than failing it', () => {
    const evidence = goodEvidence();
    evidence.robots = probe({ body: 'User-agent: CCBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n' });
    const check = byId(evidence).get('A1');
    // Partial, not fail: every agent that answers questions about the site is still allowed, which
    // is what decides whether the site shows up in AI answers at all.
    expect(check?.status).toBe('partial');
    expect(check?.earned).toBe(6);
    expect(check?.reason).toContain('CCBot');
    expect(check?.reason).toContain('deliberate opt-out');
    expect(check?.fix).toContain('the price of it');
  });

  it('A2 gives a served-but-thin llms.txt part of the weight, and a missing one none', () => {
    const evidence = goodEvidence();
    evidence.llms = probe({ body: 'Just some text.' });
    expect(byId(evidence).get('A2')?.status).toBe('partial');
    evidence.llms = probe({ body: '# Title only' });
    expect(byId(evidence).get('A2')?.reason).toContain('no links');
    // Links but no title is the closest miss of the three, so it is the one worth the most.
    evidence.llms = probe({ body: '- [Resume](https://example.com/resume.md)\n' });
    const untitled = byId(evidence).get('A2');
    expect(untitled?.status).toBe('partial');
    expect(untitled?.earned).toBe(2);

    evidence.llms = probe({ url: 'https://example.com/llms.txt', ok: false, status: 404, body: '' });
    expect(byId(evidence).get('A2')?.status).toBe('fail');
  });

  it('A3 separates "no sitemap", "not a sitemap" and "an incomplete sitemap"', () => {
    const evidence = goodEvidence();
    evidence.sitemap = probe({ body: '<html>not a sitemap</html>' });
    const notASitemap = byId(evidence).get('A3');
    expect(notASitemap?.status).toBe('partial');
    expect(notASitemap?.earned).toBe(3);

    // Valid, but it does not list the page being tested, which is the one page known to exist.
    evidence.sitemap = probe({ body: '<urlset><url><loc>https://example.com/other</loc></url></urlset>' });
    const incomplete = byId(evidence).get('A3');
    expect(incomplete?.status).toBe('partial');
    expect(incomplete?.earned).toBe(6);
    expect(incomplete?.reason).toContain('/resume');

    evidence.sitemap = probe({ ok: false, status: 404, body: '' });
    expect(byId(evidence).get('A3')?.status).toBe('fail');
  });

  it('A4 is partial on unparseable JSON-LD and names the parse error', () => {
    const evidence = goodEvidence();
    evidence.html = probe({ body: GOOD_HTML.replace('{"@context":"https://schema.org","@type":"Person","name":"A"}', '{oops'), headers: evidence.html.headers });
    const check = byId(evidence).get('A4');
    // A block that is there and broken is closer than no structured data at all, and the fix is
    // a different one, so the two are not the same result.
    expect(check?.status).toBe('partial');
    expect(check?.earned).toBe(1);
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
  it('charges a site with no markdown layer once, on B1, and locks the rest behind it', () => {
    const results = byId(noTwinEvidence());

    expect(results.get('B1')?.status).toBe('fail');
    for (const id of ['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'B14']) {
      expect(results.get(id)?.status, `${id} should be locked, not a second charge for one missing twin`).toBe('locked');
      expect(results.get(id)?.lockedBy).toBe('B1');
      expect(results.get(id)?.reason).toContain('reported once, on B1');
      // A locked check has nothing to act on yet, so it carries no fix of its own to compete with B1's.
      expect(results.get(id)?.fix).toBeUndefined();
    }
    // The human-facing site is untouched, which is exactly what "broken state" should still show.
    expect(results.get('B13')?.status).toBe('pass');
  });

  it('counts the locked block as suggestions waiting on B1, outside the score', () => {
    const score = scoreChecks(runChecks(noTwinEvidence()));
    expect(score.counts.locked).toBe(12);
    expect(score.locked.unlockedBy).toEqual(['B1']);
    // Every scored check applies and passes; B1 and the twelve behind it are suggestions.
    expect(score.possible).toBe(61);
    expect(score.value).toBe(100);
    // B13 is not locked because the HTML page still works, and A2 and A4 pass on this site, so
    // B1 is the one open suggestion and the other two adopted ones are llms.txt and JSON-LD.
    expect(score.suggestions).toEqual({ count: 15, adopted: 2, open: 1, locked: 12 });
  });

  it('never locks a scored check', () => {
    /** @type {Set<string>} */
    const scored = new Set(CHECKS.filter((check) => check.scored).map((check) => check.id));
    const evidence = noTwinEvidence();
    // The worst case the cascade sees: no twin, and the live URL failing every probe it makes.
    evidence.acceptMarkdown = probe({ ok: false, status: 500, headers: new Headers() });
    evidence.botUa = probe({ ok: false, status: 403, headers: new Headers() });
    for (const check of runChecks(evidence)) {
      if (scored.has(check.id)) expect(check.status, check.id).not.toBe('locked');
    }
  });

  it('keeps what the live site actually said, even on a check it no longer scores', () => {
    const evidence = noTwinEvidence();
    // What openai.com does: no twin, and the crawler is turned away at the edge. The check cannot
    // be scored, but a 403 to GPTBot is the most interesting thing on the page.
    evidence.botUa = probe({ ok: false, status: 403, body: '' });
    const check = byId(evidence).get('B10');
    expect(check?.status).toBe('locked');
    expect(check?.detail).toContain('403');
  });

  it('still scores a twin that exists but is wrong, in full detail', () => {
    const evidence = goodEvidence();
    evidence.twin = probe({ body: '# Resume', headers: new Headers({ 'content-type': 'text/plain' }) });
    const results = byId(evidence);
    expect(results.get('B1')?.status).toBe('pass');
    // Scored, not locked: there is a real response here to have an opinion about.
    expect(results.get('B2')?.status).toBe('partial');
    expect(results.get('B2')?.earned).toBe(2);
  });

  it('B2 rejects text/plain even when the body is real markdown', () => {
    const evidence = goodEvidence();
    evidence.twin = probe({ body: '# Resume', headers: new Headers({ 'content-type': 'text/plain; charset=utf-8' }) });
    expect(byId(evidence).get('B2')?.reason).toContain('text/plain');
  });

  it('B1 catches an HTML document served at the .md URL, and locks what depends on it', () => {
    const evidence = goodEvidence();
    evidence.twin = probe({ body: '<!doctype html><html><body>Not found</body></html>', headers: new Headers({ 'content-type': MARKDOWN_CONTENT_TYPE }) });
    const results = byId(evidence);
    expect(results.get('B1')?.status).toBe('fail');
    expect(results.get('B1')?.reason).toContain('HTML page');
    expect(results.get('B3')?.status).toBe('locked');
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

  it('lets a scored failure move the score and leaves it alone for a suggestion', () => {
    const missingScored = goodEvidence();
    missingScored.robots = probe({ ok: false, status: 404 });
    const missingSuggestion = goodEvidence();
    missingSuggestion.twin.headers.delete('x-content-type-options');

    expect(scoreChecks(runChecks(missingScored)).value).toBeLessThan(100);
    const suggestion = scoreChecks(runChecks(missingSuggestion));
    expect(suggestion.value).toBe(100);
    expect(suggestion.suggestions.open).toBe(1);
  });

  it('records the points lost per failing scored check, for the fix prompt', () => {
    const evidence = goodEvidence();
    evidence.sitemap = probe({ ok: false, status: 404 });
    evidence.llms = probe({ ok: false, status: 404 });
    const score = scoreChecks(runChecks(evidence));
    // A3 is scored and A2 is a suggestion, so only A3 is a loss.
    expect(score.lost).toEqual([{ id: 'A3', points: 9 }]);
    expect(score.suggestions.open).toBe(1);
  });

  it('fails the build on a scored failure, and on a suggestion only when asked to be strict', () => {
    const scoredFail = goodEvidence();
    scoredFail.sitemap = probe({ ok: false, status: 404 });
    expect(failsBuild(runChecks(scoredFail))).toBe(true);

    const suggestionFail = runChecks(noTwinEvidence());
    expect(failsBuild(suggestionFail)).toBe(false);
    expect(failsBuild(suggestionFail, { strict: true })).toBe(true);

    expect(failsBuild(runChecks(goodEvidence()), { strict: true })).toBe(false);
  });

  it('ranks the scored fixes first, then the suggestions by weight with B1 saying what it unlocks', () => {
    const evidence = unadoptedSiteEvidence();
    evidence.sitemap = probe({ ok: false, status: 404 });
    const checks = runChecks(evidence);
    const steps = fixSteps(checks, scoreChecks(checks));
    expect(steps.map((step) => step.id)).toEqual(['A3', 'B1', 'A2', 'A4']);
    expect(steps[0].points).toBeGreaterThan(0);
    expect(steps.slice(1).every((step) => step.suggestion && step.points === 0)).toBe(true);
    expect(steps[1].unlocks).toBe(12);
    expect(steps[1].text).toContain('12 more suggestions measurable');
  });

  it('reports a score of 0 when nothing can be scored', () => {
    expect(scoreChecks([]).value).toBe(0);
  });

  it('treats a stale twin on a site that serves one as something to fix, not a convention to adopt', () => {
    // What a price change without a regenerate looks like: the twin is served, the score is full,
    // and agents are quoted the old number.
    const evidence = goodEvidence();
    evidence.twin.headers.set('x-markdown-source-hash', 'deadbeefdeadbeef');
    evidence.html = probe({ body: GOOD_HTML.replace('in 2024', 'in 2025'), headers: evidence.html.headers });
    const result = testEvidence(evidence);
    expect(result.score.value).toBe(100);
    expect(result.checks.find((check) => check.id === 'B14')?.status).toBe('fail');

    const steps = fixSteps(result.checks, result.score);
    expect(steps[0]).toMatchObject({ id: 'B14', suggestion: true, fault: true, points: 0 });

    const plain = renderReport(result, { width: 200 }).replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
    expect(plain).toContain('WARN B14');
    expect(plain).toContain('B14 fails on the markdown twin this page already serves, so agents are being sent something wrong.');
    expect(plain).toContain('--strict fails a build on it');
    expect(plain).toContain('Every scored check passed, but B14 fails on the twin agents are served.');
    expect(plain).toContain('Fix the twin next');
    expect(plain).toMatch(/fix {2}B14 {2}Re-run `omnigeo generate`/);
    expect(plain).not.toContain('Nothing to fix');
    expect(plain).not.toContain('Worth adopting next');
    expect(plain).not.toContain('this page has not adopted');

    // The headline is unchanged, which is why --strict is the switch that catches it in CI.
    expect(failsBuild(result.checks)).toBe(false);
    expect(failsBuild(result.checks, { strict: true })).toBe(true);
  });

  it('keeps a tip out from under the twin-fault heading', () => {
    const evidence = goodEvidence();
    evidence.twin.headers.set('x-markdown-source-hash', 'deadbeefdeadbeef');
    // Next's App Router: Vary on the markdown side only, so B7 is adopted in part.
    evidence.html = probe({
      body: GOOD_HTML.replace('in 2024', 'in 2025'),
      headers: new Headers([...evidence.html.headers].filter(([name]) => name !== 'vary')),
    });
    const result = testEvidence(evidence);
    expect(result.checks.find((check) => check.id === 'B7')?.status).toBe('partial');

    const plain = renderReport(result, { width: 200 }).replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
    const footer = plain.slice(plain.indexOf('Every scored check passed, but B14'));
    const twinHeading = footer.indexOf('Fix the twin next');
    const tipHeading = footer.indexOf('Then, to stand out');
    expect(twinHeading).toBeGreaterThan(-1);
    expect(tipHeading).toBeGreaterThan(twinHeading);
    expect(footer.indexOf(' fix  B14')).toBeGreaterThan(twinHeading);
    expect(footer.indexOf(' fix  B14')).toBeLessThan(tipHeading);
    expect(footer.indexOf(' tip  B7')).toBeGreaterThan(tipHeading);
  });

  it('keeps the ordinary wording when the twin is merely cosmetically behind or never served', () => {
    const cosmetic = goodEvidence();
    cosmetic.twin.headers.set('x-markdown-source-hash', 'deadbeefdeadbeef');
    const behind = testEvidence(cosmetic);
    expect(fixSteps(behind.checks, behind.score).some((step) => step.fault)).toBe(false);
    const plain = renderReport(behind, { width: 400 }).replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
    expect(plain).not.toContain('agents are being sent something wrong');
    // A twin behind the page is a convention adopted in part, and the intro says so.
    expect(plain).toContain('Conventions for AI agents this page has adopted in part.');

    const unadopted = runChecks(unadoptedSiteEvidence());
    expect(fixSteps(unadopted, scoreChecks(unadopted)).some((step) => step.fault)).toBe(false);
  });
});

/**
 * The calibration, pinned.
 *
 * A weight table is only worth anything if the numbers it produces mean something to a person
 * reading them, and the way to know that is to check it against sites whose quality is not in
 * doubt. These assertions are what stop a well-meaning edit from quietly putting the best-read sites
 * on the web below 100 for not having adopted a convention nobody has adopted yet.
 */
describe('the scale, measured against a site that does everything but markdown', () => {
  it('puts a site that does everything but the AI conventions at 100, with three suggestions open', () => {
    const score = scoreChecks(runChecks(unadoptedSiteEvidence()));
    expect(score.value).toBe(100);
    expect(score.lost).toEqual([]);
    // The three things it is missing, as suggestions, and the twelve that wait on the twin.
    const open = runChecks(unadoptedSiteEvidence()).filter((check) => !check.scored && check.status === 'fail');
    expect(open.map((check) => check.id)).toEqual(['A2', 'A4', 'B1']);
    expect(score.suggestions).toEqual({ count: 15, adopted: 0, open: 3, locked: 12 });
  });

  it('keeps the same site at 100 once it serves a twin, with every suggestion adopted', () => {
    const score = scoreChecks(runChecks(goodEvidence()));
    expect(score.value).toBe(100);
    expect(score.suggestions).toEqual({ count: 15, adopted: 15, open: 0, locked: 0 });
  });

  it('moves the number below 100 only for a scored failure', () => {
    const evidence = unadoptedSiteEvidence();
    evidence.html = probe({ body: '<!doctype html><html><head><title>x</title></head><body><div id="root"></div></body></html>', headers: evidence.html.headers });
    expect(scoreChecks(runChecks(evidence)).value).toBeLessThan(100);
  });

  it('leaves the markdown twin as the largest single thing anyone can lose', () => {
    const heaviest = [...CHECKS].sort((a, b) => b.weight - a.weight);
    expect(heaviest[0].id).toBe('B1');
    // B1 is the only double-digit check. Everything else is single digits on purpose: no header
    // detail should be able to sink a site that got the important things right.
    expect(heaviest.slice(1).every((check) => check.weight < 10)).toBe(true);
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
  // The twin keeps its own `Vary: Accept` in this fixture, so a header that does not parse as
  // Accept on the HTML side leaves exactly one of the two responses correct: a partial, which is
  // also the permanent state of a Next.js App Router deployment.
  /** @type {Array<[string, 'pass' | 'partial']>} */
  const cases = [
    ['Accept', 'pass'],
    ['accept', 'pass'],
    ['Accept, Accept-Encoding', 'pass'],
    ['*', 'pass'],
    // The trap: nearly every compressed response carries this, and a substring match passes it.
    ['Accept-Encoding', 'partial'],
    ['rsc, next-router-state-tree, next-router-prefetch, Accept-Encoding', 'partial'],
    ['', 'partial'],
  ];

  for (const [header, expected] of cases) {
    it(`treats "${header || '(absent)'}" as ${expected}`, () => {
      const evidence = goodEvidence();
      evidence.html.headers.set('vary', header);
      expect(byId(evidence).get('B7')?.status).toBe(expected);
    });
  }

  it('is a full failure only when neither response carries it', () => {
    const evidence = goodEvidence();
    evidence.html.headers.delete('vary');
    evidence.twin.headers.delete('vary');
    expect(byId(evidence).get('B7')?.status).toBe('fail');
  });
});

describe('B14 staleness and drift', () => {
  it('passes on an exact hash match, which is the only path that proves freshness', () => {
    const check = byId(goodEvidence()).get('B14');
    expect(check?.status).toBe('pass');
    expect(check?.reason).toContain('exactly this version');
  });

  it('grades a stale hash by how far the content actually drifted', () => {
    const evidence = goodEvidence();
    evidence.twin.headers.set('x-markdown-source-hash', 'deadbeefdeadbeef');
    // The hash is wrong but every fact in the page is still in the twin, which is what a typo fix
    // or a nav change looks like. Serving it is not ideal; it is not serving wrong information.
    const cosmetic = byId(evidence).get('B14');
    expect(cosmetic?.status).toBe('partial');
    expect(cosmetic?.reason).toContain('cosmetic');
    expect(cosmetic?.fix).toContain('omnigeo generate');
    expect(cosmetic?.detail).toContain('deadbeefdeadbeef');

    // A real rewrite: a fact on the live page is nowhere in the twin.
    evidence.html = probe({
      body: GOOD_HTML.replace('in 2024', 'in 2025'),
      headers: evidence.html.headers,
    });
    const real = byId(evidence).get('B14');
    expect(real?.status).toBe('fail');
    expect(real?.reason).toContain('changed since the twin was generated');
    // Named from the twin's side, in the reason: no model was involved in a free-tier twin going
    // stale, and the fact that moved is the part a reader needs first.
    expect(real?.reason).toContain('The live page now states 1 fact the twin does not: "2025"');
    expect(real?.reason).not.toContain('model');
    expect(real?.fix).toContain('omnigeo generate');
    expect(real?.detail).toContain('deadbeefdeadbeef');
  });

  it('reads the hash out of frontmatter when the twin is served as a plain static file', () => {
    const evidence = goodEvidence();
    evidence.twin.headers.delete('x-markdown-source-hash');
    evidence.twin.body = `---\nsource_hash: "${liveContentHash(GOOD_HTML)}"\n---\n\n${GOOD_TWIN}`;
    const check = byId(evidence).get('B14');
    expect(check?.status).toBe('pass');
    expect(check?.reason).toContain('exactly this version');
  });

  it('reads the page at its published address when it is tested somewhere else', () => {
    // A dev server or a local preview of the build: every link on the page names this machine and
    // every link in the twin names the published site, which is not the page changing.
    const html = GOOD_HTML.replace('legible.</p>', 'legible. See <a href="/work">the work</a>.</p>');
    const evidence = goodEvidence();
    evidence.target = new URL('http://localhost:3000/resume');
    evidence.html = probe({ body: html, headers: evidence.html.headers, url: evidence.target.toString(), finalUrl: evidence.target.toString() });
    evidence.twin.headers.set('x-markdown-source-hash', liveContentHash(html, 'https://example.com/resume'));
    expect(byId(evidence).get('B14')?.status).not.toBe('pass');

    evidence.publicOrigin = 'https://example.com';
    const check = byId(evidence).get('B14');
    expect(check?.status).toBe('pass');
    expect(check?.detail).toContain('read as https://example.com/resume');
  });

  it('reads it at the url in the frontmatter of a twin a static host serves, folder and all', () => {
    const html = GOOD_HTML.replace('legible.</p>', 'legible. See <a href="work">the work</a>.</p>');
    const evidence = goodEvidence();
    // A GitHub Pages project site previewed from its folder at the root of a local server.
    evidence.target = new URL('http://127.0.0.1:8080/resume');
    evidence.html = probe({ body: html, headers: evidence.html.headers, url: evidence.target.toString(), finalUrl: evidence.target.toString() });
    evidence.twin.headers.delete('x-markdown-source-hash');
    const published = 'https://user.github.io/repo/resume';
    evidence.twin.body = `---\nurl: "${published}"\nsource_hash: "${liveContentHash(html, published)}"\n---\n\n${GOOD_TWIN}`;
    expect(byId(evidence).get('B14')?.status).toBe('pass');

    // The config says the same thing in its own words, and a preview with or without the folder
    // in its path lands on the same published page.
    evidence.twin.body = GOOD_TWIN;
    evidence.twin.headers.set('x-markdown-source-hash', liveContentHash(html, published));
    evidence.publicOrigin = 'https://user.github.io/repo';
    expect(byId(evidence).get('B14')?.status).toBe('pass');
    evidence.target = new URL('http://127.0.0.1:8080/repo/resume');
    expect(byId(evidence).get('B14')?.status).toBe('pass');
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
    expect(byId(evidence).get('B14')?.reason).toContain('No markdown twin');
  });

  it('is not applicable when the live page itself is unreachable', () => {
    const evidence = goodEvidence();
    evidence.html = probe({ ok: false, status: 500, body: '' });
    expect(byId(evidence).get('B14')?.status).toBe('na');
  });
});

describe('the score stays honest when most of the checklist cannot apply', () => {
  /**
   * Synthetic checks, so the weighting can be reasoned about without the whole catalogue.
   *
   * @param {Array<[string, 'pass' | 'fail' | 'na', number]>} spec
   */
  function synthetic(spec) {
    return spec.map(([id, status, weight]) => ({
      id,
      category: /** @type {const} */ ('A'),
      importance: /** @type {const} */ ('required'),
      scored: true,
      weight,
      title: id,
      status,
      earned: status === 'pass' ? weight : 0,
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

  it('prints a reason built from page bytes without letting them drive the terminal', () => {
    const result = testEvidence(goodEvidence());
    const check = result.checks.find((entry) => entry.status !== 'na') ?? result.checks[0];
    // As the A4 reason did, quoting a JSON-LD block that carried a title-setting escape.
    check.status = 'fail';
    check.reason = 'JSON-LD names \u001b]0;pwned\u0007\u001b[2K\rsomething';
    check.detail = '\u001b[8mhidden';
    const report = renderReport(result, { verbose: true });
    const ours = report.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
    expect(ours).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(ours).toContain('pwned');
  });

  it('never returns a letter grade or a tier label anywhere in the report', () => {
    const report = renderReport(testEvidence(goodEvidence()), { verbose: true });
    const plain = report.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
    expect(plain).toMatch(/\d+\/100/);
    expect(plain).not.toMatch(/\bgrade\b/i);
    expect(plain).not.toMatch(/\b(bronze|silver|gold|platinum)\b/i);
  });
});
