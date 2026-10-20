import { button, el, field, fill, pill, setAttr, setText } from '../ui.js';

/** @import { AiBot, CustomBotInput } from '../../../core/src/shared/api-types.js' */

/**
 * The crawler-picking half of the dashboard, shared by onboarding and Bot settings.
 *
 * It is the same four answers the terminal offers, for the same reason: three of them cover almost
 * every project, and the fourth exists for the two cases they cannot. A site that wants a specific
 * handful of agents picks them by hand, and a site whose crawler is not in OpenGEO's list at all
 * adds it. A crawler added here is written to `bots.custom` in the config. A development server
 * picks it up on the next request; a production one loads the list at boot, so it needs a restart.
 *
 * The mode is derived from the selection rather than stored. That way a list edited by hand, or by
 * `opengeo settings`, still shows the right button highlighted next time the page loads.
 */

/**
 * `all` is every agent except the search-index crawlers, as in the terminal: a markdown response says
 * noindex, and sent to Bingbot at the page's own URL that takes the page out of Bing.
 *
 * @typedef {'all' | 'assistants' | 'none' | 'custom'} RoutingMode
 */
/** @typedef {AiBot['kind']} BotKind */

/** @type {Record<BotKind, string>} */
export const KIND_NOTE = {
  assistant: 'Fetches a page because a person asked about it, right now.',
  search: 'Indexes pages to answer search queries later.',
  training: 'Collects pages as training data.',
};

// -- pure helpers --------------------------------------------------------------------------------

/**
 * A bot with no User-Agent pattern exists only as a robots.txt token, so there is nothing to route.
 *
 * @param {AiBot[]} bots
 * @returns {AiBot[]}
 */
export function routableOnly(bots) {
  return bots.filter((bot) => bot.uaPatterns.length > 0);
}

/**
 * @param {AiBot[]} routable
 * @returns {string[]}
 */
export function agentNames(routable) {
  return routable.filter((bot) => bot.kind !== 'search').map((bot) => bot.name);
}

/**
 * @param {AiBot[]} routable
 * @returns {string[]}
 */
export function assistantNames(routable) {
  return routable.filter((bot) => bot.kind === 'assistant').map((bot) => bot.name);
}

/**
 * The search-index crawlers on a routing list, the same rule as core's `routedSearchCrawlers`.
 *
 * @param {string[]} routing
 * @param {AiBot[]} bots
 * @returns {string[]}
 */
export function searchCrawlerNames(routing, bots) {
  const search = new Set(bots.filter((bot) => bot.kind === 'search').map((bot) => bot.name));
  return routing.filter((name) => search.has(name));
}

/**
 * The warning both pages show while the list holds a search crawler, worded as the terminal's.
 *
 * @param {string[]} names
 * @returns {string}
 */
export function searchCrawlerWarning(names) {
  const one = names.length === 1;
  const them = one ? 'it' : 'them';
  const they = one ? 'it' : 'they';
  const listed = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${listed} ${one ? 'builds a search index' : 'build search indexes'}. Every markdown response carries X-Robots-Tag: noindex, and at the page's own URL that tells ${them} to drop the page from search results. Untick ${them} unless that is what you want; ${they} can still ask for markdown with an Accept header.`;
}

/**
 * @param {string[]} routing
 * @param {AiBot[]} routable
 * @returns {RoutingMode}
 */
export function routingModeOf(routing, routable) {
  if (routing.length === 0) return 'none';
  if (sameNames(routing, agentNames(routable))) return 'all';
  if (sameNames(routing, assistantNames(routable))) return 'assistants';
  return 'custom';
}

/**
 * What picking a mode does to the list. `custom` keeps whatever is already selected.
 *
 * @param {RoutingMode} mode
 * @param {AiBot[]} routable
 * @param {string[]} current
 * @returns {string[]}
 */
export function routingForMode(mode, routable, current) {
  if (mode === 'all') return agentNames(routable);
  if (mode === 'assistants') return assistantNames(routable);
  if (mode === 'none') return [];
  return current;
}

/**
 * The same names in any order.
 *
 * @param {string[]} a
 * @param {string[]} b
 */
export function sameNames(a, b) {
  return a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
}

/**
 * The same crawlers with the same content, in any order. Comparing names alone would read a crawler
 * removed and re-added with different patterns as unchanged, and its Save would stay disabled.
 *
 * @param {CustomBotInput[]} a
 * @param {CustomBotInput[]} b
 */
export function sameCustom(a, b) {
  /** @param {CustomBotInput} bot */
  const key = (bot) => JSON.stringify([bot.name, bot.vendor ?? null, bot.uaPatterns ?? null, bot.robotsToken ?? null, bot.kind ?? null, bot.notes ?? null]);
  return a.length === b.length && a.map(key).sort().join('\n') === b.map(key).sort().join('\n');
}

/**
 * The list with `name` added, or removed if it was there.
 *
 * @param {string[]} list
 * @param {string} name
 * @returns {string[]}
 */
export function toggled(list, name) {
  return list.includes(name) ? list.filter((entry) => entry !== name) : [...list, name];
}

/**
 * A crawler from the config, shaped like the resolved list so a table can render it. The defaults
 * are the ones the server's `normalizeCustomBot` fills in.
 *
 * @param {CustomBotInput} bot
 * @returns {AiBot}
 */
export function asBot(bot) {
  return {
    name: bot.name,
    vendor: bot.vendor ?? 'Custom',
    uaPatterns: bot.uaPatterns ?? [bot.name.toLowerCase()],
    robotsToken: bot.robotsToken ?? bot.name,
    kind: bot.kind ?? 'assistant',
    notes: bot.notes,
    custom: true,
  };
}

/**
 * The built-in crawlers from `/api/bots`, then the project's own from the list being edited.
 *
 * The custom half comes from the local list rather than from the server's copy, so a crawler added
 * here shows before any save and one removed here disappears at once, instead of lingering until a
 * reload because the server still has it. A custom name that shadows a built-in is dropped, which is
 * what the server does too.
 *
 * @param {AiBot[]} bots
 * @param {CustomBotInput[]} custom
 * @returns {AiBot[]}
 */
export function shownBots(bots, custom) {
  const builtIn = bots.filter((bot) => !bot.custom);
  const seen = new Set(builtIn.map((bot) => bot.name.toLowerCase()));
  /** @type {AiBot[]} */
  const extra = [];
  for (const entry of custom) {
    const lower = entry.name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    extra.push(asBot(entry));
  }
  return [...builtIn, ...extra];
}

// -- the four answers ----------------------------------------------------------------------------

/**
 * Onboarding's four mode cards. `update` sets the counts and which card is pressed; the cards
 * themselves are built once, so focus stays on the one just clicked.
 *
 * @param {{ onPick: (mode: RoutingMode) => void }} props
 * @returns {{ node: HTMLElement; update: (mode: RoutingMode, routable: AiBot[]) => void }}
 */
export function createRoutingModes({ onPick }) {
  /** @type {Array<{ value: RoutingMode; label: string }>} */
  const options = [
    { value: 'all', label: 'Every AI agent' },
    { value: 'assistants', label: 'Assistants only' },
    { value: 'none', label: 'Nobody' },
    { value: 'custom', label: 'Let me pick' },
  ];
  const cards = options.map((option) => {
    const sub = el('span');
    const node = el(
      'button',
      { className: 'mode', attrs: { type: 'button', 'aria-pressed': 'false' }, on: { click: () => onPick(option.value) } },
      el('strong', { text: option.label }),
      sub,
    );
    return { value: option.value, node, sub };
  });

  return {
    node: el('div', { className: 'modes', attrs: { role: 'group', 'aria-label': 'Markdown routing' } }, cards.map((card) => card.node)),
    update(mode, routable) {
      /** @type {Record<RoutingMode, string>} */
      const subs = {
        all: `${agentNames(routable).length} agents, no search engines`,
        assistants: `${assistantNames(routable).length} agents`,
        none: 'Accept header only',
        custom: 'one by one',
      };
      for (const card of cards) {
        setText(card.sub, subs[card.value]);
        card.node.setAttribute('aria-pressed', String(card.value === mode));
      }
    },
  };
}

// -- the by-name checklist -----------------------------------------------------------------------

/**
 * Onboarding's grid of crawlers. The label contains the bot's name, so each checkbox is already
 * named for what it controls.
 *
 * @param {{ onToggle: (name: string) => void; onRemove?: (name: string) => void }} props
 *   `onRemove` is only ever offered for a crawler this project added. The shipped list is not editable.
 * @returns {{ node: HTMLElement; update: (bots: AiBot[], selected: string[]) => void }}
 */
export function createCrawlerChecklist({ onToggle, onRemove }) {
  const node = el('div', { className: 'crawler-grid' });
  /** @type {Map<string, HTMLInputElement>} */
  let boxes = new Map();
  let drawn = '';

  return {
    node,
    update(bots, selected) {
      // Rebuilt only when the crawlers themselves change, so ticking one keeps focus on its box.
      const signature = JSON.stringify(bots.map((bot) => [bot.name, bot.vendor, Boolean(bot.custom)]));
      if (signature !== drawn) {
        boxes = new Map();
        fill(
          node,
          bots.map((bot) => {
            const box = el('input', { attrs: { type: 'checkbox' }, on: { change: () => onToggle(bot.name) } });
            boxes.set(bot.name, box);
            return el(
              'div',
              { className: 'crawler' },
              el(
                'label',
                { className: 'checkbox' },
                box,
                el('span', {}, bot.name, ' ', pill('mute', bot.vendor), bot.custom ? pill('ok', 'yours') : null),
              ),
              onRemove && bot.custom
                ? el('button', {
                    className: 'link-btn',
                    attrs: { type: 'button', 'aria-label': `Remove ${bot.name}` },
                    text: 'remove',
                    on: { click: () => onRemove(bot.name) },
                  })
                : null,
            );
          }),
        );
        drawn = signature;
      }
      for (const [name, box] of boxes) box.checked = selected.includes(name);
    },
  };
}

// -- adding a crawler ----------------------------------------------------------------------------

/**
 * Add a crawler OpenGEO has never heard of.
 *
 * Only the name is asked for. Everything else is guessed from it, because a crawler almost always
 * puts its own name in its User-Agent, and a form that demanded four fields for the common case
 * would be the reason nobody used this.
 *
 * Nothing is written here. The crawler joins the caller's list, and reaches `opengeo.config.json`
 * when the caller saves, which is why the note says "when you save" and not "saved".
 *
 * @param {object} props
 * @param {() => string[]} props.existing Every name already shown, robots.txt-only built-ins
 *   included, so a duplicate is caught here rather than silently dropped by the server.
 * @param {(bot: CustomBotInput) => void} props.onAdd
 * @param {string} [props.note] What happens next, in the caller's own terms.
 * @returns {{ node: HTMLElement; close: () => void }}
 */
export function createAddCrawler({
  existing,
  onAdd,
  note = 'Written to opengeo.config.json when you save. A development server picks it up on its next request, a production build when it restarts.',
}) {
  const opener = el('button', {
    className: 'add-crawler',
    attrs: { type: 'button' },
    text: '+ Add a crawler OpenGEO has never heard of',
    on: { click: open },
  });

  const name = el('input', { attrs: { type: 'text', spellcheck: 'false' }, on: { input: () => setText(patternsHint, patternsHintText()) } });
  const kind = el(
    'select',
    {},
    el('option', { attrs: { value: 'assistant' }, text: 'assistant' }),
    el('option', { attrs: { value: 'search' }, text: 'search' }),
    el('option', { attrs: { value: 'training' }, text: 'training' }),
  );
  const vendor = el('input', { attrs: { type: 'text', placeholder: 'Custom', spellcheck: 'false' } });
  const patterns = el('input', { attrs: { type: 'text', spellcheck: 'false' } });
  const robotsToken = el('input', { attrs: { type: 'text', spellcheck: 'false' } });
  const patternsHint = el('span');
  const error = el('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });

  const form = el(
    'div',
    { className: 'crawler-form', hidden: true },
    el(
      'div',
      { className: 'row' },
      el('div', { className: 'grow' }, field('Name', name, 'What you want to call it. Used in robots.txt and matched in the User-Agent.')),
      field('What it does', kind),
    ),
    el(
      'div',
      { className: 'row' },
      el('div', { className: 'grow' }, field('Who runs it', vendor, 'Optional.')),
      el('div', { className: 'grow' }, field('User-Agent contains', patterns, patternsHint)),
      el('div', { className: 'grow' }, field('robots.txt token', robotsToken, 'Optional. Defaults to the name.')),
    ),
    error,
    el(
      'div',
      { className: 'row' },
      button({ label: 'Add crawler', primary: true, onClick: submit }),
      button({ label: 'Cancel', onClick: close }),
      el('span', { className: 'note', text: note }),
    ),
  );

  function patternsHintText() {
    return `Optional. Defaults to "${name.value.trim().toLowerCase() || 'the name'}".`;
  }

  function reset() {
    name.value = '';
    kind.value = 'assistant';
    vendor.value = '';
    patterns.value = '';
    robotsToken.value = '';
    setText(patternsHint, patternsHintText());
    showError(undefined);
  }

  /** @param {string | undefined} message */
  function showError(message) {
    setText(error, message ?? '');
    error.hidden = !message;
    setAttr(name, 'aria-invalid', message ? 'true' : undefined);
  }

  function open() {
    reset();
    opener.hidden = true;
    form.hidden = false;
    name.focus();
  }

  function close() {
    const hadFocus = form.contains(form.ownerDocument.activeElement);
    form.hidden = true;
    opener.hidden = false;
    reset();
    // Focus would otherwise fall to the page body along with the form it was in.
    if (hadFocus) opener.focus();
  }

  function submit() {
    const trimmed = name.value.trim();
    if (!trimmed) return showError('A crawler needs a name.');
    if (existing().some((entry) => entry.toLowerCase() === trimmed.toLowerCase())) {
      return showError(`${trimmed} is already on the list.`);
    }
    const list = patterns.value
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    onAdd({
      name: trimmed,
      vendor: vendor.value.trim() || 'Custom',
      uaPatterns: list.length > 0 ? list : [trimmed.toLowerCase()],
      robotsToken: robotsToken.value.trim() || trimmed,
      kind: /** @type {BotKind} */ (kind.value),
    });
    close();
  }

  reset();
  return { node: el('div', { className: 'contents' }, opener, form), close };
}
