import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverTwins,
  markdownLinksIn,
  reviewContent,
  runTestSuite,
  sitemapTwins,
  suiteExitCode,
  suiteJson,
} from '@opengeo/core/test';
import { resolveMode } from '@opengeo/core/cli/commands/test';
/** @import { Server } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */
/** @import { ProviderCall } from '@opengeo/core/generate' */
/** @import { SuiteProgress, SuiteResult, TestResult } from '@opengeo/core/test' */

/**
 * The two halves of a test run, and the sequencer that decides which of them happen.
 *
 * Discovery runs against a real server for the same reason generate's tests do: it is a
 * fetch-and-judge pipeline, and a stubbed fetch would test the judging alone. The model, by
 * contrast, is always a fake, because a real one would make the suite cost money and stop being
 * reproducible.
 */

const MD_HOME = '# Home\n\nOpenGEO turns a website into something an agent can read.';
const MD_ABOUT = '# About\n\nFounded in 2019. Three people.';

/** Whether the site advertises llms.txt and sitemap.xml. Flipped per test. */
let serveLlms = true;
let serveSitemap = true;
/** A route that answers `.md` with an HTML shell: the most common false positive discovery has. */
let htmlAtMd = false;

/** @type {Server} */
let server;
/** @type {string} */
let site;

beforeEach(() => {
  serveLlms = true;
  serveSitemap = true;
  htmlAtMd = false;
});

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    /**
     * @param {number} status
     * @param {string} type
     * @param {string} body
     */
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };

    if (path === '/llms.txt') {
      if (!serveLlms) return send(404, 'text/plain', 'not found');
      return send(200, 'text/plain', `# Site\n\n- [Home](${site}/index.md)\n- [About](${site}/about.md)\n`);
    }
    if (path === '/sitemap.xml') {
      if (!serveSitemap) return send(404, 'application/xml', 'not found');
      return send(
        200,
        'application/xml',
        `<?xml version="1.0"?><urlset><url><loc>${site}/</loc></url><url><loc>${site}/ghost</loc></url></urlset>`,
      );
    }
    if (path === '/index.md') return send(200, 'text/markdown', MD_HOME);
    if (path === '/about.md') return send(200, 'text/markdown', MD_ABOUT);
    if (path === '/ghost.md') {
      return htmlAtMd
        ? send(200, 'text/html', '<!doctype html><html><body>Not found</body></html>')
        : send(404, 'text/plain', 'not found');
    }
    // User-Agent routing configured for ClaudeBot alone, the way `bots.markdownRouting` would.
    if (path === '/' && /ClaudeBot/.test(req.headers['user-agent'] ?? '')) return send(200, 'text/markdown; charset=utf-8', MD_HOME);
    return send(200, 'text/html', '<!doctype html><html><head><title>Home</title></head><body><main><h1>Home</h1></main></body></html>');
  });
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  site = `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`;
});

afterAll(async () => {
  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
});

// -- flags to modes --------------------------------------------------------------------------

describe('resolveMode', () => {
  /** @param {...string} set */
  const args = (...set) => ({ bool: (/** @type {string} */ name) => set.includes(name) });

  it('runs both halves by default', () => {
    expect(resolveMode(args())).toBe('full');
  });

  it('treats --structure, --offline and -nq as the same request', () => {
    expect(resolveMode(args('structure'))).toBe('structure');
    expect(resolveMode(args('offline'))).toBe('structure');
    expect(resolveMode(args('no-quality'))).toBe('structure');
  });

  it('runs the review alone under --content', () => {
    expect(resolveMode(args('content'))).toBe('content');
  });

  it('refuses the contradiction rather than picking a winner', () => {
    const answer = resolveMode(args('structure', 'content'));
    expect(typeof answer).not.toBe('string');
    expect(/** @type {{ error: string }} */ (answer).error).toMatch(/Pick one/);
  });

  it('does not read -q as a mode of its own', () => {
    expect(resolveMode(args('quality'))).toBe('full');
  });
});

// -- discovery -------------------------------------------------------------------------------

describe('discoverTwins', () => {
  it('finds the documents llms.txt lists, plus the twin of the page asked about', async () => {
    const result = await discoverTwins(new URL(`${site}/`));
    expect(result.twins.map((twin) => new URL(twin.url).pathname).sort()).toEqual(['/about.md', '/index.md']);
    expect(result.sources).toEqual({ llms: true, sitemap: true });
  });

  it('maps sitemap URLs through the twin convention and keeps only what is really Markdown', async () => {
    serveLlms = false;
    const result = await discoverTwins(new URL(`${site}/`));
    expect(result.twins.map((twin) => new URL(twin.url).pathname)).toEqual(['/index.md']);
    // /ghost came from the sitemap, was fetched, and 404'd. Reporting it is the point.
    expect(result.rejected.map((entry) => new URL(entry.url).pathname)).toContain('/ghost.md');
    expect(result.rejected.find((entry) => entry.url.endsWith('/ghost.md'))?.reason).toMatch(/HTTP 404/);
  });

  it('rejects a .md route that answers with an HTML shell', async () => {
    serveLlms = false;
    htmlAtMd = true;
    const result = await discoverTwins(new URL(`${site}/`));
    expect(result.rejected.find((entry) => entry.url.endsWith('/ghost.md'))?.reason).toMatch(/HTML, not Markdown/);
    expect(result.twins.map((twin) => twin.url)).not.toContain(`${site}/ghost.md`);
  });

  it('reviews the document itself when the URL given is already Markdown', async () => {
    const result = await discoverTwins(new URL(`${site}/about.md`));
    expect(result.twins[0]?.url).toBe(`${site}/about.md`);
    expect(result.twins[0]?.source).toBe('requested');
  });

  it('caps how many candidates it fetches, and says how many it dropped', async () => {
    const result = await discoverTwins(new URL(`${site}/`), { maxFetch: 1 });
    expect(result.twins.length + result.rejected.length).toBe(1);
    expect(result.overCap).toBeGreaterThan(0);
  });

  it('counts words and records where each document came from', async () => {
    const result = await discoverTwins(new URL(`${site}/`));
    const about = result.twins.find((twin) => twin.url.endsWith('/about.md'));
    expect(about?.source).toBe('llms.txt');
    expect(about?.words).toBeGreaterThan(3);
    expect(about?.pageUrl).toBe(`${site}/about`);
  });
});

describe('the two parsers discovery leans on', () => {
  it('takes only same-origin markdown links out of llms.txt', () => {
    const body = '- [A](https://x.example/a.md)\n- [B](https://other.example/b.md)\n- [C](/c.md)\n- [D](/d.html)';
    expect(markdownLinksIn(body, 'https://x.example')).toEqual(['https://x.example/a.md', 'https://x.example/c.md']);
  });

  it('maps sitemap locs through the twin convention', () => {
    const body = '<urlset><url><loc>https://x.example/a</loc></url><url><loc>https://x.example/b.md</loc></url></urlset>';
    expect(sitemapTwins(body, 'https://x.example')).toEqual(['https://x.example/a.md', 'https://x.example/b.md']);
  });
});

// -- the model half ----------------------------------------------------------------------------

/**
 * A model that always answers in the documented JSON shape.
 *
 * `scores` keys are URL fragments, so a test can make one document weak and another strong. Only
 * two of the five areas are scored, which is on purpose: the score has to come out right when the
 * model answers part of the question, and every real reply eventually will.
 *
 * @param {Record<string, number>} [scores]
 */
function fakeModel(scores = {}) {
  /** @type {ProviderCall[]} */
  const calls = [];
  /** @param {ProviderCall} call */
  const fn = async (call) => {
    calls.push(call);
    const url = /https?:\/\/\S+/.exec(call.prompt)?.[0] ?? '';
    const score = Object.entries(scores).find(([key]) => url.includes(key))?.[1] ?? 80;
    return JSON.stringify({
      summary: `Reviewed ${url}`,
      findings: [
        { area: 'Definition', score, note: 'Says what it is.' },
        { area: 'Keywords', score: 40, note: 'Thin.' },
      ],
      recommendations: [
        { area: 'Definition', priority: 'high', action: 'Name the product in the first sentence.', impact: 'An agent knows what it is reading about.' },
      ],
    });
  };
  return { calls, fn };
}

/**
 * What `fakeModel` scores a document, given its Definition score. Definition 20, Keywords 10.
 *
 * @param {number} definition
 * @returns {number}
 */
function expectedScore(definition) {
  return Math.round((definition * 20 + 40 * 10) / 30);
}

/**
 * @param {string} url
 * @param {string} markdown
 */
const twin = (url, markdown) => ({
  url,
  pageUrl: url.replace(/\.md$/, ''),
  source: /** @type {const} */ ('llms.txt'),
  markdown,
  bytes: markdown.length,
  words: markdown.split(/\s+/).length,
});

describe('reviewContent', () => {
  const twins = [twin('https://x.example/a.md', MD_HOME), twin('https://x.example/b.md', MD_ABOUT)];

  it('scores every document and averages them into one number out of 100', async () => {
    const model = fakeModel({ '/a.md': 100, '/b.md': 40 });
    const review = await reviewContent(twins, { provider: 'anthropic', apiKey: 'k', call: model.fn, env: {} });
    expect(model.calls).toHaveLength(2);
    expect(review.documents.map((doc) => doc.review?.score)).toEqual([expectedScore(100), expectedScore(40)]);
    expect(review.score).toBe(Math.round((expectedScore(100) + expectedScore(40)) / 2));
    expect(review.notReviewed).toBe(0);
  });

  it('aggregates by area, costliest first, so there is something to go fix', async () => {
    const model = fakeModel({ '/a.md': 100, '/b.md': 100 });
    const review = await reviewContent(twins, { provider: 'anthropic', apiKey: 'k', call: model.fn, env: {} });

    // Definition is perfect and costs nothing, so the one weak area leads even though it is the
    // lighter of the two. Ordering on the raw score alone would have put them the other way round.
    expect(review.areaScores.map((area) => area.area)).toEqual(['Keywords', 'Definition']);
    expect(review.areaScores[0]).toMatchObject({ score: 40, weight: 10, lost: 6, documents: 2 });
    expect(review.areaScores[1]).toMatchObject({ score: 100, lost: 0 });
  });

  it('collapses the same edit across documents into one job with both URLs on it', async () => {
    const model = fakeModel();
    const review = await reviewContent(twins, { provider: 'anthropic', apiKey: 'k', call: model.fn, env: {} });

    expect(review.recommendations).toHaveLength(1);
    expect(review.recommendations[0]).toMatchObject({ priority: 'high', area: 'Definition' });
    expect(review.recommendations[0]?.documents).toEqual(['https://x.example/a.md', 'https://x.example/b.md']);
  });

  it('caps the number of documents, because every one is a paid call', async () => {
    const model = fakeModel();
    const review = await reviewContent(twins, {
      provider: 'anthropic',
      apiKey: 'k',
      call: model.fn,
      env: {},
      maxDocuments: 1,
    });
    expect(model.calls).toHaveLength(1);
    expect(review.documents).toHaveLength(1);
    expect(review.notReviewed).toBe(1);
  });

  it('keeps one failed document from losing the others', async () => {
    let first = true;
    /** @param {ProviderCall} request */
    const call = async (request) => {
      if (first) {
        first = false;
        throw new Error('502 from the provider');
      }
      return fakeModel().fn(request);
    };
    const review = await reviewContent(twins, { provider: 'anthropic', apiKey: 'k', call, env: {}, concurrency: 1 });
    expect(review.documents[0]?.error).toMatch(/502/);
    expect(review.documents[1]?.review?.score).toBe(expectedScore(80));
  });

  it('stops sending documents once the provider refuses the key', async () => {
    // A real endpoint on loopback, so the status travels through the same wire code a live run uses.
    let hits = 0;
    const provider = createServer((req, res) => {
      hits += 1;
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"type":"authentication_error","message":"invalid x-api-key"}}');
    });
    await /** @type {Promise<void>} */ (new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve)));
    const baseUrl = `http://127.0.0.1:${/** @type {AddressInfo} */ (provider.address()).port}`;
    try {
      const ten = Array.from({ length: 10 }, (_, i) => twin(`https://x.example/${i}.md`, MD_HOME));
      const review = await reviewContent(ten, { provider: 'anthropic', apiKey: 'wrong', overrides: { baseUrl }, env: {} });
      // One batch went out before the answer came back, and nothing after it.
      expect(hits).toBe(3);
      expect(review.halted).toMatch(/401/);
      expect(review.documents[0]?.error).toMatch(/401/);
      expect(review.documents[9]?.error).toMatch(/not sent/i);
    } finally {
      await /** @type {Promise<void>} */ (new Promise((resolve) => provider.close(() => resolve())));
    }
  });

  it('refuses to run in CI, where a key must never be present', async () => {
    await expect(
      reviewContent(twins, { provider: 'anthropic', apiKey: 'k', call: fakeModel().fn, env: { CI: 'true' } }),
    ).rejects.toThrow(/local/i);
  });

  it('reports progress per document', async () => {
    /** @type {number[]} */
    const seen = [];
    await reviewContent(twins, {
      provider: 'anthropic',
      apiKey: 'k',
      call: fakeModel().fn,
      env: {},
      concurrency: 1,
      onProgress: (done) => seen.push(done),
    });
    expect(seen).toEqual([1, 2]);
  });

  it('stops making paid calls once the run is abandoned', async () => {
    const model = fakeModel();
    const controller = new AbortController();
    const many = Array.from({ length: 6 }, (_, i) => twin(`https://x.example/${i}.md`, MD_HOME));
    await expect(
      reviewContent(many, {
        provider: 'anthropic',
        apiKey: 'k',
        call: model.fn,
        env: {},
        concurrency: 1,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(model.calls).toHaveLength(1);
  });
});

// -- the sequencer -----------------------------------------------------------------------------

describe('runTestSuite', () => {
  const ai = () => ({ provider: /** @type {const} */ ('anthropic'), apiKey: 'k', call: fakeModel().fn });

  it('structure mode runs the checks and never touches a model', async () => {
    const model = fakeModel();
    const result = await runTestSuite(`${site}/`, {
      mode: 'structure',
      ai: { provider: 'anthropic', apiKey: 'k', call: model.fn },
      env: {},
    });
    expect(result.structure?.score.value).toBeGreaterThanOrEqual(0);
    expect(result.content).toBeUndefined();
    expect(result.discovery).toBeUndefined();
    expect(model.calls).toHaveLength(0);
  });

  it('content mode skips the checks entirely', async () => {
    const result = await runTestSuite(`${site}/`, { mode: 'content', ai: ai(), env: {} });
    expect(result.structure).toBeUndefined();
    expect(result.content?.documents.length).toBeGreaterThan(0);
  });

  it('full mode runs the checks first and reviews what they found', async () => {
    /** @type {SuiteProgress['phase'][]} */
    const phases = [];
    const result = await runTestSuite(`${site}/`, {
      mode: 'full',
      ai: ai(),
      env: {},
      onProgress: (event) => phases.push(event.phase),
    });
    expect(result.structure).toBeDefined();
    expect(result.content?.documents.length).toBe(2);
    // The structural report exists before the paid pass starts, and the CLI prints it there.
    expect(phases.indexOf('structure-done')).toBeLessThan(phases.indexOf('discover'));
    expect(phases).toContain('review');
  });

  it('throws an abandoned run rather than reporting it as a content error', async () => {
    const controller = new AbortController();
    const run = runTestSuite(`${site}/`, {
      mode: 'full',
      ai: ai(),
      env: {},
      signal: controller.signal,
      onProgress: (event) => {
        if (event.phase === 'review') controller.abort();
      },
    });
    await expect(run).rejects.toThrow(expect.objectContaining({ name: 'AbortError' }));
  });

  it('never starts the paid pass once the run is abandoned during the checks', async () => {
    const model = fakeModel();
    const controller = new AbortController();
    const run = runTestSuite(`${site}/`, {
      mode: 'full',
      ai: { provider: 'anthropic', apiKey: 'k', call: model.fn },
      env: {},
      signal: controller.signal,
      onProgress: (event) => {
        if (event.phase === 'structure-done') controller.abort();
      },
    });
    await expect(run).rejects.toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(model.calls).toHaveLength(0);
  });

  it('notes a missing key in full mode and refuses in content mode', async () => {
    const full = await runTestSuite(`${site}/`, { mode: 'full', env: {} });
    expect(full.structure).toBeDefined();
    expect(full.contentSkipped).toMatch(/key/i);
    expect(full.contentError).toBeUndefined();

    const content = await runTestSuite(`${site}/`, { mode: 'content', env: {} });
    expect(content.contentError).toMatch(/key/i);
    expect(content.contentSkipped).toBeUndefined();
  });

  it('turns a missing key into a refusal when the run was asked for by name', async () => {
    const result = await runTestSuite(`${site}/`, { mode: 'full', requireContent: true, env: {} });
    expect(result.contentError).toMatch(/key/i);
    expect(result.structure).toBeDefined();
  });

  it('says what it tried when there is nothing to review', async () => {
    serveLlms = false;
    serveSitemap = false;
    const result = await runTestSuite(`${site}/nowhere`, { mode: 'content', ai: ai(), env: {} });
    expect(result.contentError).toMatch(/No Markdown documents/);
    expect(result.contentError).toMatch(/neither llms\.txt nor sitemap\.xml/);
    expect(result.contentError).toMatch(/opengeo generate/);
  });

  it('probes B10 with a crawler the project actually routes', async () => {
    const b10 = async (/** @type {string[] | undefined} */ markdownRouting) => {
      const result = await runTestSuite(`${site}/`, { mode: 'structure', markdownRouting, env: {} });
      return result.structure?.checks.find((check) => check.id === 'B10');
    };
    // Routing narrowed to ClaudeBot: a GPTBot probe would report a failure the site does not have.
    const routed = await b10(['ClaudeBot']);
    expect(routed?.status).toBe('pass');
    // GPTBot is still the probe whenever the list includes it, or there is no list.
    expect((await b10(undefined))?.reason).toMatch(/GPTBot/);
    expect((await b10(['ClaudeBot', 'GPTBot']))?.reason).toMatch(/GPTBot/);
  });

  it('rejects a target that is not a URL', async () => {
    await expect(runTestSuite('not a url', { mode: 'structure' })).rejects.toThrow();
  });
});

describe('suiteExitCode', () => {
  /**
   * The same result with the structural tally replaced, so the exit code can be held to a literal
   * for a site that is clean and one that is not.
   *
   * @param {SuiteResult} result
   * @param {TestResult['score']['counts']} counts
   */
  const withCounts = (result, counts) => {
    const structure = /** @type {TestResult} */ (result.structure);
    return { ...result, structure: { ...structure, score: { ...structure.score, counts } } };
  };

  it('lets the structural checks decide whenever there were any', async () => {
    // The fixture site has no twin routing and no robots.txt, so real checks fail on it.
    const result = await runTestSuite(`${site}/`, { mode: 'full', env: {} });
    expect(/** @type {TestResult} */ (result.structure).score.counts.fail).toBeGreaterThan(0);
    expect(suiteExitCode(result)).toBe(1);

    // Partials and locked lines are not failures: a site at 98/100 with B7 half done exits 0.
    expect(suiteExitCode(withCounts(result, { pass: 18, partial: 2, fail: 0, locked: 0, na: 1 }))).toBe(0);
    expect(suiteExitCode(withCounts(result, { pass: 5, partial: 3, fail: 1, locked: 12, na: 1 }))).toBe(1);
  });

  it('never fails a build over the content score', async () => {
    const result = await runTestSuite(`${site}/`, { mode: 'full', ai: { provider: 'anthropic', apiKey: 'k', call: fakeModel({ '': 0 }).fn }, env: {} });
    // Every document scored as badly as the model can score it, and the exit code still comes from
    // the checks alone. The two numbers never meet, and this is where that is enforced.
    expect(result.content?.score).toBe(expectedScore(0));
    const clean = withCounts(result, { pass: 20, partial: 0, fail: 0, locked: 0, na: 1 });
    expect(suiteExitCode(clean)).toBe(0);
    expect(suiteExitCode({ ...clean, contentError: 'The provider refused the request with 401.' })).toBe(0);
  });

  it('fails a content-only run that could not run at all', async () => {
    const result = await runTestSuite(`${site}/`, { mode: 'content', env: {} });
    expect(suiteExitCode(result)).toBe(1);
  });

  it('fails a content-only run in which every document errored', async () => {
    const call = async () => {
      throw new Error('The Anthropic API returned 502.');
    };
    const result = await runTestSuite(`${site}/`, { mode: 'content', ai: { provider: 'anthropic', apiKey: 'k', call }, env: {} });
    expect(result.content?.documents.every((doc) => doc.error)).toBe(true);
    expect(result.contentError).toMatch(/None of the 2 documents/);
    expect(suiteExitCode(result)).toBe(1);
  });
});

describe('suiteJson', () => {
  it('keeps the score and the review in separate keys', async () => {
    const result = await runTestSuite(`${site}/`, {
      mode: 'full',
      ai: { provider: 'anthropic', apiKey: 'k', call: fakeModel().fn },
      env: {},
    });
    const json = /** @type {Record<string, unknown>} */ (JSON.parse(suiteJson(result)));
    expect(json.mode).toBe('full');
    expect(json).toHaveProperty('score');
    expect(json).toHaveProperty('content');
    // §5: the 0-100 number is structural, so nothing about the review may appear inside it.
    expect(JSON.stringify(json.score)).not.toMatch(/rating/);
  });
});
