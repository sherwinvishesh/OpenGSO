import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_BOTS, resolveBots } from '../../core/src/shared/bots.js';
import { PROVIDERS } from '../../core/src/shared/providers.js';
import { routableOnly } from '../web/components/bot-picker.js';
import { providerInfoOf } from '../web/components/provider-fields.js';
import { useDocument } from '../web/ui.js';
import { createOnboarding, keyStepReady, keyStepSaves, nextFixes, previewNote, probeable } from '../web/views/onboarding.js';

/**
 * @import { AiBot, CheckResult, StateResponse, TestResponse } from '../../core/src/shared/api-types.js'
 * @import { Ctx } from '../web/context.js'
 */

/** @type {import('jsdom').DOMWindow} */
let win;

// Scripts never run: this jsdom is a document to build nodes in, nothing more.
beforeEach(() => {
  win = new JSDOM('<!doctype html><body></body>').window;
  useDocument(win.document);
  // Every mounted view starts a URL probe on a 450ms timer, and nothing unmounts it. On real timers
  // that probe fires during whichever test is running by then and calls that test's fetch stub. On
  // a per-test fake clock it dies with the test.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const catalog = [...PROVIDERS];
const bots = /** @type {AiBot[]} */ ([...AI_BOTS]);
const routable = routableOnly(bots);

/**
 * @param {{ [K in keyof StateResponse]?: Partial<StateResponse[K]> }} [overrides]
 * @returns {StateResponse}
 */
function makeState(overrides = {}) {
  const base = {
    root: '/p',
    configPath: '/p/opengeo.config.json',
    configExists: false,
    config: {
      site: 'http://localhost:3000',
      publicDir: 'public',
      internalDir: '.opengeo',
      extraRoutes: [],
      crawl: { maxPages: 50, maxDepth: 3, exclude: [] },
      generate: { tier: 'free', minWords: 120 },
      bots: { markdownRouting: routable.map((bot) => bot.name), blocked: [], custom: [] },
      ai: { provider: 'anthropic', model: 'claude-sonnet-5' },
    },
    version: '1.0.0',
    packageName: 'opengeo',
    key: { present: false, path: '/p/.env' },
    ci: false,
    providerCatalog: catalog,
    publicDir: '/p/public',
    internalDir: '/p/.opengeo',
    webRoot: { dir: 'static', why: 'a static folder is next to the config', found: true },
    checkCount: 22,
    bands: { structural: { good: 90, fair: 60 }, content: { good: 75, fair: 50 } },
  };
  return /** @type {StateResponse} */ (/** @type {unknown} */ ({
    ...base,
    ...overrides,
    config: { ...base.config, ...(overrides.config ?? {}) },
    key: { ...base.key, ...(overrides.key ?? {}) },
    webRoot: { ...base.webRoot, ...(overrides.webRoot ?? {}) },
  }));
}

/** @param {StateResponse} initial */
function makeCtx(initial) {
  let state = initial;
  const reload = vi.fn(async () => {});
  const onTestResult = vi.fn();
  const ctx = /** @type {Ctx} */ (/** @type {unknown} */ ({
    state: () => state,
    bots: () => resolveBots(state.config.bots.custom),
    reload,
    go: () => {},
    lastTest: () => undefined,
    onTestResult,
  }));
  return {
    ctx,
    reload,
    onTestResult,
    /** @param {StateResponse} next */
    setState(next) {
      state = next;
    },
  };
}

/**
 * Builds the screen the way app.js does: in the document, then updated.
 *
 * @param {StateResponse} [state]
 */
function mount(state = makeState()) {
  const holder = makeCtx(state);
  const onDone = vi.fn();
  const view = createOnboarding(holder.ctx, onDone);
  win.document.body.append(view.node);
  view.update();
  return { ...holder, view, onDone };
}

/** @param {Element} node @param {string} type */
function fire(node, type) {
  node.dispatchEvent(new win.Event(type, { bubbles: true }));
}

/** @param {ParentNode} root @param {string} text */
function buttonNamed(root, text) {
  const found = [...root.querySelectorAll('button')].find((node) => node.textContent?.trim() === text && !hiddenIn(node));
  if (!found) throw new Error(`No button "${text}"`);
  return /** @type {HTMLButtonElement} */ (found);
}

/** @param {ParentNode} root @param {string} label */
function control(root, label) {
  const found = [...root.querySelectorAll('label')].find((node) => node.textContent === label);
  const id = found?.getAttribute('for');
  const node = id ? root.querySelector(`#${id}`) : null;
  if (!node) throw new Error(`No control labelled "${label}"`);
  return /** @type {HTMLInputElement} */ (node);
}

/** @param {Element} node */
function hiddenIn(node) {
  for (let at = /** @type {Element | null} */ (node); at; at = at.parentElement) {
    if (/** @type {HTMLElement} */ (at).hidden) return true;
  }
  return false;
}

/** @param {Element} root */
function visibleText(root) {
  /** @type {string[]} */
  const parts = [];
  const walk = (/** @type {Node} */ node) => {
    if (node.nodeType === 3) parts.push(node.textContent ?? '');
    else if (node.nodeType === 1 && !(/** @type {HTMLElement} */ (node).hidden)) node.childNodes.forEach(walk);
  };
  walk(root);
  return parts.join('');
}

const settle = () => vi.advanceTimersByTimeAsync(0);

/** @param {string} event @param {unknown} data */
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * @param {Partial<CheckResult>} over
 * @returns {CheckResult}
 */
function check(over) {
  return /** @type {CheckResult} */ ({
    id: 'A1',
    category: 'A',
    importance: 'required',
    title: 'Page answers',
    weight: 4,
    status: 'pass',
    earned: 4,
    reason: 'It answered.',
    ...over,
  });
}

/** @param {Partial<TestResponse>} [over] @returns {TestResponse} */
function testResult(over = {}) {
  return /** @type {TestResponse} */ ({
    mode: 'structure',
    url: 'http://localhost:3000/',
    twinUrl: 'http://localhost:3000/index.md',
    score: {
      value: 54,
      earned: 54,
      possible: 100,
      counts: { pass: 1, partial: 1, fail: 2, locked: 0, na: 0 },
      lost: [],
      locked: { count: 0, points: 0, unlockedBy: [] },
    },
    checks: [
      check({ id: 'A1' }),
      check({ id: 'B1', title: 'Twin exists', weight: 10, status: 'fail', earned: 0, reason: 'No twin.', fix: 'Run generate.' }),
      check({ id: 'A3', title: 'Sitemap', weight: 3, status: 'fail', earned: 0, reason: 'No sitemap.' }),
      check({ id: 'B7', title: 'Vary', weight: 4, status: 'partial', earned: 2, reason: 'Half there.' }),
    ],
    history: { trend: [], previous: null },
    structure: undefined,
    content: null,
    discovery: null,
    contentSkipped: null,
    contentError: null,
    ...over,
  });
}

// -- pure helpers --------------------------------------------------------------------------------

describe('probeable', () => {
  it('waits for a whole absolute URL', () => {
    expect(probeable('')).toBe(false);
    expect(probeable('localhost:3000')).toBe(false);
    expect(probeable('http://')).toBe(false);
    expect(probeable('http://l')).toBe(true);
    expect(probeable('  https://example.com/docs ')).toBe(true);
  });
});

describe('nextFixes', () => {
  it('ranks failures and partials by points recoverable, three at most', () => {
    const checks = [
      check({ id: 'A1' }),
      check({ id: 'X1', weight: 2, status: 'fail', earned: 0 }),
      check({ id: 'X2', weight: 10, status: 'fail', earned: 0 }),
      check({ id: 'X3', weight: 8, status: 'partial', earned: 2 }),
      check({ id: 'X4', weight: 5, status: 'fail', earned: 0 }),
      check({ id: 'X5', weight: 9, status: 'locked', earned: 0 }),
    ];
    expect(nextFixes(checks).map((entry) => entry.id)).toEqual(['X2', 'X3', 'X4']);
  });
});

describe('the key step', () => {
  const anthropic = providerInfoOf(catalog, 'anthropic');
  const ollama = providerInfoOf(catalog, 'ollama');
  const draft = { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: '', baseUrl: '', api: 'anthropic' };
  const none = /** @type {StateResponse['key']} */ ({ present: false, path: '/p/.env' });
  const saved = /** @type {StateResponse['key']} */ ({ present: true, provider: 'anthropic', path: '/p/.env' });

  it('is a skip until something worth writing is in it', () => {
    expect(keyStepSaves(draft, anthropic, none, false)).toBe(false);
    expect(keyStepSaves(draft, anthropic, none, true)).toBe(false);
    expect(keyStepSaves({ ...draft, apiKey: 'sk-1' }, anthropic, none, false)).toBe(true);
  });

  it('saves a keyless provider without a key', () => {
    expect(keyStepSaves({ ...draft, provider: 'ollama' }, ollama, none, false)).toBe(true);
  });

  it('keeps a saved key only once the step was edited', () => {
    expect(keyStepSaves(draft, anthropic, saved, false)).toBe(false);
    expect(keyStepSaves(draft, anthropic, saved, true)).toBe(true);
    expect(keyStepReady(draft, anthropic, saved, true)).toBe(true);
  });

  it('holds only a step that will write to the provider rules', () => {
    expect(keyStepReady(draft, anthropic, none, true)).toBe(true);
    expect(keyStepReady({ ...draft, apiKey: 'sk-1', model: '' }, anthropic, none, true)).toBe(false);
  });
});

describe('previewNote', () => {
  it('says it is checking while a check is pending', () => {
    expect(previewNote(undefined, true)?.textContent).toBe('Checking that URL...');
    expect(previewNote(undefined, false)).toBeNull();
  });

  it('reports an unreachable site without an error banner', () => {
    const note = previewNote({ url: 'http://x', ok: false, status: 0, ttfbMs: 0, error: 'ECONNREFUSED' }, false);
    expect(note?.textContent).toBe('no answer Could not reach it: ECONNREFUSED. Saved either way, and nothing else in setup depends on it.');
    expect(note?.querySelector('.banner')).toBeNull();
  });

  it('describes a reachable site and what is at its twin URL', () => {
    const note = previewNote(
      {
        url: 'http://x',
        ok: true,
        status: 200,
        ttfbMs: 12,
        framework: 'Next.js',
        clientRendered: true,
        twin: { url: 'http://x/index.md', ok: false, status: 404, served: false },
      },
      false,
    );
    expect(note?.textContent).toContain('reachable 200 in 12ms, Next.js');
    expect(note?.textContent).toContain('Server-rendering is the fix.');
    expect(note?.textContent).toContain('No twin at http://x/index.md yet.');
  });
});

// -- the view ------------------------------------------------------------------------------------

describe('createOnboarding', () => {
  it('heads the screen with an h1 and each step with an h2, focusing the site field first', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { view } = mount();
    const headings = [...view.node.querySelectorAll('h1, h2, h3')].filter((node) => !hiddenIn(node));
    expect(headings.map((node) => node.tagName)).toEqual(['H1', 'H2']);
    expect(headings[1]?.textContent).toBe('Project');
    expect(visibleText(view.node)).toContain('Step 1 of 3');
    expect(win.document.activeElement).toBe(control(view.node, 'Site URL'));
    expect(view.node.textContent).toContain('Everything is written into /p.');
  });

  it('takes the web root and its default from the server', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { view, setState } = mount();
    expect(control(view.node, 'Web root').value).toBe('static');
    expect(view.node.textContent).toContain('Where generated files land. a static folder is next to the config.');

    setState(makeState({ config: { publicDir: 'dist' }, webRoot: { found: false, dir: 'dist' } }));
    view.update();
    expect(control(view.node, 'Web root').value).toBe('dist');
    expect(control(view.node, 'Web root').placeholder).toBe('dist');
    expect(view.node.textContent).toContain('Where generated files land. Default: dist');

    control(view.node, 'Web root').value = 'out';
    fire(control(view.node, 'Web root'), 'input');
    setState(makeState({ config: { publicDir: 'build' } }));
    view.update();
    expect(control(view.node, 'Web root').value).toBe('out');
  });

  it('moves focus to the new step heading on Next, Skip and Back', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { view } = mount();
    const dots = view.node.querySelectorAll('.step-dot');
    expect(buttonNamed(view.node, 'Back').disabled).toBe(true);

    buttonNamed(view.node, 'Next').click();
    const heading = /** @type {HTMLElement} */ (view.node.querySelector('.card h2'));
    expect(heading.textContent).toBe('AI key');
    expect(win.document.activeElement).toBe(heading);
    expect(dots[1]?.classList.contains('done')).toBe(true);
    expect(dots[2]?.classList.contains('done')).toBe(false);

    // Nothing typed, so leaving writes nothing and says so.
    buttonNamed(view.node, 'Skip').click();
    expect(heading.textContent).toBe('Bots');
    expect(win.document.activeElement).toBe(heading);
    expect(buttonNamed(view.node, 'Finish')).toBeTruthy();

    buttonNamed(view.node, 'Back').click();
    expect(heading.textContent).toBe('AI key');
    expect(win.document.activeElement).toBe(heading);
    control(view.node, 'API key').value = 'sk-1';
    fire(control(view.node, 'API key'), 'input');
    expect(buttonNamed(view.node, 'Next')).toBeTruthy();
  });

  it('will not leave the project step without a site', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { view } = mount();
    const site = control(view.node, 'Site URL');
    site.value = '  ';
    fire(site, 'input');
    expect(buttonNamed(view.node, 'Next').disabled).toBe(true);
  });

  it('keeps a typed site across a reload and follows the server otherwise', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { view, setState } = mount();
    const site = control(view.node, 'Site URL');
    setState(makeState({ config: { site: 'http://localhost:4000' } }));
    view.update();
    expect(control(view.node, 'Site URL')).toBe(site);
    expect(site.value).toBe('http://localhost:4000');

    site.value = 'http://localhost:5000';
    fire(site, 'input');
    setState(makeState({ config: { site: 'http://localhost:6000' }, root: '/q' }));
    view.update();
    expect(site.value).toBe('http://localhost:5000');
    expect(view.node.textContent).toContain('Everything is written into /q.');
  });

  it('clears the previous preview as soon as a new check starts, and only the newest draws', async () => {
    vi.useFakeTimers();
    /** @type {AbortSignal[]} */
    const signals = [];
    /** @type {Array<(response: Response) => void>} */
    const answers = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((/** @type {string} */ _path, /** @type {RequestInit} */ init) => {
        if (init.signal) signals.push(init.signal);
        return new Promise((resolve) => answers.push(resolve));
      }),
    );
    const { view } = mount();
    const site = control(view.node, 'Site URL');
    expect(view.node.textContent).toContain('Checking that URL...');

    await vi.advanceTimersByTimeAsync(450);
    answers[0]?.(new Response(JSON.stringify({ preview: { url: 'http://localhost:3000', ok: true, status: 200, ttfbMs: 9 } })));
    await vi.advanceTimersByTimeAsync(0);
    expect(view.node.textContent).toContain('200 in 9ms');

    site.value = 'http://localhost:4000';
    fire(site, 'input');
    expect(view.node.textContent).not.toContain('200 in 9ms');
    expect(view.node.textContent).toContain('Checking that URL...');

    await vi.advanceTimersByTimeAsync(450);
    site.value = 'http://localhost:5000';
    fire(site, 'input');
    expect(signals[1]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(450);

    // The aborted check answering late must not draw over the newer one.
    answers[1]?.(new Response(JSON.stringify({ preview: { url: 'http://localhost:4000', ok: true, status: 200, ttfbMs: 41 } })));
    await vi.advanceTimersByTimeAsync(0);
    expect(view.node.textContent).not.toContain('41ms');
    expect(view.node.textContent).toContain('Checking that URL...');

    answers[2]?.(new Response(JSON.stringify({ preview: { url: 'http://localhost:5000', ok: false, status: 503, ttfbMs: 7 } })));
    await vi.advanceTimersByTimeAsync(0);
    expect(view.node.textContent).toContain('That URL answered 503.');

    site.value = 'localh';
    fire(site, 'input');
    expect(view.node.textContent).not.toContain('That URL answered');
    expect(view.node.textContent).not.toContain('Checking that URL...');
  });

  it('offers every routing mode and lets a crawler be picked by name', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { view } = mount();
    buttonNamed(view.node, 'Next').click();
    buttonNamed(view.node, 'Skip').click();
    const modes = /** @type {HTMLElement} */ (view.node.querySelector('[aria-label="Markdown routing"]'));
    const pick = /** @type {HTMLButtonElement} */ ([...modes.querySelectorAll('button')].find((node) => node.textContent?.includes('Let me pick')));
    expect(view.node.textContent).toContain(`${routable.length} of ${routable.length} agents.`);
    expect(pick.getAttribute('aria-pressed')).toBe('false');

    pick.click();
    expect(pick.getAttribute('aria-pressed')).toBe('true');
    const first = /** @type {HTMLInputElement} */ (view.node.querySelector('.crawler-grid input[type="checkbox"]'));
    expect(first.checked).toBe(true);
    first.click();
    expect(first.checked).toBe(false);
  });

  it('refuses a robots.txt-only name and promises a write on save rather than claiming one', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { view } = mount();
    buttonNamed(view.node, 'Next').click();
    buttonNamed(view.node, 'Skip').click();
    const modes = /** @type {HTMLElement} */ (view.node.querySelector('[aria-label="Markdown routing"]'));
    /** @type {HTMLButtonElement} */ ([...modes.querySelectorAll('button')].find((node) => node.textContent?.includes('Let me pick'))).click();
    buttonNamed(view.node, '+ Add a crawler OpenGEO has never heard of').click();

    const robotsOnly = /** @type {AiBot} */ (bots.find((bot) => bot.uaPatterns.length === 0));
    const name = control(view.node, 'Name');
    name.value = robotsOnly.name;
    buttonNamed(view.node, 'Add crawler').click();
    expect(view.node.querySelector('.form-error')?.textContent).toBe(`${robotsOnly.name} is already on the list.`);
    expect(view.node.textContent).toContain('Written to opengeo.config.json when you save. Your site picks it up on the next restart.');
    expect(view.node.textContent).not.toContain('Saved into');

    name.value = 'AcmeBot';
    buttonNamed(view.node, 'Add crawler').click();
    const added = [...view.node.querySelectorAll('.crawler-grid label')].find((node) => node.textContent?.includes('AcmeBot'));
    expect(/** @type {HTMLInputElement} */ (added?.querySelector('input')).checked).toBe(true);
  });

  it('saves, then streams the first test into the progress panel and ends on the score', async () => {
    const result = testResult();
    /** @type {Array<{ path: string; body: unknown }>} */
    const sent = [];
    /** @type {(text: string) => void} */
    let finishStream = () => {};
    /** @type {ReadableStreamDefaultController<Uint8Array> | undefined} */
    let streamController;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init) => {
        sent.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (path === '/api/preview') return new Promise(() => {});
        if (path === '/api/config') return new Response(JSON.stringify({ config: {}, configPath: '/p/opengeo.config.json' }));
        if (path === '/api/test/stream') {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              streamController = controller;
              controller.enqueue(encoder.encode(frame('progress', { phase: 'structure' })));
            },
          });
          finishStream = (text) => {
            streamController?.enqueue(encoder.encode(text));
            streamController?.close();
          };
          return new Response(stream);
        }
        throw new Error(`unexpected ${path}`);
      }),
    );
    const { view, onDone, reload, onTestResult } = mount();
    buttonNamed(view.node, 'Next').click();
    buttonNamed(view.node, 'Skip').click();
    buttonNamed(view.node, 'Finish').click();
    await settle();
    await settle();

    const config = sent.find((entry) => entry.path === '/api/config');
    expect(config?.body).toEqual({
      site: 'http://localhost:3000',
      publicDir: 'static',
      bots: { markdownRouting: routable.map((bot) => bot.name), blocked: [], custom: [] },
    });
    // A skipped key step writes nothing.
    expect(sent.some((entry) => entry.path === '/api/key')).toBe(false);

    const savedHeading = [...view.node.querySelectorAll('h2')].find((node) => node.textContent === 'Where you stand');
    expect(win.document.activeElement).toBe(savedHeading);
    expect(visibleText(view.node)).toContain('Running the structural test');
    expect(visibleText(view.node)).toContain('Auditing the live URL');
    expect(buttonNamed(view.node, 'Open the dashboard').disabled).toBe(true);

    finishStream(frame('done', { status: 200, body: result }));
    await settle();
    await settle();
    await settle();
    expect(visibleText(view.node)).toContain('54 of 100 applicable points');
    expect(visibleText(view.node)).toContain('Do this next (most points first)');
    expect([...view.node.querySelectorAll('.check-points')].map((node) => node.textContent)).toEqual(['+10', '+3', '+2']);
    expect(view.node.textContent).toContain('Run generate.');

    buttonNamed(view.node, 'Open the dashboard').click();
    expect(onDone).toHaveBeenCalledWith(result);
    // The shell's gate is the app's to move, after onDone.
    expect(reload).not.toHaveBeenCalled();
    expect(onTestResult).not.toHaveBeenCalled();
  });

  it('keeps the closing screen when the first test cannot run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (/** @type {string} */ path) => {
        if (path === '/api/preview') return new Promise(() => {});
        if (path === '/api/config') return new Response(JSON.stringify({ config: {}, configPath: '/p/opengeo.config.json' }));
        return new Response(frame('done', { status: 400, body: { error: 'Nothing answered at that URL.' } }));
      }),
    );
    const { view, onDone } = mount();
    buttonNamed(view.node, 'Next').click();
    buttonNamed(view.node, 'Skip').click();
    buttonNamed(view.node, 'Finish').click();
    for (let i = 0; i < 6; i += 1) await settle();
    expect(visibleText(view.node)).toContain('The score did not run');
    expect(visibleText(view.node)).toContain('Nothing answered at that URL. The settings are saved, and Test in the dashboard will try again.');
    buttonNamed(view.node, 'Open the dashboard').click();
    expect(onDone).toHaveBeenCalledWith(undefined);
  });

  it('shows a failed save on the form and stays there', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (/** @type {string} */ path) => {
        if (path === '/api/preview') return new Promise(() => {});
        return new Response(JSON.stringify({ error: 'The web root must be inside the project.' }), { status: 400 });
      }),
    );
    const { view } = mount();
    buttonNamed(view.node, 'Next').click();
    buttonNamed(view.node, 'Skip').click();
    buttonNamed(view.node, 'Finish').click();
    for (let i = 0; i < 4; i += 1) await settle();
    expect(visibleText(view.node)).toContain('The web root must be inside the project.');
    expect(buttonNamed(view.node, 'Finish').disabled).toBe(false);
    expect(visibleText(view.node)).not.toContain('Where you stand');
  });

  it('sends a typed key with the provider, before the config', async () => {
    /** @type {Array<{ path: string; body: unknown }>} */
    const sent = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init) => {
        sent.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (path === '/api/preview') return new Promise(() => {});
        if (path === '/api/test/stream') return new Promise(() => {});
        return new Response(JSON.stringify({}));
      }),
    );
    const { view } = mount();
    buttonNamed(view.node, 'Next').click();
    const key = control(view.node, 'API key');
    key.value = '  sk-test  ';
    fire(key, 'input');
    buttonNamed(view.node, 'Next').click();
    buttonNamed(view.node, 'Finish').click();
    for (let i = 0; i < 4; i += 1) await settle();
    const paths = sent.map((entry) => entry.path).filter((path) => path !== '/api/preview');
    expect(paths.slice(0, 2)).toEqual(['/api/key', '/api/config']);
    expect(sent.find((entry) => entry.path === '/api/key')?.body).toMatchObject({ provider: 'anthropic', apiKey: 'sk-test' });
  });
});
