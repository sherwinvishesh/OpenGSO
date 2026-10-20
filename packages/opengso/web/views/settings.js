import { api, ApiError } from '../api.js';
import { createProviderFields, customEndpointLabel, draftForProvider, draftReady, keyKept, providerInfoOf } from '../components/provider-fields.js';
import { banner, button, card, cardHead, el, field, fill, pageHead, pill, setAttr, setBusy, setText } from '../ui.js';

/**
 * @import { KeyResponse, OpenGsoConfig, StateResponse } from '../../../core/src/shared/api-types.js'
 * @import { Ctx, View } from '../context.js'
 * @import { ProviderDraft } from '../components/provider-fields.js'
 */

/**
 * Settings: the config file and the API key, edited in place.
 *
 * The key section is written to be auditable rather than reassuring. It names the exact file the
 * key is written to, says which file the running process actually read it from, and states the one
 * network call it is ever used for. §11 is a promise about behaviour, and the only honest
 * way to present a promise like that is to show the reader where to go and check.
 */

/**
 * @param {Ctx} ctx
 * @returns {View}
 */
export function createSettingsView(ctx) {
  const project = createProjectCard(ctx);
  const key = createKeyCard(ctx);
  const about = createAboutCard(ctx);
  /** @type {View} */
  const view = {
    node: el(
      'div',
      { className: 'contents' },
      pageHead(
        'Settings',
        'The same questions ',
        el('span', { className: 'mono', text: 'opengso start' }),
        ' asked, changeable at any time. Everything here is stored in your project, in files you can read, and nothing is sent anywhere. The crawler lists live one tab up, under Bot settings.',
      ),
      project.node,
      key.node,
      about.node,
    ),
    update() {
      project.update();
      key.update();
      about.update();
    },
  };
  view.update();
  return view;
}

// -- helpers -------------------------------------------------------------------------------------

/**
 * A whole number at or above `min`, or nothing. `parseInt` would read "1.5" as 1 and "3abc" as 3,
 * and a crawl ceiling of 0 pages is not a setting anybody means.
 *
 * @param {string} raw
 * @param {number} min
 * @returns {number | undefined}
 */
export function wholeNumber(raw, min) {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= min ? value : undefined;
}

/**
 * A control that follows server state until somebody edits it. `sync` writes the new server value
 * only when the control still shows the last one it was given; `adopt` marks what is in it now as
 * saved, so the next `sync` replaces it with the server's normalised copy.
 *
 * @param {HTMLInputElement | HTMLSelectElement} control
 */
function follows(control) {
  let last = control.value;
  return {
    /** @param {string} value */
    sync(value) {
      if (control.value === last && control.value !== value) control.value = value;
      last = value;
    },
    adopt() {
      last = control.value;
    },
  };
}

/** @param {unknown} thrown */
const messageOf = (thrown) => (thrown instanceof ApiError ? thrown.message : String(thrown));

// -- project -------------------------------------------------------------------------------------

/** @param {Ctx} ctx */
function createProjectCard(ctx) {
  const initial = ctx.state();
  let busy = false;
  let saved = false;

  const site = el('input', { attrs: { type: 'text', spellcheck: 'false' } });
  const publicDir = el('input', { attrs: { type: 'text', spellcheck: 'false', placeholder: 'public' } });
  const maxPages = el('input', { attrs: { type: 'number', min: 1, step: 1 } });
  const maxDepth = el('input', { attrs: { type: 'number', min: 0, step: 1 } });
  const minWords = el('input', { attrs: { type: 'number', min: 0, step: 1 } });
  const tier = el('select', {}, el('option', { attrs: { value: 'free' }, text: 'free' }), el('option', { attrs: { value: 'ai' }, text: 'ai' }));

  const controls = { site, publicDir, maxPages, maxDepth, minWords, tier };
  /** @type {Record<keyof typeof controls, string>} */
  const values = {
    site: initial.config.site,
    publicDir: initial.config.publicDir,
    maxPages: String(initial.config.crawl.maxPages),
    maxDepth: String(initial.config.crawl.maxDepth),
    minWords: String(initial.config.generate.minWords),
    tier: initial.config.generate.tier,
  };
  for (const [name, control] of Object.entries(controls)) control.value = values[/** @type {keyof typeof controls} */ (name)];
  const followers = Object.fromEntries(Object.entries(controls).map(([name, control]) => [name, follows(control)]));
  for (const control of Object.values(controls)) {
    control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'input', () => {
      saved = false;
      draw();
    });
  }

  const savedNote = el('span', { className: 'muted', text: 'Saved', hidden: true });
  const saveButton = button({ label: 'Save', primary: true, onClick: () => void save() });
  const head = cardHead({ title: 'Project', sub: initial.configPath, right: el('div', { className: 'row' }, savedNote, saveButton) });
  const sub = /** @type {HTMLElement} */ (head.querySelector('.sub'));
  const publicPath = el('span', { className: 'mono' });
  const internalPath = el('span', { className: 'mono' });
  const errorSlot = el('div', { className: 'contents' });

  const node = card(
    '',
    head,
    el(
      'div',
      { className: 'card-pad stack' },
      field('Site URL', site, 'The default target for test, generate and prod.'),
      field('Web root', publicDir, 'Where generated files land, relative to the project root. Default: public'),
      el(
        'div',
        { className: 'row' },
        el('div', { className: 'grow' }, field('Max pages', maxPages, 'A ceiling on the crawl, not a target.')),
        el('div', { className: 'grow' }, field('Max depth', maxDepth, 'Link hops from the starting URL.')),
        el('div', { className: 'grow' }, field('Low-content warning below', minWords, 'Words. Usually means a client-rendered page.')),
      ),
      field(
        'Default generate tier',
        tier,
        'free is algorithmic and needs no key. ai is BYOK and falls back to free whenever a fact would be lost.',
      ),
      el(
        'div',
        { className: 'note' },
        'Generated files go to ',
        publicPath,
        '. Bookkeeping that must never be web-served goes to ',
        internalPath,
        '.',
      ),
      errorSlot,
    ),
  );

  /** @param {string | undefined} message */
  function showError(message) {
    fill(errorSlot, message ? banner({ tone: 'fail' }, message) : null);
  }

  async function save() {
    const state = ctx.state();
    const pages = wholeNumber(maxPages.value, 1);
    const depth = wholeNumber(maxDepth.value, 0);
    const words = wholeNumber(minWords.value, 0);
    setAttr(maxPages, 'aria-invalid', pages === undefined ? 'true' : undefined);
    setAttr(maxDepth, 'aria-invalid', depth === undefined ? 'true' : undefined);
    setAttr(minWords, 'aria-invalid', words === undefined ? 'true' : undefined);
    // Refused rather than quietly replaced with the old value, which would report "Saved" for a
    // number that was never written.
    const invalid = [
      pages === undefined ? 'Max pages must be a whole number, 1 or more.' : '',
      depth === undefined ? 'Max depth must be a whole number, 0 or more.' : '',
      words === undefined ? 'Low-content warning below must be a whole number, 0 or more.' : '',
    ].filter(Boolean);
    if (pages === undefined || depth === undefined || words === undefined) {
      saved = false;
      showError(invalid.join(' '));
      draw();
      return;
    }

    busy = true;
    showError(undefined);
    draw();
    /** @type {Partial<OpenGsoConfig>} */
    const patch = {
      site: site.value.trim(),
      publicDir: publicDir.value.trim() || state.config.publicDir,
      crawl: { ...state.config.crawl, maxPages: pages, maxDepth: depth },
      generate: { tier: tier.value === 'ai' ? 'ai' : 'free', minWords: words },
    };
    let ok = false;
    try {
      await api.saveConfig(patch);
      ok = true;
      saved = true;
      for (const follower of Object.values(followers)) follower.adopt();
    } catch (thrown) {
      showError(messageOf(thrown));
    }
    busy = false;
    if (ok) await ctx.reload();
    else draw();
  }

  function draw() {
    savedNote.hidden = !saved;
    setBusy(saveButton, busy);
  }

  return {
    node,
    update() {
      const state = ctx.state();
      setText(sub, state.configPath);
      setText(publicPath, state.publicDir);
      setText(internalPath, state.internalDir);
      followers.site.sync(state.config.site);
      followers.publicDir.sync(state.config.publicDir);
      followers.maxPages.sync(String(state.config.crawl.maxPages));
      followers.maxDepth.sync(String(state.config.crawl.maxDepth));
      followers.minWords.sync(String(state.config.generate.minWords));
      followers.tier.sync(state.config.generate.tier);
      draw();
    },
  };
}

// -- key -----------------------------------------------------------------------------------------

/**
 * The form as the server last described it.
 *
 * @param {StateResponse} state
 * @returns {ProviderDraft}
 */
function draftFromState(state) {
  return {
    ...draftForProvider(state.providerCatalog, state.key.provider ?? state.config.ai.provider),
    model: state.key.model ?? state.config.ai.model,
    baseUrl: state.config.ai.baseUrl ?? '',
    api: state.config.ai.api ?? 'openai',
  };
}

/** @param {Ctx} ctx */
function createKeyCard(ctx) {
  const initial = ctx.state();
  let busy = false;
  // Set by the first edit and cleared by a save. Until then the form follows the server, so a key
  // added with `opengso settings` while this tab sat open shows up here.
  let edited = false;
  /** @type {KeyResponse | undefined} */
  let done;

  const keyPill = el('span', { className: 'contents' });
  /** @type {'none' | 'keyless' | 'found' | undefined} */
  let pillShown;
  const keyPath = el('span', { className: 'mono' });
  const configName = el('span');
  const envSentence = el('span');

  const fields = createProviderFields({
    catalog: initial.providerCatalog,
    keyLabel: 'API key',
    keyHint: '.env is added to .gitignore before the key is written, every time.',
    onChange: () => {
      edited = true;
      draw();
    },
  });
  fields.set(draftFromState(initial));

  const endpoint = el('strong');
  const saveButton = button({ label: 'Save', primary: true, onClick: () => void save() });
  const ciNote = el('span', { className: 'muted', text: 'CI is set here, so AI features will refuse to run anyway.', hidden: true });
  const errorSlot = el('div', { className: 'contents' });
  const doneSlot = el('div', { className: 'contents' });

  const node = card(
    '',
    cardHead({
      title: 'AI provider',
      sub: 'Optional. Everything except the AI generate tier and the content review works without one.',
      right: keyPill,
    }),
    el(
      'div',
      { className: 'card-pad stack' },
      banner(
        { tone: 'info', title: 'Where your key lives, and where it goes' },
        'It is written to ',
        keyPath,
        ' and nowhere else. It is never written to ',
        configName,
        ', never included in an API response, and the only request it is ever attached to is the direct call to the provider you pick below. OpenGSO has no telemetry, no analytics and no cloud sync, so there is no second place for it to go.',
        envSentence,
      ),
      fields.node,
      el(
        'p',
        { className: 'note' },
        'Not on the list? Pick ',
        endpoint,
        ' and give it a base URL. Anything speaking the OpenAI, Anthropic or Gemini request format works, including a company gateway.',
      ),
      el('div', { className: 'row' }, saveButton, ciNote),
      errorSlot,
      doneSlot,
    ),
  );

  async function save() {
    const state = ctx.state();
    const draft = fields.get();
    const info = providerInfoOf(state.providerCatalog, draft.provider);
    busy = true;
    fill(errorSlot, null);
    draw();
    let ok = false;
    try {
      // A blank key goes as '' on purpose: when a key for this provider is already saved, the
      // server keeps it and updates only the model and endpoint.
      done = await api.saveKey({
        provider: draft.provider,
        apiKey: draft.apiKey.trim(),
        model: draft.model,
        baseUrl: draft.baseUrl || undefined,
        api: info?.userDefined ? draft.api : undefined,
        auth: info?.keyless ? 'none' : undefined,
      });
      ok = true;
      edited = false;
      fields.set({ ...draft, apiKey: '' });
      fill(doneSlot, doneBanner(done));
    } catch (thrown) {
      fill(errorSlot, banner({ tone: 'fail' }, messageOf(thrown)));
    }
    busy = false;
    if (ok) await ctx.reload();
    else draw();
  }

  function draw() {
    const state = ctx.state();
    const draft = fields.get();
    const info = providerInfoOf(state.providerCatalog, draft.provider);
    const kept = keyKept(state.key, draft.provider);
    // The placeholder promises a kept key only when Save really keeps one. With no key saved, or a
    // key that belongs to another provider, a blank field cannot be saved at all.
    fields.setKey({
      // A keyless provider counts as present so the AI features open up, but there is no key to replace.
      label: state.key.present && state.key.source !== 'config' ? 'Replace the key' : 'API key',
      placeholder: kept ? 'leave blank to keep the current key' : 'sk-...',
    });
    setBusy(saveButton, busy, !draftReady(draft, info, { keyPresent: kept }));
  }

  return {
    node,
    update() {
      const state = ctx.state();
      const shown = !state.key.present ? 'none' : state.key.source === 'config' ? 'keyless' : 'found';
      if (pillShown !== shown) {
        fill(keyPill, shown === 'found' ? pill('ok', 'key found') : shown === 'keyless' ? pill('ok', 'no key needed') : pill('mute', 'no key'));
        pillShown = shown;
      }
      setText(keyPath, state.key.path);
      setText(configName, state.configPath.split('/').pop() ?? '');
      setText(
        envSentence,
        state.key.present && state.key.source === 'process-env'
          ? ' The key this process is currently using came from the environment rather than that file.'
          : '',
      );
      setText(endpoint, customEndpointLabel(state.providerCatalog));
      ciNote.hidden = !state.ci;
      if (!edited) fields.set(draftFromState(state));
      draw();
    },
  };
}

/** @param {KeyResponse} result */
function doneBanner(result) {
  return banner(
    { tone: 'ok', title: 'Saved' },
    'Written to ',
    el('span', { className: 'mono', text: result.envPath }),
    '. ',
    result.gitignoreAdded ? `Added .env to ${result.gitignorePath} first.` : `.env was already ignored by ${result.gitignorePath}.`,
  );
}

// -- about ---------------------------------------------------------------------------------------

/** @param {Ctx} ctx */
function createAboutCard(ctx) {
  /** @type {Array<[string, (state: StateResponse) => string]>} */
  const ROWS = [
    ['Project root', (state) => state.root],
    ['Config', (state) => (state.configExists ? state.configPath : `${state.configPath} (defaults, not written yet)`)],
    ['Generated output', (state) => state.publicDir],
    ['Bookkeeping', (state) => state.internalDir],
    ['Key file', (state) => state.key.path],
  ];
  const head = cardHead({ title: 'About', sub: ' ' });
  const sub = /** @type {HTMLElement} */ (head.querySelector('.sub'));
  const values = ROWS.map(() => el('span', { className: 'mono muted' }));
  const node = card(
    '',
    head,
    el(
      'div',
      { className: 'card-pad stack-sm' },
      ROWS.map(([label], index) => {
        const name = el('span', { className: 'group-title', text: label });
        name.style.setProperty('min-width', '140px');
        return el('div', { className: 'row' }, name, values[index]);
      }),
    ),
  );
  return {
    node,
    update() {
      const state = ctx.state();
      setText(sub, `${state.packageName} ${state.version}`);
      ROWS.forEach(([, value], index) => setText(values[index], value(state)));
    },
  };
}
