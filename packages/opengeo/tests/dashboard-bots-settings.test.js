import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_BOTS, resolveBots } from '../../core/src/shared/bots.js';
import { PROVIDERS } from '../../core/src/shared/providers.js';
import {
  assistantNames,
  routableOnly,
  routingForMode,
  routingModeOf,
  sameCustom,
  sameNames,
  shownBots,
  toggled,
} from '../web-next/components/bot-picker.js';
import { customEndpointLabel, draftReady, keyKept, providerInfoOf } from '../web-next/components/provider-fields.js';
import { useDocument } from '../web-next/ui.js';
import { createBotsView } from '../web-next/views/bots.js';
import { createSettingsView, wholeNumber } from '../web-next/views/settings.js';

/**
 * @import { AiBot, StateResponse } from '../../core/src/shared/api-types.js'
 * @import { Ctx } from '../web-next/context.js'
 */

/** @type {import('jsdom').DOMWindow} */
let win;

// Scripts never run: this jsdom is a document to build nodes in, nothing more.
beforeEach(() => {
  win = new JSDOM('<!doctype html><body></body>').window;
  useDocument(win.document);
});

afterEach(() => {
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
    configExists: true,
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
    key: { present: true, provider: 'anthropic', model: 'claude-sonnet-5', source: 'env-file', path: '/p/.env' },
    ci: false,
    providerCatalog: catalog,
    publicDir: '/p/public',
    internalDir: '/p/.opengeo',
  };
  return /** @type {StateResponse} */ (/** @type {unknown} */ ({
    ...base,
    ...overrides,
    config: { ...base.config, ...(overrides.config ?? {}) },
    key: { ...base.key, ...(overrides.key ?? {}) },
  }));
}

/** @param {StateResponse} initial */
function makeCtx(initial) {
  let state = initial;
  let list = resolveBots(initial.config.bots.custom);
  const reload = vi.fn(async () => {});
  const ctx = /** @type {Ctx} */ (/** @type {unknown} */ ({
    state: () => state,
    bots: () => [...list],
    reload,
    go: () => {},
    lastTest: () => undefined,
    onTestResult: () => {},
  }));
  return {
    ctx,
    reload,
    /** @param {StateResponse} next */
    setState(next) {
      state = next;
      list = resolveBots(next.config.bots.custom);
    },
    /** @param {AiBot[]} next */
    setBots(next) {
      list = next;
    },
  };
}

/** @param {Element} node @param {string} type */
function fire(node, type) {
  node.dispatchEvent(new win.Event(type, { bubbles: true }));
}

/** @param {ParentNode} root @param {string} text */
function buttonNamed(root, text) {
  const found = [...root.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  if (!found) throw new Error(`No button "${text}"`);
  return found;
}

/** @param {ParentNode} root @param {string} label */
function control(root, label) {
  const found = [...root.querySelectorAll('label')].find((node) => node.textContent === label);
  const id = found?.getAttribute('for');
  const node = id ? root.querySelector(`#${id}`) : null;
  if (!node) throw new Error(`No control labelled "${label}"`);
  return /** @type {HTMLInputElement} */ (node);
}

/** @param {unknown} body */
function stubFetch(body) {
  const fetch = vi.fn(async (/** @type {string} */ _path, /** @type {RequestInit} */ _init) => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

// -- pure helpers --------------------------------------------------------------------------------

describe('draftReady', () => {
  const anthropic = providerInfoOf(catalog, 'anthropic');
  const ollama = providerInfoOf(catalog, 'ollama');
  const custom = providerInfoOf(catalog, 'custom');
  const draft = { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: '', baseUrl: '', api: 'anthropic' };

  it('needs a key when none is saved', () => {
    expect(draftReady(draft, anthropic)).toBe(false);
    expect(draftReady({ ...draft, apiKey: '   ' }, anthropic)).toBe(false);
    expect(draftReady({ ...draft, apiKey: 'sk-1' }, anthropic)).toBe(true);
  });

  it('accepts a blank key when one is already present', () => {
    expect(draftReady(draft, anthropic, { keyPresent: true })).toBe(true);
    expect(draftReady(draft, anthropic, { keyOptional: true })).toBe(true);
  });

  it('always needs a model', () => {
    expect(draftReady({ ...draft, model: ' ', apiKey: 'sk-1' }, anthropic, { keyPresent: true })).toBe(false);
  });

  it('lets a keyless provider through with no key', () => {
    expect(draftReady({ ...draft, provider: 'ollama', model: 'llama3.2' }, ollama)).toBe(true);
  });

  it('needs a base URL for a user-defined endpoint', () => {
    const own = { ...draft, provider: 'custom', model: 'm', apiKey: 'k' };
    expect(draftReady(own, custom)).toBe(false);
    expect(draftReady({ ...own, baseUrl: 'https://gw.example.com/v1' }, custom)).toBe(true);
  });
});

describe('keyKept', () => {
  const key = { present: true, provider: /** @type {const} */ ('anthropic'), path: '/p/.env' };
  it('keeps a key only for the provider it belongs to', () => {
    expect(keyKept(key, 'anthropic')).toBe(true);
    expect(keyKept(key, 'groq')).toBe(false);
    expect(keyKept({ ...key, present: false }, 'anthropic')).toBe(false);
  });
});

describe('customEndpointLabel', () => {
  it('names the option the catalogue actually has', () => {
    expect(customEndpointLabel(catalog)).toBe('Something else (your own endpoint)');
    expect(customEndpointLabel([])).toBe('Your own endpoint');
  });
});

describe('routing modes', () => {
  const assistants = assistantNames(routable);

  it('leaves robots.txt-only bots out of the routable list', () => {
    expect(routable.every((bot) => bot.uaPatterns.length > 0)).toBe(true);
    expect(routable.length).toBeLessThan(bots.length);
  });

  it('derives the mode from the selection, in any order', () => {
    expect(routingModeOf([], routable)).toBe('none');
    expect(routingModeOf([...routable.map((bot) => bot.name)].reverse(), routable)).toBe('all');
    expect(routingModeOf(assistants, routable)).toBe('assistants');
    expect(routingModeOf(assistants.slice(1), routable)).toBe('custom');
  });

  it('turns a mode back into a list, and custom keeps the current one', () => {
    expect(routingForMode('all', routable, [])).toEqual(routable.map((bot) => bot.name));
    expect(routingForMode('assistants', routable, [])).toEqual(assistants);
    expect(routingForMode('none', routable, ['GPTBot'])).toEqual([]);
    expect(routingForMode('custom', routable, ['GPTBot'])).toEqual(['GPTBot']);
  });

  it('compares names as sets and custom bots by content', () => {
    expect(sameNames(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameNames(['a'], ['a', 'a'])).toBe(false);
    expect(sameCustom([{ name: 'Acme', uaPatterns: ['acme'] }], [{ name: 'Acme', uaPatterns: ['acme'] }])).toBe(true);
    expect(sameCustom([{ name: 'Acme', uaPatterns: ['acme'] }], [{ name: 'Acme', uaPatterns: ['acmebot'] }])).toBe(false);
  });

  it('toggles a name in and out', () => {
    expect(toggled(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggled(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('shows the local custom list, not the server copy', () => {
    const server = /** @type {AiBot[]} */ ([...resolveBots([{ name: 'OldBot' }])]);
    const names = shownBots(server, [{ name: 'NewBot' }, { name: 'gptbot' }]).map((bot) => bot.name);
    expect(names).toContain('NewBot');
    expect(names).not.toContain('OldBot');
    expect(names.filter((name) => name.toLowerCase() === 'gptbot')).toEqual(['GPTBot']);
  });
});

describe('wholeNumber', () => {
  it.each([
    ['0', 1, undefined],
    ['1.5', 1, undefined],
    ['3abc', 0, undefined],
    ['', 0, undefined],
    ['-1', 0, undefined],
    [' 10 ', 1, 10],
    ['0', 0, 0],
  ])('reads %j with min %d as %j', (raw, min, expected) => {
    expect(wholeNumber(raw, min)).toBe(expected);
  });
});

// -- Bot settings --------------------------------------------------------------------------------

describe('the Bot settings view', () => {
  it('starts with the page heading and the presets, counted from the list', () => {
    const { ctx } = makeCtx(makeState());
    const view = createBotsView(ctx);
    view.update();
    expect(view.node.firstElementChild?.querySelector('h1')?.textContent).toBe('Bot settings');
    const everyone = buttonNamed(view.node, `Everyone (${routable.length})`);
    expect(everyone.getAttribute('aria-pressed')).toBe('true');
    expect(buttonNamed(view.node, `Assistants and search (${assistantNames(routable).length})`).getAttribute('aria-pressed')).toBe('false');
    expect(view.node.querySelectorAll('.bot-row')).toHaveLength(bots.length + 1);
  });

  it('names every checkbox after its bot', () => {
    const { ctx } = makeCtx(makeState());
    const view = createBotsView(ctx);
    view.update();
    expect(view.node.querySelector('input[aria-label="ClaudeBot: markdown"]')).not.toBeNull();
    expect(view.node.querySelector('input[aria-label="ClaudeBot: block"]')).not.toBeNull();
    const robotsOnly = bots.find((bot) => bot.uaPatterns.length === 0);
    const box = /** @type {HTMLInputElement} */ (view.node.querySelector(`input[aria-label="${robotsOnly?.name}: markdown, n/a"]`));
    expect(box.disabled).toBe(true);
  });

  it('enables Save on an edit and keeps the box that was clicked', () => {
    const { ctx } = makeCtx(makeState());
    const view = createBotsView(ctx);
    view.update();
    const save = buttonNamed(view.node, 'Save');
    expect(save.disabled).toBe(true);
    // jsdom fires a checkbox's change event only when it is in the document.
    win.document.body.append(view.node);
    const box = /** @type {HTMLInputElement} */ (view.node.querySelector('input[aria-label="GPTBot: block"]'));
    box.click();
    expect(save.disabled).toBe(false);
    expect(view.node.querySelector('input[aria-label="GPTBot: block"]')).toBe(box);
    expect(view.node.textContent).toContain('These bots are set to receive markdown and to be blocked');
    expect(view.node.textContent).toContain('Blocking only takes effect after the next generate');
  });

  it('follows the server while untouched, and keeps an edit when the server moves', () => {
    const harness = makeCtx(makeState());
    const view = createBotsView(harness.ctx);
    view.update();
    const sub = /** @type {HTMLElement} */ (view.node.querySelector('.card-head .sub'));
    const before = view.node.querySelector('input[aria-label="ClaudeBot: markdown"]');

    harness.setState(makeState({ config: { bots: { markdownRouting: ['ClaudeBot'], blocked: [], custom: [] } } }));
    view.update();
    expect(sub.textContent).toMatch(/^1 receive markdown, 0 blocked\./);
    expect(view.node.querySelector('input[aria-label="ClaudeBot: markdown"]')).toBe(before);
    expect(buttonNamed(view.node, 'Nobody').getAttribute('aria-pressed')).toBe('false');

    buttonNamed(view.node, 'Nobody').click();
    harness.setState(makeState());
    view.update();
    expect(sub.textContent).toMatch(/^0 receive markdown/);
  });

  it('draws a crawler the server list gained', () => {
    const harness = makeCtx(makeState());
    const view = createBotsView(harness.ctx);
    view.update();
    harness.setBots([...bots, { name: 'ZetaBot', vendor: 'Zeta', uaPatterns: ['zeta'], robotsToken: 'ZetaBot', kind: 'search' }]);
    view.update();
    expect(view.node.querySelector('input[aria-label="ZetaBot: markdown"]')).not.toBeNull();
  });

  it('adds a crawler without claiming it is saved, and refuses a robots.txt-only name', () => {
    const { ctx } = makeCtx(makeState());
    const view = createBotsView(ctx);
    view.update();
    buttonNamed(view.node, '+ Add a crawler OpenGEO has never heard of').click();
    const name = control(view.node, 'Name');
    const robotsOnly = /** @type {AiBot} */ (bots.find((bot) => bot.uaPatterns.length === 0));

    name.value = robotsOnly.name.toUpperCase();
    buttonNamed(view.node, 'Add crawler').click();
    expect(view.node.querySelector('.form-error')?.textContent).toBe(`${robotsOnly.name.toUpperCase()} is already on the list.`);

    expect(view.node.textContent).not.toContain('Saved into opengeo.config.json');
    name.value = 'AcmeBot';
    fire(name, 'input');
    expect(view.node.textContent).toContain('Optional. Defaults to "acmebot".');
    buttonNamed(view.node, 'Add crawler').click();
    const box = /** @type {HTMLInputElement} */ (view.node.querySelector('input[aria-label="AcmeBot: markdown"]'));
    expect(box.checked).toBe(true);
    expect(view.node.textContent).toContain('Matches any User-Agent containing acmebot.');
    expect(buttonNamed(view.node, 'Save').disabled).toBe(false);
  });

  it('treats a crawler re-added with other patterns as a change', () => {
    const saved = [{ name: 'AcmeBot', uaPatterns: ['acme'] }];
    const { ctx } = makeCtx(makeState({ config: { bots: { markdownRouting: [], blocked: [], custom: saved } } }));
    const view = createBotsView(ctx);
    view.update();
    /** @type {HTMLButtonElement} */ (view.node.querySelector('button[aria-label="Remove AcmeBot"]')).click();
    expect(view.node.querySelector('input[aria-label="AcmeBot: markdown"]')).toBeNull();
    buttonNamed(view.node, '+ Add a crawler OpenGEO has never heard of').click();
    control(view.node, 'Name').value = 'AcmeBot';
    control(view.node, 'User-Agent contains').value = 'acme-crawler';
    buttonNamed(view.node, 'Add crawler').click();
    // Routing gained AcmeBot too, so undo that to isolate the custom-list comparison.
    win.document.body.append(view.node);
    const routed = /** @type {HTMLInputElement} */ (view.node.querySelector('input[aria-label="AcmeBot: markdown"]'));
    routed.click();
    expect(routed.checked).toBe(false);
    expect(buttonNamed(view.node, 'Save').disabled).toBe(false);
  });

  it('saves the three lists and reloads', async () => {
    const fetch = stubFetch({ config: {}, configPath: '/p/opengeo.config.json' });
    const { ctx, reload } = makeCtx(makeState());
    const view = createBotsView(ctx);
    view.update();
    buttonNamed(view.node, 'Nobody').click();
    buttonNamed(view.node, 'Save').click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    const [path, init] = fetch.mock.calls[0];
    expect(path).toBe('/api/config');
    expect(JSON.parse(String(init.body))).toEqual({ bots: { markdownRouting: [], blocked: [], custom: [] } });
  });
});

// -- Settings ------------------------------------------------------------------------------------

describe('the Settings view', () => {
  it('starts with the page heading and three cards', () => {
    const { ctx } = makeCtx(makeState());
    const view = createSettingsView(ctx);
    expect(view.node.firstElementChild?.querySelector('h1')?.textContent).toBe('Settings');
    expect([...view.node.querySelectorAll('h2')].map((node) => node.textContent)).toEqual(['Project', 'AI provider', 'Where your key lives, and where it goes', 'About']);
  });

  it('names the custom endpoint option as the dropdown does', () => {
    const { ctx } = makeCtx(makeState());
    const view = createSettingsView(ctx);
    expect(view.node.querySelector('.note strong')?.textContent).toBe('Something else (your own endpoint)');
    const options = [...view.node.querySelectorAll('option')].map((node) => node.textContent);
    expect(options).toContain('Something else (your own endpoint)');
  });

  it('keeps the keys link out of the label and ties the hint by aria-describedby', () => {
    const { ctx } = makeCtx(makeState({ key: { present: false } }));
    const view = createSettingsView(ctx);
    const key = control(view.node, 'API key');
    const link = view.node.querySelector('a[href="https://console.anthropic.com/settings/keys"]');
    expect(link?.closest('label')).toBeNull();
    expect(link?.getAttribute('rel')).toContain('noreferrer');
    expect(link?.closest(`#${key.getAttribute('aria-describedby')}`)).not.toBeNull();
  });

  it('promises a kept key only when Save keeps it', () => {
    const { ctx } = makeCtx(makeState());
    const view = createSettingsView(ctx);
    const key = control(view.node, 'Replace the key');
    const save = buttonNamed(/** @type {HTMLElement} */ (key.closest('.card')), 'Save');
    expect(key.placeholder).toBe('leave blank to keep the current key');
    expect(save.disabled).toBe(false);

    const provider = /** @type {HTMLSelectElement} */ (/** @type {unknown} */ (control(view.node, 'Provider')));
    provider.value = 'groq';
    fire(provider, 'change');
    expect(key.placeholder).toBe('sk-...');
    expect(save.disabled).toBe(true);
  });

  it('refuses a blank key with nothing saved', () => {
    const { ctx } = makeCtx(makeState({ key: { present: false, provider: undefined, model: undefined } }));
    const view = createSettingsView(ctx);
    const key = control(view.node, 'API key');
    expect(key.placeholder).toBe('sk-...');
    expect(buttonNamed(/** @type {HTMLElement} */ (key.closest('.card')), 'Save').disabled).toBe(true);
  });

  it('sends a blank key as an empty string, then reloads', async () => {
    const fetch = stubFetch({ provider: 'anthropic', model: 'claude-x', keyless: false, envPath: '/p/.env', gitignorePath: '/p/.gitignore', gitignoreAdded: false });
    const { ctx, reload } = makeCtx(makeState());
    const view = createSettingsView(ctx);
    const model = control(view.node, 'Model');
    model.value = 'claude-x';
    fire(model, 'input');
    buttonNamed(/** @type {HTMLElement} */ (model.closest('.card')), 'Save').click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    const [path, init] = fetch.mock.calls[0];
    expect(path).toBe('/api/key');
    expect(JSON.parse(String(init.body))).toMatchObject({ provider: 'anthropic', apiKey: '', model: 'claude-x' });
    expect(view.node.textContent).toContain('.env was already ignored by /p/.gitignore.');
  });

  it('refuses a max pages of 0 without sending anything', () => {
    const fetch = stubFetch({});
    const { ctx } = makeCtx(makeState());
    const view = createSettingsView(ctx);
    const pages = control(view.node, 'Max pages');
    pages.value = '0';
    buttonNamed(/** @type {HTMLElement} */ (pages.closest('.card')), 'Save').click();
    expect(fetch).not.toHaveBeenCalled();
    expect(pages.getAttribute('aria-invalid')).toBe('true');
    expect(view.node.textContent).toContain('Max pages must be a whole number, 1 or more.');
  });

  it('re-syncs untouched fields from state and leaves edited ones alone', () => {
    const harness = makeCtx(makeState());
    const view = createSettingsView(harness.ctx);
    const site = control(view.node, 'Site URL');
    const publicDir = control(view.node, 'Web root');
    const model = control(view.node, 'Model');
    publicDir.value = 'out';
    fire(publicDir, 'input');

    harness.setState(makeState({ config: { site: 'http://localhost:4000', publicDir: 'static', ai: { provider: 'anthropic', model: 'claude-y' } }, key: { model: 'claude-y' } }));
    view.update();
    expect(control(view.node, 'Site URL')).toBe(site);
    expect(site.value).toBe('http://localhost:4000');
    expect(publicDir.value).toBe('out');
    expect(model.value).toBe('claude-y');

    model.value = 'mine';
    fire(model, 'input');
    harness.setState(makeState({ key: { model: 'claude-z' } }));
    view.update();
    expect(model.value).toBe('mine');
  });

  it('fills the About card from state', () => {
    const { ctx } = makeCtx(makeState({ configExists: false }));
    const view = createSettingsView(ctx);
    expect(view.node.textContent).toContain('opengeo 1.0.0');
    expect(view.node.textContent).toContain('/p/opengeo.config.json (defaults, not written yet)');
  });
});
