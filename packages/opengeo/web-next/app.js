import { api, ApiError } from './api.js';
import { stalenessBanner, stalenessOf } from './components/staleness.js';
import { abortAll } from './runs.js';
import { createGenerateView } from './views/generate.js';
import { createTestView } from './views/test.js';
import { banner, button, card, el, empty, fill, pageHead, setLabel, setText } from './ui.js';

/**
 * @import { AiBot, StateResponse, TestResponse } from '../../core/src/shared/api-types.js'
 * @import { Ctx, Tab, View } from './context.js'
 */

/**
 * The shell: nav, theme, and the one piece of state every screen needs.
 *
 * There is no router and no store. The app has five screens and a single source of server state, so
 * a few variables and a reload function are the whole architecture. Screens are built the first
 * time they are shown and then kept, hidden, so leaving one mid-run does not lose the run.
 */

/** @type {Array<{ id: Tab; label: string }>} */
const TABS = [
  { id: 'test', label: 'Test' },
  { id: 'generate', label: 'Generate' },
  { id: 'prod', label: 'Prod' },
  { id: 'bots', label: 'Bot settings' },
  { id: 'settings', label: 'Settings' },
];

const THEME_KEY = 'opengeo.theme';
const SHORTCUTS_KEY = 'opengeo.shortcuts';

/**
 * @param {string} title
 * @returns {(ctx: Ctx) => View}
 */
const notYet = (title) => () => ({ node: el('div', {}, pageHead(title), empty('Not ported yet')), update() {} });

/** @type {Record<Tab, (ctx: Ctx) => View>} */
const SCREENS = {
  test: createTestView,
  generate: createGenerateView,
  prod: notYet('Prod'),
  bots: notYet('Bot settings'),
  settings: notYet('Settings'),
};

/** @type {(ctx: Ctx, onDone: (firstTest?: TestResponse) => void) => View} */
const createOnboarding = (_ctx, onDone) => ({
  node: el('div', { className: 'onboarding' }, card('card-pad onboarding-card', empty('Not ported yet')), button({ label: 'Skip', onClick: () => onDone() })),
  update() {},
});

// -- state ---------------------------------------------------------------------------------------

/** @type {StateResponse | undefined} */
let state;
// Undefined until the request lands, not `[]`. Onboarding decides which of the routing answers is
// already true by comparing the saved list against the crawler list, and an empty crawler list
// makes "everyone" look like a hand-picked selection.
/** @type {AiBot[] | undefined} */
let bots;
/** @type {string | undefined} */
let error;
let configBroken = false;
/** @type {TestResponse | undefined} */
let lastTest;
let onboarded = false;
/** @type {Tab} */
let tab = 'test';

/** @type {Ctx} */
const ctx = {
  state: () => /** @type {StateResponse} */ (state),
  bots: () => bots ?? [],
  reload,
  go: (next) => show(next, true),
  lastTest: () => lastTest,
  onTestResult: (result) => {
    lastTest = result;
    void reload();
  },
};

/**
 * State and the crawler list together. The list used to be fetched once, so a crawler added or
 * removed on one tab was missing from the others until a full page reload.
 */
async function reload() {
  const [nextState, nextBots] = await Promise.allSettled([api.state(), api.bots()]);
  if (nextState.status === 'fulfilled') {
    state = nextState.value;
    error = undefined;
    configBroken = false;
  } else {
    const thrown = nextState.reason;
    error = thrown instanceof ApiError ? thrown.message : String(thrown);
    configBroken = thrown instanceof ApiError && thrown.extra.configBroken === true;
  }
  // A failed crawler list never blocks the shell: Prod offers the default bot, Bot settings shows
  // the project's own crawlers.
  bots = nextBots.status === 'fulfilled' ? nextBots.value.bots : (bots ?? []);
  render();
}

// -- the gate ------------------------------------------------------------------------------------

const root = /** @type {HTMLElement} */ (document.getElementById('root'));

/** @type {'error' | 'skeleton' | 'onboarding' | 'shell' | undefined} */
let showing;
/** @type {string | undefined} */
let errorShown;
/** @type {View | undefined} */
let onboarding;

function render() {
  if (error && (configBroken || !state)) {
    // Only redrawn when the message changes, so a reload that fails the same way twice leaves focus
    // and selection where they were.
    const key = `${configBroken}:${error}`;
    if (showing !== 'error' || errorShown !== key) fill(root, errorScreen(error, configBroken));
    showing = 'error';
    errorShown = key;
    return;
  }

  if (!state || !bots) {
    if (showing !== 'skeleton') fill(root, skeleton());
    showing = 'skeleton';
    return;
  }

  if (!state.configExists && !onboarded) {
    if (!onboarding) {
      onboarding = createOnboarding(ctx, (firstTest) => {
        onboarded = true;
        onboarding = undefined;
        // Onboarding ran the structural test on its way out, so the Test tab opens on that number
        // rather than on an empty panel inviting the user to run the thing they just watched run.
        if (firstTest) lastTest = firstTest;
        tab = 'test';
        void reload();
      });
    }
    if (showing !== 'onboarding') fill(root, onboarding.node);
    showing = 'onboarding';
    onboarding.update();
    return;
  }

  if (showing !== 'shell') {
    fill(root, shell.node);
    show(tab, false);
  }
  showing = 'shell';
  shell.update();
}

/**
 * The server answered with a broken config, or never answered at all. Two different screens,
 * because saying the server cannot be reached when it can would send somebody to restart a process
 * that is fine.
 *
 * @param {string} message
 * @param {boolean} broken
 */
function errorScreen(message, broken) {
  const body = broken
    ? banner(
        { tone: 'fail', title: 'opengeo.config.json needs fixing' },
        el('span', { className: 'pre-wrap', text: message }),
        ' Reload this page once it is fixed.',
      )
    : banner(
        { tone: 'fail', title: 'Cannot reach the local server' },
        `${message} The dashboard is served by \`opengeo start\`, so if that process has stopped, start it again and reload this page.`,
      );
  return el('div', { className: 'onboarding' }, card('card-pad onboarding-card', body));
}

/**
 * The shell, greyed, for the moment before `/api/state` lands.
 *
 * It is the real layout rather than a centred word, so the sidebar and the first card are already
 * in their final positions and nothing jumps when the data arrives.
 */
function skeleton() {
  return el(
    'div',
    { className: 'shell', attrs: { 'aria-hidden': 'true' } },
    el(
      'aside',
      { className: 'sidebar' },
      el('div', { className: 'brand' }, el('strong', { text: 'OpenGEO' })),
      el('div', { className: 'nav' }, TABS.map(() => el('div', { className: 'skeleton skeleton-nav' }))),
    ),
    el(
      'main',
      { className: 'main' },
      el(
        'div',
        { className: 'main-inner' },
        el('div', { className: 'skeleton skeleton-line', style: { width: '180px' } }),
        el('div', { className: 'skeleton skeleton-card' }),
        el('div', { className: 'skeleton skeleton-card' }),
      ),
    ),
  );
}

// -- the shell -----------------------------------------------------------------------------------

/** @type {Partial<Record<Tab, View>>} */
const views = {};

const shell = createShell();

function createShell() {
  const version = el('span');
  const projectPath = el('div', { className: 'project-path' });
  const keyLine = el('div');
  const themeButton = button({ label: '', small: true, onClick: toggleTheme });

  /** @type {Map<Tab, { button: HTMLButtonElement; right: HTMLElement; dot?: HTMLElement }>} */
  const navItems = new Map();
  const nav = el(
    'nav',
    { className: 'nav' },
    TABS.map((entry, index) => {
      const right = el('span', { className: 'nav-right' }, el('kbd', { attrs: { 'aria-hidden': 'true' }, text: String(index + 1) }));
      const navButton = el('button', { attrs: { type: 'button' }, on: { click: () => show(entry.id, true) } }, el('span', { text: entry.label }), right);
      navItems.set(entry.id, { button: navButton, right });
      return navButton;
    }),
  );

  const shortcuts = el('input', { attrs: { type: 'checkbox' }, on: { change: () => writeStorage(SHORTCUTS_KEY, shortcuts.checked ? 'on' : 'off') } });
  shortcuts.checked = readStorage(SHORTCUTS_KEY) !== 'off';

  const refreshSlot = el('div', { className: 'contents' });
  const stalenessSlot = el('div', { className: 'contents' });
  const viewsSlot = el('div', { className: 'contents' });
  /** @type {string | undefined} */
  let refreshShown;
  /** @type {string | undefined} */
  let stalenessShown;

  const node = el(
    'div',
    { className: 'shell' },
    el(
      'aside',
      { className: 'sidebar' },
      el('div', { className: 'brand' }, el('strong', { text: 'OpenGEO' }), version),
      nav,
      el(
        'div',
        { className: 'sidebar-foot' },
        el('div', {}, el('div', { className: 'group-title', text: 'Project' }), projectPath),
        keyLine,
        themeButton,
        // Single-key shortcuts need an off switch (WCAG 2.1.4): speech input can send a digit
        // nobody meant as a command.
        el('label', { className: 'toggle' }, shortcuts, 'Number keys switch tabs'),
      ),
    ),
    el('main', { className: 'main' }, el('div', { className: 'main-inner' }, refreshSlot, stalenessSlot, viewsSlot)),
  );

  return {
    node,
    viewsSlot,
    shortcutsOn: () => shortcuts.checked,
    navItems,
    update() {
      const current = /** @type {StateResponse} */ (state);
      setText(version, current.version);
      setText(projectPath, current.root);
      setText(
        keyLine,
        current.key.present
          ? `Key found in ${current.key.source === 'env-file' ? '.env' : 'the environment'}.`
          : 'No AI key. The free tier needs none.',
      );
      setLabel(themeButton, document.documentElement.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode');

      for (const [id, item] of navItems) {
        item.button.setAttribute('aria-current', String(id === tab));
        const colour = navDot(id, current);
        if (colour && !item.dot) item.right.append((item.dot = el('span', { className: 'nav-dot' })));
        if (!colour && item.dot) {
          item.dot.remove();
          item.dot = undefined;
        }
        if (colour && item.dot) item.dot.style.background = colour;
      }

      const refreshKey = error ?? '';
      if (refreshKey !== refreshShown) {
        fill(refreshSlot, error ? banner({ tone: 'warn', title: 'The last refresh failed' }, error) : null);
        refreshShown = refreshKey;
      }

      const drift = lastTest?.checks?.find((check) => check.id === 'B14');
      const verdict = stalenessOf(current, drift);
      const verdictKey = verdict ? JSON.stringify(verdict) : '';
      if (verdictKey !== stalenessShown) {
        fill(stalenessSlot, stalenessBanner(verdict, () => show('generate', true)));
        stalenessShown = verdictKey;
      }

      for (const view of Object.values(views)) view?.update();
    },
  };
}

/**
 * A status dot, only where there is a real status to report. Never a decoration.
 *
 * @param {Tab} id
 * @param {StateResponse} current
 * @returns {string | undefined}
 */
function navDot(id, current) {
  // A content-only run has no structural score, so it has nothing to report here. Colouring the
  // dot from the content score would put an opinion where a measurement is expected.
  const value = lastTest?.score?.value;
  if (id === 'test' && value !== undefined) {
    const bands = current.bands.structural;
    return value >= bands.good ? 'var(--ok)' : value >= bands.fair ? 'var(--warn)' : 'var(--danger)';
  }
  if (id === 'generate' && !current.manifest) return 'var(--warn)';
  return undefined;
}

/**
 * @param {Tab} next
 * @param {boolean} moveFocus Focus goes to the new screen's heading, so a keyboard or screen reader
 *   user lands where the content changed instead of staying on a nav button that did not.
 */
function show(next, moveFocus) {
  tab = next;
  let view = views[next];
  if (!view) {
    view = views[next] = SCREENS[next](ctx);
    shell.viewsSlot.append(view.node);
    view.update();
  }
  for (const [id, existing] of Object.entries(views)) {
    if (existing) existing.node.hidden = id !== next;
  }
  for (const [id, item] of shell.navItems) item.button.setAttribute('aria-current', String(id === next));
  if (moveFocus) {
    const heading = view.node.querySelector('h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }
}

// -- keys, theme, storage ------------------------------------------------------------------------

// Five screens, five keys. The dashboard is a tool somebody comes back to a dozen times while
// fixing one page, and reaching for the mouse to change tab every time is the kind of small tax
// that makes a tool feel slow long before anything actually is. Only on the shell: on onboarding
// they used to change a tab nobody could see.
window.addEventListener('keydown', (event) => {
  if (showing !== 'shell' || !shell.shortcutsOn()) return;
  if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
  const index = Number(event.key) - 1;
  const entry = TABS[index];
  if (!Number.isInteger(index) || !entry) return;
  event.preventDefault();
  show(entry.id, true);
});

/**
 * Typing into a field should never be read as a shortcut, whatever the field happens to be.
 *
 * @param {EventTarget | null} target
 */
function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
}

function toggleTheme() {
  // `theme.js` already applied the stored or OS preference before the first paint.
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  writeStorage(THEME_KEY, next);
  shell.update();
}

/** @param {string} key */
function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 * @param {string} value
 */
function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A browser with storage disabled still works, it just forgets on reload.
  }
}

// Closing the tab closes every open stream, which is how the server learns to stop a run nobody is
// watching instead of finishing a paid review for an empty room.
window.addEventListener('pagehide', abortAll);

render();
void reload();
