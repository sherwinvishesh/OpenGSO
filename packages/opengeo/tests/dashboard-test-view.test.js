import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkList, docsUrl, groupChecks, points, slug } from '../web/components/checks.js';
import { adoptedShare, pointsLine, scoreColour, sparklinePoints } from '../web/components/score.js';
import { useDocument } from '../web/ui.js';
import {
  createTestView,
  pastRunsOf,
  priorityClass,
  reasonOnly,
  sameUrl,
  shortPath,
  sortDocuments,
  toneFor,
  whereLine,
} from '../web/views/test.js';

/**
 * @import { CheckResult, DocumentReview, HistoryEntry, Score, StateResponse, TestResponse } from '../../core/src/shared/api-types.js'
 * @import { Ctx } from '../web/context.js'
 */

/** @type {JSDOM} */
let dom;

// Scripts never run: this jsdom is a document to build nodes in, nothing more.
beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>');
  useDocument(dom.window.document);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// -- fixtures ------------------------------------------------------------------------------------

/**
 * @param {Partial<CheckResult>} over
 * @returns {CheckResult}
 */
function check(over) {
  return /** @type {CheckResult} */ ({
    id: 'A1',
    category: 'A',
    importance: 'required',
    scored: true,
    title: 'Page answers',
    weight: 4,
    status: 'pass',
    earned: 4,
    reason: 'It answered.',
    ...over,
  });
}

/** @param {Partial<Score>} [over] @returns {Score} */
function score(over = {}) {
  return {
    value: 80,
    earned: 80,
    possible: 100,
    counts: { pass: 2, partial: 1, fail: 1, locked: 2, na: 1 },
    scored: { count: 3, pass: 1, partial: 1, fail: 1 },
    lost: [],
    suggestions: { count: 3, adopted: 1, open: 0, locked: 2 },
    locked: { count: 2, unlockedBy: ['B1'] },
    ...over,
  };
}

const CHECKS = [
  check({ id: 'A1' }),
  check({ id: 'A3', title: 'Robots, allowed?', status: 'fail', earned: 0, reason: 'Blocked.', fix: 'Unblock it.' }),
  check({ id: 'A6', status: 'partial', earned: 2, reason: 'Half there.' }),
  check({ id: 'A2', scored: false, title: 'llms.txt', status: 'pass', earned: 3, weight: 3, reason: 'Found.' }),
  check({ id: 'B2', scored: false, status: 'locked', earned: 0, weight: 5, lockedBy: 'B1', reason: 'No twin.' }),
  check({ id: 'B3', scored: false, status: 'locked', earned: 0, weight: 4, lockedBy: 'B1', reason: 'No twin.' }),
  check({ id: 'A8', status: 'na', earned: 0, reason: 'Localhost.' }),
];

/** @param {Partial<TestResponse>} [over] @returns {TestResponse} */
function testResult(over = {}) {
  return {
    mode: 'structure',
    url: 'http://localhost:3000/',
    twinUrl: 'http://localhost:3000/index.md',
    score: score(),
    checks: CHECKS,
    history: { trend: [], previous: null },
    structure: undefined,
    content: null,
    discovery: null,
    contentSkipped: null,
    contentError: null,
    ...over,
  };
}

/** @param {Partial<StateResponse>} [over] @returns {StateResponse} */
function fakeState(over = {}) {
  return /** @type {StateResponse} */ ({
    config: { site: 'http://localhost:3000' },
    key: { present: true, path: '.env' },
    checkCount: 22,
    bands: { structural: { good: 90, fair: 60 }, content: { good: 75, fair: 50 } },
    ...over,
  });
}

/**
 * @param {{ state?: StateResponse; lastTest?: TestResponse }} [options]
 */
function fakeCtx({ state = fakeState(), lastTest } = {}) {
  const holder = { state, lastTest };
  const onTestResult = vi.fn((/** @type {TestResponse} */ result) => {
    holder.lastTest = result;
  });
  const ctx = /** @type {Ctx} */ (
    /** @type {unknown} */ ({
      state: () => holder.state,
      bots: () => [],
      reload: async () => {},
      go: () => {},
      lastTest: () => holder.lastTest,
      onTestResult,
    })
  );
  return { ctx, holder, onTestResult };
}

/**
 * Fetch, answered by path. History replies are counted so a test can see the refetch.
 *
 * @param {{ entries?: HistoryEntry[]; stream?: string }} replies
 */
function stubFetch({ entries = [], stream = '' }) {
  const calls = /** @type {string[]} */ ([]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (/** @type {string} */ path) => {
      calls.push(path);
      if (path === '/api/history') return new Response(JSON.stringify({ version: 1, entries }), { status: 200 });
      if (path === '/api/test/stream') return new Response(stream, { status: 200 });
      return new Response('{}', { status: 404 });
    }),
  );
  return calls;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** @param {string} event @param {unknown} data */
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** @param {HTMLElement} root @param {string} label */
function buttonLabelled(root, label) {
  return /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')].find((node) => node.textContent?.includes(label)));
}

// -- pure helpers --------------------------------------------------------------------------------

describe('test view helpers', () => {
  it('compares URLs as parsed URLs, with a string fallback', () => {
    expect(sameUrl('http://localhost:3100', 'http://localhost:3100/')).toBe(true);
    expect(sameUrl('http://a.test/x', 'http://a.test/y')).toBe(false);
    expect(sameUrl(' not a url ', 'not a url')).toBe(true);
  });

  it('keeps only the first line of a terminal message, capitalised', () => {
    expect(reasonOnly('no API key is configured.\n  run this:\n    opengeo settings')).toBe('No API key is configured.');
  });

  it('bands a score by the thresholds it is given', () => {
    const bands = { good: 75, fair: 50 };
    expect([toneFor(75, bands), toneFor(74, bands), toneFor(50, bands), toneFor(49, bands)]).toEqual(['ok', 'warn', 'warn', 'fail']);
    expect(toneFor(80, { good: 85, fair: 60 })).toBe('warn');
  });

  it('shortens a URL to its path and leaves anything else alone', () => {
    expect(shortPath('http://a.test/docs/x.md')).toBe('/docs/x.md');
    expect(shortPath('weird')).toBe('weird');
  });

  it('sorts documents weakest first, unreviewed last', () => {
    const docs = /** @type {DocumentReview[]} */ ([
      { url: 'u1', source: 's', words: 1 },
      { url: 'u2', source: 's', words: 1, review: { score: 90 } },
      { url: 'u3', source: 's', words: 1, review: { score: 40 } },
    ]);
    expect(sortDocuments(docs).map((doc) => doc.url)).toEqual(['u3', 'u2', 'u1']);
    expect(docs.map((doc) => doc.url)).toEqual(['u1', 'u2', 'u3']);
  });

  it('lets only the three known priorities into a class name, rec-low included', () => {
    expect(priorityClass('high')).toBe('rec-priority rec-high');
    expect(priorityClass('low')).toBe('rec-priority rec-low');
    expect(priorityClass('x" onclick')).toBe('rec-priority');
  });

  it('joins where an edit goes with two spaces', () => {
    expect(whereLine({ area: 'Facts', action: 'a', priority: 'low', where: 'Pricing', documents: ['http://a.test/p.md'] })).toBe('Facts  Pricing  /p.md');
    expect(whereLine({ area: 'Facts', action: 'a', priority: 'low' })).toBe('Facts');
  });

  it('picks the runs of one URL, oldest first, last eight, with deltas', () => {
    /** @type {HistoryEntry[]} */
    const entries = [
      ...Array.from({ length: 9 }, (_, index) => ({ at: `2026-01-0${index + 1}T00:00:00Z`, url: 'http://a.test', mode: /** @type {const} */ ('full'), score: 50 + index })),
      { at: '2026-02-01T00:00:00Z', url: 'http://b.test', mode: 'full', score: 10 },
      { at: '2026-02-02T00:00:00Z', url: 'http://a.test/', mode: 'content' },
    ];
    const runs = pastRunsOf(entries, 'http://a.test/');
    expect(runs.total).toBe(9);
    expect(runs.shown).toHaveLength(8);
    expect(runs.shown[0]).toEqual({ at: '2026-01-02T00:00:00Z', score: 51, change: undefined });
    expect(runs.shown[1]?.change).toBe(1);
  });

  it('prices a check in the fewest characters', () => {
    expect(points(check({ status: 'fail', weight: 5 }))).toBe('-5');
    // A priced fail reads in score points, the headline's unit, not in its weight.
    expect(points(check({ status: 'fail', weight: 5, price: 7 }))).toBe('-7');
    expect(points(check({ status: 'partial', earned: 2, weight: 4 }))).toBe('2/4');
    expect(points(check({ status: 'na' }))).toBe('n/a');
    expect(points(check({ status: 'pass', weight: 3 }))).toBe('3');
    // A suggestion moves no score, so it is never priced, whatever it carries.
    expect(points(check({ scored: false, status: 'fail', weight: 10, price: 15 }))).toBe('tip');
    expect(points(check({ scored: false, status: 'locked', weight: 6 }))).toBe('6');
  });

  it('counts the locked group as suggestions and labels the per-check figures as weights', () => {
    const list = checkList(CHECKS, score());
    expect(list.querySelector('.locked-points')?.textContent).toBe('2 more suggestions apply');
    expect(list.textContent).toContain('once B1 passes');
    expect(list.querySelector('.locked-prices')?.getAttribute('title')).toBe('Check weights');
  });

  it('marks a suggestion row so it never reads as a failure', () => {
    const list = checkList([check({ id: 'B1', scored: false, status: 'fail', earned: 0, weight: 10, reason: 'No twin.' })], score());
    expect(list.querySelector('.check-suggestion .check-points')?.textContent).toBe('tip');
    expect(list.textContent).toContain('Nothing scored is failing.');
  });

  it('links a check to its heading in docs/checks.md', () => {
    expect(slug('Robots, allowed?')).toBe('robots-allowed');
    expect(docsUrl({ id: 'A2', title: 'Robots, allowed?' })).toBe('https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/checks.md#a2---robots-allowed');
  });

  it('groups checks failures first', () => {
    const groups = groupChecks(CHECKS);
    expect(groups.before.map((group) => [group.title, group.checks.length])).toEqual([
      ['Failed', 1],
      ['Partly there', 1],
      ['Suggestions', 0],
    ]);
    expect(groups.locked.map((entry) => entry.id)).toEqual(['B2', 'B3']);
    expect(groups.after.map((group) => [group.title, group.checks.length])).toEqual([
      ['Passed', 1],
      ['Adopted', 1],
      ['Not applicable', 1],
    ]);
  });

  it('draws the score in the band the server sent', () => {
    expect(scoreColour(87, { good: 90, fair: 60 })).toBe('var(--warn)');
    expect(scoreColour(87, { good: 85, fair: 60 })).toBe('var(--ok)');
    expect(scoreColour(10, { good: 85, fair: 60 })).toBe('var(--danger)');
    expect(adoptedShare(score({ suggestions: { count: 15, adopted: 3, open: 0, locked: 12 } }))).toBeCloseTo(0.2);
    expect(adoptedShare(score({ suggestions: { count: 0, adopted: 0, open: 0, locked: 0 } }))).toBe(0);
  });

  it('writes the points line the way the terminal does', () => {
    expect(pointsLine(score(), { name: 'Next.js' })).toBe(
      '80 of 100 points across the scored checks, with 1 check excluded because it does not apply here, and 2 suggestions waiting on B1 · Next.js detected',
    );
    expect(pointsLine(score({ counts: { pass: 1, partial: 0, fail: 0, locked: 0, na: 2 }, locked: { count: 0, unlockedBy: [] } }))).toBe(
      '80 of 100 points across the scored checks, with 2 checks excluded because they do not apply here',
    );
  });

  it('scales the sparkline to its own range', () => {
    expect(sparklinePoints([90, 100])).toBe('0.0,15.0 56.0,1.0');
    expect(sparklinePoints([70, 70])).toBe('0.0,8.0 56.0,8.0');
  });
});

// -- the view ------------------------------------------------------------------------------------

describe('createTestView', () => {
  it('opens with the page heading and the check count from the server', async () => {
    stubFetch({});
    const { ctx, holder } = fakeCtx();
    const view = createTestView(ctx);
    await settle();
    const first = view.node.firstElementChild;
    expect(first?.querySelector('h1')?.textContent).toBe('Test');
    expect(first?.textContent).toContain('against the 22 checks');
    expect(view.node.textContent).toContain('Run a test to see which of the 22 checks pass');

    const input = /** @type {HTMLInputElement} */ (view.node.querySelector('input'));
    holder.state = fakeState({ checkCount: 23 });
    view.update();
    expect(first?.textContent).toContain('against the 23 checks');
    expect(view.node.textContent).toContain('which of the 23 checks pass');
    expect(view.node.querySelector('input')).toBe(input);
  });

  it('follows the configured site until somebody types', () => {
    stubFetch({});
    const { ctx, holder } = fakeCtx();
    const view = createTestView(ctx);
    const input = /** @type {HTMLInputElement} */ (view.node.querySelector('input'));
    expect(input.value).toBe('http://localhost:3000');

    holder.state = fakeState({ config: /** @type {StateResponse['config']} */ ({ site: 'http://localhost:4000' }) });
    view.update();
    expect(input.value).toBe('http://localhost:4000');

    input.value = 'http://mine.test';
    input.dispatchEvent(new dom.window.Event('input'));
    holder.state = fakeState({ config: /** @type {StateResponse['config']} */ ({ site: 'http://localhost:5000' }) });
    view.update();
    expect(view.node.querySelector('input')).toBe(input);
    expect(input.value).toBe('http://mine.test');
  });

  it('marks the chosen mode pressed and blocks content mode without a key', () => {
    stubFetch({});
    const { ctx } = fakeCtx({ state: fakeState({ key: { present: false, path: '.env' } }) });
    const view = createTestView(ctx);
    const group = /** @type {HTMLElement} */ (view.node.querySelector('[role="group"]'));
    expect(group.getAttribute('aria-label')).toBe('What to run');
    const modes = [...group.querySelectorAll('button')];
    expect(modes.map((node) => node.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(view.node.textContent).toContain('No key configured');

    /** @type {HTMLButtonElement} */ (modes[2]).click();
    expect(modes.map((node) => node.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
    const run = buttonLabelled(view.node, 'Run test');
    expect(run.disabled).toBe(true);
    const blocked = [...view.node.querySelectorAll('p')].find((node) => node.textContent?.startsWith('A content review needs'));
    expect(blocked?.hidden).toBe(false);
  });

  it('shows the last test on first build, in the server bands, with h2 groups', () => {
    stubFetch({});
    const { ctx, holder } = fakeCtx({ lastTest: testResult() });
    const view = createTestView(ctx);
    const value = /** @type {HTMLElement} */ (view.node.querySelector('.score-dial .value'));
    expect(value.textContent).toBe('80');
    expect(value.style.color).toBe('var(--warn)');
    expect([...view.node.querySelectorAll('.counts > span')].map((node) => node.textContent)).toEqual([
      '1 of 3 scored passed',
      '1 partly there',
      '1 failed',
      '1 of 3 suggestions adopted',
      '2 locked',
      '1 not applicable',
    ]);
    expect(view.node.textContent).not.toContain('No result yet');

    const titles = [...view.node.querySelectorAll('.group-title')].filter((node) => node.tagName === 'H2').map((node) => node.firstChild?.textContent);
    expect(titles).toEqual(['Failed', 'Partly there', 'Locked', 'Passed', 'Adopted', 'Not applicable']);
    expect(view.node.querySelector('h3')).toBeNull();

    const link = /** @type {HTMLAnchorElement} */ (view.node.querySelector('.check-id a'));
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');

    holder.state = fakeState({ bands: { structural: { good: 75, fair: 60 }, content: { good: 75, fair: 50 } } });
    view.update();
    expect(/** @type {HTMLElement} */ (view.node.querySelector('.score-dial .value')).style.color).toBe('var(--ok)');
  });

  it('opens the locked detail with aria-expanded and aria-controls', () => {
    stubFetch({});
    const { ctx } = fakeCtx({ lastTest: testResult() });
    const view = createTestView(ctx);
    const toggle = buttonLabelled(view.node, 'Why each of the 2 is locked');
    const controls = /** @type {string} */ (toggle.getAttribute('aria-controls'));
    const detail = /** @type {HTMLElement} */ (view.node.querySelector(`#${controls}`));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(detail.hidden).toBe(true);
    expect(detail.querySelectorAll('.check')).toHaveLength(2);
    expect(view.node.textContent).toContain('2 more suggestions apply');
    expect(view.node.textContent).toContain('Serve a markdown twin at the .md URL');

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(detail.hidden).toBe(false);
    expect(toggle.textContent).toBe('Hide the detail');
  });

  it('keeps the check list, open toggle and all, when only the history changes', () => {
    stubFetch({});
    const { ctx, holder } = fakeCtx({ lastTest: testResult() });
    const view = createTestView(ctx);
    const list = view.node.querySelector('.check-group');
    const dial = view.node.querySelector('.score-dial');

    holder.lastTest = testResult({ history: { trend: [70, 75], previous: { at: new Date().toISOString(), url: 'http://localhost:3000/', mode: 'structure', score: 75 } } });
    view.update();
    expect(view.node.querySelector('.check-group')).toBe(list);
    expect(view.node.querySelector('.score-dial')).not.toBe(dial);
    expect(view.node.querySelector('.delta')?.textContent).toBe('+5 since just now');
    expect(view.node.querySelector('svg.sparkline')).not.toBeNull();
  });

  it('draws every recommendation, even two with the same text', () => {
    stubFetch({});
    const rec = { area: 'Facts', action: 'Add the price', priority: /** @type {const} */ ('high'), documents: ['http://a.test/a.md'] };
    const content = {
      provider: /** @type {const} */ ('anthropic'),
      model: 'm',
      score: 60,
      areaScores: [{ area: 'Facts', score: 120, weight: 30, lost: 0, documents: 1 }],
      recommendations: [rec, { ...rec }, { ...rec, priority: /** @type {never} */ ('urgent') }],
      notReviewed: 0,
      documents: [
        {
          url: 'http://a.test/a.md',
          source: 'llms.txt',
          words: 1200,
          review: {
            score: 40,
            summary: 'Thin.',
            provider: /** @type {const} */ ('anthropic'),
            model: 'm',
            findings: [{ area: 'Facts', note: 'Few.' }, { area: 'Facts', note: 'Few.' }],
            recommendations: [rec, rec],
          },
        },
      ],
    };
    const { ctx } = fakeCtx({ lastTest: testResult({ mode: 'full', content }) });
    const view = createTestView(ctx);
    const site = [...view.node.querySelectorAll('.card')].find((node) => node.querySelector('h2')?.textContent === 'What to change first');
    const rows = site?.querySelectorAll('.rec') ?? [];
    expect(rows).toHaveLength(3);
    expect([...rows].map((row) => row.querySelector('.rec-priority')?.className)).toEqual([
      'rec-priority rec-high',
      'rec-priority rec-high',
      'rec-priority',
    ]);
    expect(rows[1]?.textContent).toContain('2. Add the price');
    expect(view.node.querySelectorAll('.rec')).toHaveLength(5);
    expect(view.node.textContent).toContain('1 document read.');
    const fill = /** @type {HTMLElement} */ (view.node.querySelector('.area-fill'));
    expect(fill.className).toBe('area-fill tone-ok');
    expect(fill.style.width).toBe('100%');
  });

  it('shows a skipped review as its reason only', () => {
    stubFetch({});
    const { ctx } = fakeCtx({ lastTest: testResult({ mode: 'full', contentSkipped: 'no key is set.\n  opengeo settings' }) });
    const view = createTestView(ctx);
    expect(view.node.textContent).toContain('No key is set. Add one in Settings and run this again.');
    expect(view.node.textContent).not.toContain('opengeo settings');
  });

  it('lists past runs for the URL in the box and refilters as it changes', async () => {
    const at = new Date().toISOString();
    stubFetch({
      entries: [
        { at, url: 'http://localhost:3000/', mode: 'structure', score: 70 },
        { at, url: 'http://localhost:3000/', mode: 'structure', score: 76 },
        { at, url: 'http://other.test/', mode: 'structure', score: 12 },
      ],
    });
    const { ctx } = fakeCtx();
    const view = createTestView(ctx);
    await settle();
    expect(view.node.textContent).toContain('Where this URL has been');
    expect(view.node.textContent).toContain('2 recorded runs, on this machine only');
    expect(view.node.querySelector('.delta-up')?.textContent).toBe('+6');

    const input = /** @type {HTMLInputElement} */ (view.node.querySelector('input'));
    input.value = 'http://other.test';
    input.dispatchEvent(new dom.window.Event('input'));
    expect(view.node.textContent).toContain('1 recorded run, on this machine only');
    expect(view.node.textContent).toContain('scored 12');
  });

  it('runs a test, hands the result up, and refetches history', async () => {
    const result = testResult({ score: score({ value: 98 }) });
    const calls = stubFetch({
      stream: `: open\n\n${frame('progress', { phase: 'structure' })}${frame('done', { status: 200, body: result })}`,
    });
    const { ctx, onTestResult } = fakeCtx();
    const view = createTestView(ctx);
    await settle();
    expect(calls.filter((path) => path === '/api/history')).toHaveLength(1);

    const input = /** @type {HTMLInputElement} */ (view.node.querySelector('input'));
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
    const run = view.node.querySelector('.btn-primary');
    expect(run?.textContent).toBe('Testing');
    expect(/** @type {HTMLElement} */ (view.node.querySelector('.progress')).hidden).toBe(false);

    await vi.waitFor(() => expect(onTestResult).toHaveBeenCalledWith(result));
    await settle();
    expect(view.node.querySelector('.btn-primary')?.textContent).toBe('Run test');
    expect(view.node.querySelector('.score-dial .value')?.textContent).toBe('98');
    expect(/** @type {HTMLElement} */ (view.node.querySelector('.progress')).hidden).toBe(true);
    expect(calls.filter((path) => path === '/api/history')).toHaveLength(2);
  });

  it('shows a failed run as an alert and clears the old result', async () => {
    stubFetch({ stream: frame('done', { status: 400, body: { error: 'Nothing answered at that URL.' } }) });
    const { ctx, onTestResult } = fakeCtx({ lastTest: testResult() });
    const view = createTestView(ctx);
    buttonLabelled(view.node, 'Run test').click();
    await vi.waitFor(() => expect(view.node.querySelector('[role="alert"]')).not.toBeNull());
    const alert = /** @type {HTMLElement} */ (view.node.querySelector('[role="alert"]'));
    expect(alert.querySelector('h2')?.textContent).toBe('The test could not run');
    expect(alert.textContent).toContain('Nothing answered at that URL.');
    expect(view.node.querySelector('.score-dial')).toBeNull();
    expect(onTestResult).not.toHaveBeenCalled();
  });
});
