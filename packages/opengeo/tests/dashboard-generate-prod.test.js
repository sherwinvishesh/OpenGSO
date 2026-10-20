import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../web/api.js';
import { useDocument } from '../web/ui.js';
import { createGenerateView, firstSentence, lastRunText, mdRelPath, pagesSummary } from '../web/views/generate.js';
import { createProdView, probeTranscript, routableNames } from '../web/views/prod.js';

/**
 * @import { AiBot, GenerateResponse, ProdProbe, ProdVerification, StateResponse } from '../../core/src/shared/api-types.js'
 * @import { Ctx } from '../web/context.js'
 */

// Scripts never run: this jsdom is a document to build nodes in, nothing more.
beforeEach(() => {
  useDocument(new JSDOM('<!doctype html><body></body>').window.document);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Lets the click handler's promise chain run to the end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** @param {Partial<StateResponse>} [over] @returns {StateResponse} */
function makeState(over = {}) {
  return /** @type {StateResponse} */ ({
    config: { site: 'http://localhost:3000', generate: { tier: 'free' } },
    key: { present: false, path: '.env' },
    ci: false,
    root: '/project',
    publicDir: '/project/public',
    defaultBot: 'ExampleBot',
    ...over,
  });
}

/** @param {string} name @param {string[]} [uaPatterns] @returns {AiBot} */
const bot = (name, uaPatterns = [name.toLowerCase()]) => /** @type {AiBot} */ ({ name, uaPatterns });

/**
 * @param {{ state?: StateResponse; bots?: AiBot[] }} [initial]
 */
function makeCtx(initial = {}) {
  let state = initial.state ?? makeState();
  let bots = initial.bots ?? [];
  const reload = vi.fn(async () => {});
  const ctx = /** @type {Ctx} */ (/** @type {unknown} */ ({ state: () => state, bots: () => bots, reload }));
  return {
    ctx,
    reload,
    /** @param {StateResponse} next */
    setState: (next) => (state = next),
    /** @param {AiBot[]} next */
    setBots: (next) => (bots = next),
  };
}

/**
 * An event from the element's own window, which is the jsdom one rather than Node's.
 *
 * @param {HTMLElement} node
 * @param {string} type
 */
function fire(node, type) {
  const view = /** @type {{ Event: typeof Event }} */ (/** @type {unknown} */ (node.ownerDocument.defaultView));
  node.dispatchEvent(new view.Event(type));
}

/** @param {HTMLElement} root @param {string} text */
function labelled(root, text) {
  const label = [...root.querySelectorAll('label')].find((node) => node.textContent === text);
  const id = label?.getAttribute('for');
  return id ? root.querySelector(`#${id}`) : null;
}

/** @param {HTMLElement} root @param {string} text */
function buttonNamed(root, text) {
  return /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')].find((node) => node.textContent === text));
}

/**
 * Text a reader can see. `textContent` includes hidden nodes, and this view hides rather than
 * removes its empty state and notes.
 *
 * @param {Node} node
 * @returns {string}
 */
function visibleText(node) {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType === 1 && /** @type {HTMLElement} */ (node).hidden) return '';
  return [...node.childNodes].map(visibleText).join('');
}

/** @param {HTMLElement} root */
function headingLevels(root) {
  return [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter((node) => !node.closest('[hidden]')).map((node) => Number(node.tagName[1]));
}

/** @param {number[]} levels */
function skipsALevel(levels) {
  return levels.some((level, index) => index > 0 && level > levels[index - 1] + 1);
}

// -- generate ------------------------------------------------------------------------------------

/** @param {Array<[string, GenerateResponse['pages'][number]['status']]>} pages @returns {GenerateResponse} */
function generated(pages) {
  return {
    site: 'http://localhost:3000',
    durationMs: 1234,
    publicDir: '/project/public',
    warnings: [],
    source: 'url',
    files: [{ name: 'robots.txt', path: '/project/public/robots.txt', status: 'written' }],
    pages: pages.map(([route, status]) => ({ route, url: `http://localhost:3000${route}`, status, warnings: [], wordCount: 10, tokens: 20 })),
  };
}

describe('generate helpers', () => {
  it('maps a route to the twin path the server allows', () => {
    expect(mdRelPath('/')).toBe('md/index.md');
    expect(mdRelPath('/resume')).toBe('md/resume.md');
    expect(mdRelPath('/docs/')).toBe('md/docs.md');
    expect(mdRelPath('/a/b')).toBe('md/a/b.md');
  });

  it('summarises a run in the words the table head uses', () => {
    const result = generated([['/', 'written'], ['/a', 'cached'], ['/b', 'failed'], ['/c', 'written']]);
    expect(pagesSummary(result)).toBe('2 written, 1 unchanged, 1 failed in 1.2s');
  });

  it('shortens a repeated warning to the sentence that says what happened', () => {
    expect(firstSentence('Not sent, so the free version was kept. Check the model id.\nThen run it again.')).toBe(
      'Not sent, so the free version was kept.',
    );
    expect(firstSentence('One line with no full stop')).toBe('One line with no full stop');
  });

  it('counts the pages the model wrote on an AI run, including none', () => {
    const result = generated([['/', 'written'], ['/a', 'written']]);
    expect(pagesSummary(result, 'ai')).toBe('2 written, 0 unchanged, 0 failed, 0 AI-enhanced in 1.2s');
    const first = result.pages[0];
    if (first) first.tier = 'ai';
    expect(pagesSummary(result, 'ai')).toBe('2 written, 0 unchanged, 0 failed, 1 AI-enhanced in 1.2s');
  });

  it('describes the last run from the manifest, or its absence', () => {
    expect(lastRunText(makeState())).toBe('No markdown twins exist for this project yet.');
    const one = makeState({ manifest: /** @type {StateResponse['manifest']} */ ({ pages: [{}] }) });
    expect(lastRunText(one)).toBe('The last run wrote 1 page. Run generate again to refresh them.');
  });
});

describe('the generate view', () => {
  it('builds the form with labelled controls and the server paths', () => {
    const { ctx } = makeCtx();
    const view = createGenerateView(ctx);
    expect(view.node.firstElementChild?.querySelector('h1')?.textContent).toBe('Generate');
    // Shown from the project folder the sidebar already names.
    expect(view.node.textContent).toContain('Files land in public.');
    expect(/** @type {HTMLInputElement} */ (labelled(view.node, 'Site URL')).value).toBe('http://localhost:3000');
    expect(/** @type {HTMLSelectElement} */ (labelled(view.node, 'Tier')).value).toBe('free');
    expect(buttonNamed(view.node, 'Generate').disabled).toBe(false);
    expect(visibleText(view.node)).toContain('Nothing generated in this session');
    expect(skipsALevel(headingLevels(view.node))).toBe(false);
  });

  it('warns about a missing key only on the AI tier', () => {
    const { ctx } = makeCtx();
    const view = createGenerateView(ctx);
    const note = /** @type {HTMLElement} */ ([...view.node.querySelectorAll('p.note')].find((node) => node.textContent?.startsWith('The AI tier needs a key')));
    expect(note.hidden).toBe(true);
    const tier = /** @type {HTMLSelectElement} */ (labelled(view.node, 'Tier'));
    tier.value = 'ai';
    fire(tier, 'change');
    expect(note.hidden).toBe(false);
  });

  it('follows server state into untouched fields and leaves an edited one alone', () => {
    const { ctx, setState } = makeCtx();
    const view = createGenerateView(ctx);
    const url = /** @type {HTMLInputElement} */ (labelled(view.node, 'Site URL'));
    setState(makeState({ config: /** @type {StateResponse['config']} */ ({ site: 'http://localhost:4000', generate: { tier: 'ai' } }), ci: true }));
    view.update();
    expect(url.value).toBe('http://localhost:4000');
    expect(/** @type {HTMLSelectElement} */ (labelled(view.node, 'Tier')).value).toBe('ai');
    expect(visibleText(view.node)).toContain('CI is set in this environment');

    url.value = 'http://mine.test';
    fire(url, 'input');
    setState(makeState({ config: /** @type {StateResponse['config']} */ ({ site: 'http://localhost:5000', generate: { tier: 'free' } }) }));
    view.update();
    expect(labelled(view.node, 'Site URL')).toBe(url);
    expect(url.value).toBe('http://mine.test');
  });

  it('disables Generate on an empty URL', () => {
    const { ctx } = makeCtx();
    const view = createGenerateView(ctx);
    const url = /** @type {HTMLInputElement} */ (labelled(view.node, 'Site URL'));
    url.value = '  ';
    fire(url, 'input');
    expect(buttonNamed(view.node, 'Generate').disabled).toBe(true);
  });

  it('runs, draws the tables, and reloads state afterwards', async () => {
    const generate = vi.spyOn(api, 'generate').mockResolvedValue(generated([['/', 'written'], ['/gone', 'failed']]));
    const { ctx, reload } = makeCtx();
    const view = createGenerateView(ctx);
    buttonNamed(view.node, 'Generate').click();
    expect(buttonNamed(view.node, 'Generating').disabled).toBe(true);
    await settle();

    expect(generate).toHaveBeenCalledWith({ url: 'http://localhost:3000', tier: 'free', single: false, force: false }, expect.any(Function), expect.anything());
    expect(reload).toHaveBeenCalledOnce();
    expect(view.node.textContent).toContain('1 written, 0 unchanged, 1 failed in 1.2s');
    expect(view.node.textContent).toContain('public/robots.txt');
    expect(view.node.textContent).not.toContain('/project/public/robots.txt');
    expect(view.node.textContent).toContain('Written from the same crawl');
    expect(view.node.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(visibleText(view.node)).not.toContain('Nothing generated in this session');
    const options = [...view.node.querySelectorAll('select[aria-label="Route to preview"] option')].map((node) => node.textContent);
    expect(options).toEqual(['/']);
    expect(buttonNamed(view.node, 'Generate').disabled).toBe(false);
  });

  it('shows the needsKey hint after the server message', async () => {
    vi.spyOn(api, 'generate').mockRejectedValue(new ApiError('No key.', 400, { needsKey: true }));
    const { ctx, reload } = makeCtx();
    const view = createGenerateView(ctx);
    buttonNamed(view.node, 'Generate').click();
    await settle();
    const alert = view.node.querySelector('[role="alert"]');
    expect(alert?.querySelector('h2')?.textContent).toBe('Generate did not finish');
    expect(alert?.querySelector('p')?.textContent).toBe('No key. Add a key in Settings, or switch to the free tier.');
    expect(reload).not.toHaveBeenCalled();
  });

  it('says nothing when the run was aborted', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.spyOn(api, 'generate').mockRejectedValue(abort);
    const { ctx } = makeCtx();
    const view = createGenerateView(ctx);
    buttonNamed(view.node, 'Generate').click();
    await settle();
    expect(view.node.querySelector('[role="alert"]')).toBeNull();
  });

  it('resets the preview to the new first route on a new result (WEB-4)', async () => {
    const generate = vi.spyOn(api, 'generate').mockResolvedValueOnce(generated([['/old', 'written'], ['/shared', 'written']]));
    vi.spyOn(api, 'readFile').mockImplementation(async (path) => ({ path, content: `content of ${path}` }));
    const { ctx } = makeCtx();
    const view = createGenerateView(ctx);
    buttonNamed(view.node, 'Generate').click();
    await settle();

    const first = /** @type {HTMLSelectElement} */ (view.node.querySelector('select[aria-label="Route to preview"]'));
    first.value = '/shared';
    fire(first, 'change');
    await settle();
    expect(view.node.querySelector('pre')?.textContent).toBe('content of md/shared.md');

    generate.mockResolvedValueOnce(generated([['/new', 'written'], ['/shared', 'cached']]));
    buttonNamed(view.node, 'Generate').click();
    await settle();

    const second = /** @type {HTMLSelectElement} */ (view.node.querySelector('select[aria-label="Route to preview"]'));
    expect(second.value).toBe('/new');
    expect(view.node.querySelector('pre')).toBeNull();
    expect(view.node.textContent).toContain('Pick a route and press Show.');

    buttonNamed(view.node, 'Show').click();
    await settle();
    expect(view.node.querySelector('pre')?.textContent).toBe('content of md/new.md');
  });

  it('never lets a slow earlier read land under a later route', async () => {
    vi.spyOn(api, 'generate').mockResolvedValue(generated([['/a', 'written'], ['/b', 'written']]));
    /** @type {Array<() => void>} */
    const pending = [];
    vi.spyOn(api, 'readFile').mockImplementation(
      (path) => new Promise((resolve) => pending.push(() => resolve({ path, content: `content of ${path}` }))),
    );
    const { ctx } = makeCtx();
    const view = createGenerateView(ctx);
    buttonNamed(view.node, 'Generate').click();
    await settle();

    const select = /** @type {HTMLSelectElement} */ (view.node.querySelector('select[aria-label="Route to preview"]'));
    buttonNamed(view.node, 'Show').click();
    select.value = '/b';
    fire(select, 'change');
    pending[1]();
    await settle();
    pending[0]();
    await settle();
    expect(select.value).toBe('/b');
    expect(view.node.querySelector('pre')?.textContent).toBe('content of md/b.md');
  });
});

// -- prod ----------------------------------------------------------------------------------------

/** @param {Partial<ProdProbe>} over @returns {ProdProbe} */
const probe = (over) =>
  /** @type {ProdProbe} */ ({ id: 'p', title: 'A probe', lever: 'routing', status: 200, verdict: 'pass', reason: 'Fine.', headers: {}, curl: 'curl -sI x', ...over });

/** @returns {ProdVerification} */
function verification() {
  return {
    target: 'http://localhost:3000/',
    twinUrl: 'http://localhost:3000/index.md',
    bot: 'ExampleBot',
    installed: false,
    probes: [probe({ id: 'b', lever: 'blocking', title: 'Blocking probe' }), probe({ id: 'r', lever: 'routing', title: 'Routing probe' })],
    robots: { url: 'http://localhost:3000/robots.txt', found: true, allowed: [], blocked: ['GPTBot'], notes: ['Same note.', 'Same note.'] },
    conflicts: [],
    counts: { pass: 2, warn: 0, fail: 0 },
    ok: true,
  };
}

describe('prod helpers', () => {
  it('offers only crawlers with a User-Agent to send', () => {
    expect(routableNames([bot('A'), bot('RobotsOnly', []), bot('B')])).toEqual(['A', 'B']);
  });

  it('prints the request, a blank line, then the headers or the fallback', () => {
    expect(probeTranscript(probe({ headers: { Vary: 'Accept', 'X-AEO-Version': '1' } }))).toBe('curl -sI x\n\nVary: Accept\nX-AEO-Version: 1');
    expect(probeTranscript(probe({}))).toBe('curl -sI x\n\n(no OpenGEO headers came back)');
  });

  it('has no hard-coded default crawler', () => {
    const source = readFileSync(new URL('../web/views/prod.js', import.meta.url), 'utf8');
    expect(source).not.toContain('ClaudeBot');
  });
});

describe('the prod view', () => {
  it('names the server default bot and lists the routable crawlers', () => {
    const { ctx } = makeCtx({ bots: [bot('A'), bot('RobotsOnly', [])] });
    const view = createProdView(ctx);
    expect(view.node.firstElementChild?.querySelector('h1')?.textContent).toBe('Prod');
    const select = /** @type {HTMLSelectElement} */ (labelled(view.node, 'Impersonate'));
    expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
      ['', 'ExampleBot (default)'],
      ['A', 'A'],
    ]);
    expect(select.value).toBe('');
    expect(visibleText(view.node)).toContain('No probes run yet');
  });

  it('picks up a new crawler on update and keeps the choice and the node', () => {
    const { ctx, setBots } = makeCtx({ bots: [bot('A'), bot('B')] });
    const view = createProdView(ctx);
    const select = /** @type {HTMLSelectElement} */ (labelled(view.node, 'Impersonate'));
    const url = labelled(view.node, 'Site URL');
    select.value = 'B';
    setBots([bot('A'), bot('B'), bot('AcmeBot')]);
    view.update();
    expect(labelled(view.node, 'Impersonate')).toBe(select);
    expect(labelled(view.node, 'Site URL')).toBe(url);
    expect([...select.options].map((option) => option.value)).toEqual(['', 'A', 'B', 'AcmeBot']);
    expect(select.value).toBe('B');

    setBots([bot('A')]);
    view.update();
    expect(select.value).toBe('');
  });

  it('leaves the options alone when a reload brings the same list back', () => {
    const { ctx, setBots } = makeCtx({ bots: [bot('A')] });
    const view = createProdView(ctx);
    const option = /** @type {HTMLSelectElement} */ (labelled(view.node, 'Impersonate')).options[1];
    setBots([bot('A')]);
    view.update();
    expect(/** @type {HTMLSelectElement} */ (labelled(view.node, 'Impersonate')).options[1]).toBe(option);
  });

  it('runs the probes and draws the report by lever', async () => {
    const prodTest = vi.spyOn(api, 'prodTest').mockResolvedValue(verification());
    const { ctx } = makeCtx({ bots: [bot('A')] });
    const view = createProdView(ctx);
    buttonNamed(view.node, 'Run probes').click();
    expect(buttonNamed(view.node, 'Probing').disabled).toBe(true);
    await settle();

    expect(prodTest).toHaveBeenCalledWith({ url: 'http://localhost:3000', bot: undefined });
    const titles = [...view.node.querySelectorAll('.card-head h2')].map((node) => node.textContent);
    expect(titles).toEqual(['Lever 1 - markdown routing', 'Lever 2 - robots.txt blocking', 'robots.txt']);
    expect(view.node.querySelector('[role="alert"] h2')?.textContent).toBe('No response carried X-AEO-Version');
    expect(view.node.textContent).toContain('Impersonated ExampleBot. Twin URL http://localhost:3000/index.md.');
    expect(view.node.textContent).toContain('nothing named explicitly');
    const notes = [...view.node.querySelectorAll('.stack-sm > div.muted')].filter((node) => node.textContent === 'Same note.');
    expect(notes).toHaveLength(2);
    expect(visibleText(view.node)).not.toContain('No probes run yet');
    expect(skipsALevel(headingLevels(view.node))).toBe(false);
  });

  it('sends the chosen crawler by name', async () => {
    const prodTest = vi.spyOn(api, 'prodTest').mockResolvedValue(verification());
    const { ctx } = makeCtx({ bots: [bot('A')] });
    const view = createProdView(ctx);
    /** @type {HTMLSelectElement} */ (labelled(view.node, 'Impersonate')).value = 'A';
    buttonNamed(view.node, 'Run probes').click();
    await settle();
    expect(prodTest).toHaveBeenCalledWith({ url: 'http://localhost:3000', bot: 'A' });
  });

  it('clears the report when a later run fails', async () => {
    const prodTest = vi.spyOn(api, 'prodTest').mockResolvedValueOnce(verification());
    const { ctx } = makeCtx();
    const view = createProdView(ctx);
    buttonNamed(view.node, 'Run probes').click();
    await settle();
    prodTest.mockRejectedValueOnce(new ApiError('Nothing is listening.', 400));
    buttonNamed(view.node, 'Run probes').click();
    await settle();
    expect(view.node.querySelector('[role="alert"] h2')?.textContent).toBe('The probes could not run');
    expect(view.node.textContent).toContain('Nothing is listening.');
    expect(view.node.querySelector('details.probe')).toBeNull();
    expect(visibleText(view.node)).toContain('No probes run yet');
  });
});
