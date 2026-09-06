import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderCall } from '@opengeo/core/generate';
import {
  discoverTwins,
  markdownLinksIn,
  reviewContent,
  runTestSuite,
  sitemapTwins,
  suiteExitCode,
  suiteJson,
  type SuiteProgress,
} from '@opengeo/core/test';
import { resolveMode } from '@opengeo/core/cli/commands/test';

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

let server: Server;
let site: string;

beforeEach(() => {
  serveLlms = true;
  serveSitemap = true;
  htmlAtMd = false;
});

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const send = (status: number, type: string, body: string) => {
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
    return send(200, 'text/html', '<!doctype html><html><head><title>Home</title></head><body><main><h1>Home</h1></main></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

// -- flags to modes --------------------------------------------------------------------------

describe('resolveMode', () => {
  const args = (...set: string[]) => ({ bool: (name: string) => set.includes(name) });

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
    expect((answer as { error: string }).error).toMatch(/Pick one/);
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
 */
function fakeModel(scores: Record<string, number> = {}) {
  const calls: ProviderCall[] = [];
  const fn = async (call: ProviderCall) => {
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

/** What `fakeModel` scores a document, given its Definition score. Definition 20, Keywords 10. */
function expectedScore(definition: number): number {
  return Math.round((definition * 20 + 40 * 10) / 30);
}

const twin = (url: string, markdown: string) => ({
  url,
  pageUrl: url.replace(/\.md$/, ''),
  source: 'llms.txt' as const,
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
    const call = async (request: ProviderCall) => {
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

  it('refuses to run in CI, where a key must never be present', async () => {
    await expect(
      reviewContent(twins, { provider: 'anthropic', apiKey: 'k', call: fakeModel().fn, env: { CI: 'true' } }),
    ).rejects.toThrow(/local/i);
  });

  it('reports progress per document', async () => {
    const seen: number[] = [];
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
});

// -- the sequencer -----------------------------------------------------------------------------

describe('runTestSuite', () => {
  const ai = () => ({ provider: 'anthropic' as const, apiKey: 'k', call: fakeModel().fn });

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
    const phases: SuiteProgress['phase'][] = [];
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

  it('rejects a target that is not a URL', async () => {
    await expect(runTestSuite('not a url', { mode: 'structure' })).rejects.toThrow();
  });
});

describe('suiteExitCode', () => {
  it('lets the structural checks decide whenever there were any', async () => {
    const result = await runTestSuite(`${site}/`, { mode: 'full', env: {} });
    expect(suiteExitCode(result)).toBe(result.structure!.score.counts.fail === 0 ? 0 : 1);
  });

  it('never fails a build over the content score', async () => {
    const result = await runTestSuite(`${site}/`, { mode: 'full', ai: { provider: 'anthropic', apiKey: 'k', call: fakeModel({ '': 0 }).fn }, env: {} });
    // Every document scored as badly as the model can score it, and the exit code still comes from
    // the checks alone. The two numbers never meet, and this is where that is enforced.
    expect(result.content?.score).toBe(expectedScore(0));
    expect(suiteExitCode(result)).toBe(result.structure!.score.counts.fail === 0 ? 0 : 1);
  });

  it('fails a content-only run that could not run at all', async () => {
    const result = await runTestSuite(`${site}/`, { mode: 'content', env: {} });
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
    const json = JSON.parse(suiteJson(result)) as Record<string, unknown>;
    expect(json.mode).toBe('full');
    expect(json).toHaveProperty('score');
    expect(json).toHaveProperty('content');
    // §5: the 0-100 number is structural, so nothing about the review may appear inside it.
    expect(JSON.stringify(json.score)).not.toMatch(/rating/);
  });
});
