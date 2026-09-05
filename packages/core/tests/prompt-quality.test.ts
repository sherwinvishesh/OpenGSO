import { describe, expect, it } from 'vitest';
import type { CheckResult, TestResult } from '@opengeo/core/test';
import {
  buildFixPrompt,
  CHECKS,
  detectFramework,
  parseQuality,
  QUALITY_SYSTEM_PROMPT,
  reviewQuality,
  scoreChecks,
} from '@opengeo/core/test';
import type { ProviderCall } from '@opengeo/core/generate';

/**
 * Framework detection, the fix prompt, and the quality layer. The three of them share one property
 * worth guarding: none of them may change the 0-100 score, and none may name a competitor.
 */

function resultWith(checks: CheckResult[], overrides: Partial<TestResult> = {}): TestResult {
  return {
    url: 'https://example.com/resume',
    twinUrl: 'https://example.com/resume.md',
    checks,
    score: scoreChecks(checks),
    evidence: {} as TestResult['evidence'],
    ...overrides,
  };
}

const FAILURE: CheckResult = {
  id: 'B9',
  category: 'B',
  importance: 'required',
  weight: 8,
  title: 'Accept: text/markdown receives markdown, not HTML',
  status: 'fail',
  reason: 'Asking for text/markdown returned text/html; charset=utf-8 instead.',
  detail: 'Response was 200 with an HTML body.',
};

const PASS: CheckResult = { ...FAILURE, id: 'B13', status: 'pass', reason: 'Fine.', detail: undefined };

describe('framework detection', () => {
  const cases: Array<[string, string, string]> = [
    ['Next.js', '<html><body><script src="/_next/static/chunks/main.js"></script></body></html>', 'Next.js'],
    ['Nuxt', '<html><body><script src="/_nuxt/entry.js"></script><script id="__NUXT_DATA__">[]</script></body></html>', 'Nuxt'],
    ['Astro', '<html><head><meta name="generator" content="Astro v4.5.0"></head><body><script src="/x.js"></script></body></html>', 'Astro'],
    ['SvelteKit', '<html><body><script src="/_app/immutable/entry/start.js"></script></body></html>', 'SvelteKit'],
    ['Remix', '<html><body><script src="/build/x.js">window.__remixContext = {};</script></body></html>', 'Remix or React Router'],
    ['Gatsby', '<html><body><div id="___gatsby"></div><script src="/app.js"></script></body></html>', 'Gatsby'],
    ['Docusaurus', '<html><head><meta name="generator" content="Docusaurus v3.1.1"></head><body><script src="/x.js"></script></body></html>', 'Docusaurus'],
    ['Vite', '<html><body><script type="module" src="/assets/index-a1b2c3d4.js"></script></body></html>', 'Vite'],
  ];

  for (const [label, html, expected] of cases) {
    it(`recognises ${label}`, () => {
      expect(detectFramework(html)?.name).toBe(expected);
    });
  }

  it('calls a page with no bundle plain HTML', () => {
    const framework = detectFramework('<html><body><h1>Hi</h1><p>Words.</p></body></html>');
    expect(framework?.id).toBe('plain');
  });

  it('says nothing rather than guessing when the fingerprints are unfamiliar', () => {
    // A bundle is present, so it is not a plain page, but nothing identifies who built it.
    expect(detectFramework('<html><body><script src="/bundle.js"></script></body></html>')).toBeUndefined();
  });

  it('always explains what gave it away, so the user can disagree', () => {
    const framework = detectFramework('<html><body><script src="/_next/static/x.js"></script></body></html>');
    expect(framework?.evidence).toContain('/_next/static/');
  });
});

describe('the fix prompt', () => {
  const result = resultWith([FAILURE, PASS], {
    framework: { id: 'nextjs', name: 'Next.js', evidence: 'assets are served from /_next/static/' },
  });

  it('carries the score, both URLs, and the detected framework', () => {
    const prompt = buildFixPrompt(result);
    expect(prompt).toContain('https://example.com/resume');
    expect(prompt).toContain('https://example.com/resume.md');
    expect(prompt).toContain(`${result.score.value}/100`);
    expect(prompt).toContain('Next.js');
  });

  it('gives each failed check its id, points, reason and a fix', () => {
    const prompt = buildFixPrompt(result);
    expect(prompt).toContain('### B9 - Accept: text/markdown receives markdown, not HTML');
    expect(prompt).toContain('Points lost: 8 (required)');
    expect(prompt).toContain('Asking for text/markdown returned text/html');
    expect(prompt).toContain('Response was 200 with an HTML body.');
    expect(prompt).toMatch(/- Fix: .{20,}/);
  });

  it('leaves passing checks out, so the agent works on what is broken', () => {
    expect(buildFixPrompt(result)).not.toContain('B13');
  });

  it('makes all four numbered asks from the spec', () => {
    const prompt = buildFixPrompt(result);
    expect(prompt).toContain('1. Walk through the exact code changes');
    expect(prompt).toContain('2. Show a diff');
    expect(prompt).toContain('3. For each change, say which failed check ID');
    expect(prompt).toContain('4. Verify your suggestions against');
  });

  it('references only opengeo-prod and OpenGEO docs, never a competitor', () => {
    const prompt = buildFixPrompt(result).toLowerCase();
    // Named in §14 as the landscape OpenGEO sits in. A fix prompt handed to an agent with
    // file access must not send it to install any of them.
    for (const competitor of ['firecrawl', 'jina', 'r.jina.ai', 'mintlify', 'gitbook', 'readme.io', 'llmstxt.org', 'markdowner', 'urltomarkdown', 'pure.md']) {
      expect(prompt, `should not mention ${competitor}`).not.toContain(competitor);
    }
    for (const url of prompt.match(/https?:\/\/[^\s)]+/g) ?? []) {
      expect(url, `${url} points outside OpenGEO`).toMatch(/^https?:\/\/(github\.com\/sherwinvishesh\/opengeo|example\.com)/);
    }
  });

  it('says so plainly when there is nothing to fix', () => {
    const prompt = buildFixPrompt(resultWith([PASS]));
    expect(prompt).toContain('Nothing failed');
    expect(prompt).not.toContain('What I need from you');
  });

  it('still produces a usable prompt when the framework is unknown', () => {
    const prompt = buildFixPrompt(resultWith([FAILURE]));
    expect(prompt).toContain('could not tell from the served HTML');
    expect(prompt).toContain('### B9');
  });
});

describe('the quality layer', () => {
  const input = { url: 'https://example.com/resume.md', markdown: '# Resume\n\nShipped 4 projects in 2024.' };

  function mock(reply: string): (call: ProviderCall) => Promise<string> {
    return async () => reply;
  }

  it('parses the shape it asked for', async () => {
    const review = await reviewQuality(input, {
      provider: 'anthropic',
      apiKey: 'test-key',
      env: {},
      call: mock('{"rating": 4, "summary": "Solid.", "findings": [{"area": "Length", "note": "About right."}], "suggestions": ["Add dates."]}'),
    });
    expect(review.rating).toBe(4);
    expect(review.summary).toBe('Solid.');
    expect(review.findings).toEqual([{ area: 'Length', note: 'About right.' }]);
    expect(review.suggestions).toEqual(['Add dates.']);
  });

  it('reviews content, and is told in so many words not to re-audit the headers', () => {
    expect(QUALITY_SYSTEM_PROMPT).toContain('Keyword coverage');
    expect(QUALITY_SYSTEM_PROMPT).toContain('Length');
    expect(QUALITY_SYSTEM_PROMPT).toContain('Do not comment on HTTP headers');
  });

  it('sends the document, and only the document, to the provider', async () => {
    let seen: ProviderCall | undefined;
    await reviewQuality(input, {
      provider: 'openai',
      apiKey: 'test-key',
      env: {},
      call: async (call) => {
        seen = call;
        return '{"rating": 3, "summary": "Fine.", "findings": [], "suggestions": []}';
      },
    });
    expect(seen?.prompt).toContain('Shipped 4 projects in 2024.');
    expect(seen?.apiKey).toBe('test-key');
    expect(seen?.provider).toBe('openai');
  });

  it('keeps a model reply it cannot parse instead of throwing it away', () => {
    const review = parseQuality('The document reads well enough.', 'anthropic', 'model-x');
    expect(review.raw).toBe('The document reads well enough.');
    expect(review.findings).toEqual([]);
  });

  it('digs the JSON out of a reply wrapped in prose or a code fence', () => {
    const fenced = parseQuality('```json\n{"rating": 5, "summary": "Great."}\n```', 'anthropic', 'model-x');
    expect(fenced.rating).toBe(5);
    const chatty = parseQuality('Sure! {"rating": 2, "summary": "Thin."} Hope that helps.', 'anthropic', 'model-x');
    expect(chatty.summary).toBe('Thin.');
  });

  it('clamps a rating the model invented outside the range it was given', () => {
    expect(parseQuality('{"rating": 11, "summary": "x"}', 'anthropic', 'm').rating).toBe(5);
    expect(parseQuality('{"rating": 0, "summary": "x"}', 'anthropic', 'm').rating).toBe(1);
  });

  it('refuses to run in CI, the same rule as generate\'s AI tier', async () => {
    await expect(
      reviewQuality(input, { provider: 'anthropic', apiKey: 'k', env: { CI: 'true' }, call: mock('{}') }),
    ).rejects.toThrow(/local/i);
  });

  it('refuses an unknown provider by name', async () => {
    await expect(
      reviewQuality(input, { provider: 'notreal' as never, apiKey: 'k', env: {}, call: mock('{}') }),
    ).rejects.toThrow(/notreal/);
  });
});

describe('the quality layer never touches the structural score', () => {
  it('scores the same checks identically whether or not a review ran', () => {
    const checks = [FAILURE, PASS];
    const before = scoreChecks(checks).value;
    const review = parseQuality('{"rating": 1, "summary": "Terrible."}', 'anthropic', 'm');
    expect(review.rating).toBe(1);
    expect(scoreChecks(checks).value).toBe(before);
  });

  it('has no scoring weight of its own to leak into the denominator', () => {
    // The catalogue is the only thing scoreChecks can draw points from. If a quality result ever
    // became a check, it would have to appear here first, and this would catch it.
    expect(CHECKS.some((check) => /qual/i.test(check.id) || /quality/i.test(check.title))).toBe(false);
  });
});
