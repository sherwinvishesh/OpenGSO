import { api, ApiError } from '../api.js';
import {
  KIND_NOTE,
  agentNames,
  assistantNames,
  createAddCrawler,
  routableOnly,
  routingForMode,
  routingModeOf,
  sameCustom,
  sameNames,
  searchCrawlerNames,
  searchCrawlerWarning,
  shownBots,
  toggled,
} from '../components/bot-picker.js';
import { banner, button, card, cardHead, el, fill, pageHead, pill, setBusy, setLabel, setText } from '../ui.js';

/**
 * @import { AiBot, CustomBotInput } from '../../../core/src/shared/api-types.js'
 * @import { Ctx, View } from '../context.js'
 * @import { RoutingMode } from '../components/bot-picker.js'
 */

/**
 * Bot settings: the two levers from §7, on one page but never in one list.
 *
 * The UI enforces the distinction the design depends on. Routing is a format decision and cannot
 * deny anybody anything, so its column has no warning attached. Blocking is a real denial, is
 * opt-in, and only takes effect the next time generate writes robots.txt, so it says so on screen
 * rather than in the docs.
 *
 * The table is the by-hand answer, so the presets sit above it rather than replacing it: most
 * people want one of the three canned lists and should not have to click twenty-six checkboxes to
 * express it. Underneath, a project can add a crawler OpenGEO has never heard of, which is the one
 * thing a shipped list can never cover on its own.
 */

/**
 * @typedef {object} BotLists
 * @property {string[]} routing
 * @property {string[]} blocked
 * @property {CustomBotInput[]} custom
 */

/**
 * @param {Ctx} ctx
 * @returns {View}
 */
export function createBotsView(ctx) {
  /** @returns {BotLists} */
  const fromServer = () => {
    const bots = ctx.state().config.bots;
    return { routing: [...bots.markdownRouting], blocked: [...bots.blocked], custom: [...bots.custom] };
  };

  /** The lists being edited. */
  let local = fromServer();
  /** The server lists `local` was last loaded from, so `update` can tell an edit from a stale copy. */
  let synced = fromServer();
  let busy = false;
  let saved = false;
  /** @type {string | undefined} */
  let error;
  /** @type {AiBot[]} */
  let shown = [];

  // -- static structure --------------------------------------------------------------------------

  const errorSlot = el('div', { className: 'contents' });
  const conflictSlot = el('div', { className: 'contents' });
  const searchSlot = el('div', { className: 'contents' });
  const blockedSlot = el('div', { className: 'contents' });
  /** @type {Record<'error' | 'conflict' | 'search' | 'blocked', string>} */
  const slotShown = { error: '', conflict: '', search: '', blocked: '' };

  const savedNote = el('span', { className: 'muted', text: 'Saved', hidden: true });
  const saveButton = button({ label: 'Save', primary: true, disabled: true, onClick: () => void save() });
  const head = cardHead({ title: 'AI bots', sub: ' ', right: el('div', { className: 'row' }, savedNote, saveButton) });
  const sub = /** @type {HTMLElement} */ (head.querySelector('.sub'));

  const presets = createRoutingPresets((mode) => {
    edit({ ...local, routing: routingForMode(mode, routableOnly(shown), local.routing) });
  });
  const presetsPad = el('div', { className: 'card-pad' }, presets.node);
  presetsPad.style.setProperty('border-bottom', '1px solid var(--border)');

  const rows = el('div', { className: 'contents' });
  /** @type {Map<string, { markdown: HTMLInputElement; block: HTMLInputElement }>} */
  let boxes = new Map();
  let rowsDrawn = '';

  const adder = createAddCrawler({
    existing: () => shown.map((bot) => bot.name),
    onAdd: (bot) => edit({ ...local, custom: [...local.custom, bot], routing: [...local.routing, bot.name] }),
  });

  const node = el(
    'div',
    { className: 'contents' },
    pageHead(
      'Bot settings',
      'Two independent levers. The first decides who gets markdown instead of HTML. The second is a block list, and it is the only one of the two that denies anybody anything.',
    ),
    errorSlot,
    conflictSlot,
    searchSlot,
    blockedSlot,
    card(
      '',
      head,
      presetsPad,
      el('div', { className: 'bot-row' }, el('div', { className: 'group-title', text: 'Bot' }), el('div', { className: 'group-title', text: 'Markdown' }), el('div', { className: 'group-title', text: 'Blocked' })),
      rows,
      el('div', { className: 'card-pad' }, adder.node),
    ),
    card(
      'card-pad',
      el('p', {
        className: 'muted',
        style: { margin: '0' },
        text: 'A bot with no User-Agent pattern cannot be routed, because there is no crawler to recognise at request time. It can still be named in robots.txt, which is how vendors like Google expose an AI-training opt-out separate from their search crawler.',
      }),
      el(
        'p',
        { className: 'muted', style: { margin: '10px 0 0' } },
        'A crawler you add is stored in ',
        el('span', { className: 'mono', text: 'bots.custom' }),
        ' in ',
        el('span', { className: 'mono', text: 'opengeo.config.json' }),
        ' and behaves exactly like a built-in one: both levers apply to it. A development server picks up a saved change on its next request; a production build reads the list when it starts, so restart it.',
      ),
    ),
  );

  // -- behaviour ---------------------------------------------------------------------------------

  /** @param {BotLists} next */
  function edit(next) {
    local = next;
    saved = false;
    draw();
  }

  /** @param {string} name */
  function removeCrawler(name) {
    edit({
      custom: local.custom.filter((bot) => bot.name !== name),
      routing: local.routing.filter((entry) => entry !== name),
      blocked: local.blocked.filter((entry) => entry !== name),
    });
  }

  /**
   * @param {BotLists} a
   * @param {BotLists} b
   */
  function same(a, b) {
    return sameNames(a.routing, b.routing) && sameNames(a.blocked, b.blocked) && sameCustom(a.custom, b.custom);
  }

  async function save() {
    busy = true;
    error = undefined;
    draw();
    const sent = local;
    let ok = false;
    try {
      await api.saveConfig({ bots: { markdownRouting: sent.routing, blocked: sent.blocked, custom: sent.custom } });
      ok = true;
      saved = true;
      // What was sent is now what the server has, so the reload below adopts the server's copy.
      synced = sent;
    } catch (thrown) {
      error = thrown instanceof ApiError ? thrown.message : String(thrown);
    }
    busy = false;
    if (ok) await ctx.reload();
    else draw();
  }

  function draw() {
    const server = fromServer();
    const dirty = !same(local, server);
    shown = shownBots(ctx.bots(), local.custom);
    const routable = routableOnly(shown);

    swap(
      errorSlot,
      'error',
      error ?? '',
      () => banner({ tone: 'fail', title: 'Could not save' }, error),
    );
    const conflicts = local.routing.filter((name) => local.blocked.includes(name));
    swap(conflictSlot, 'conflict', conflicts.join(', '), () =>
      banner(
        { tone: 'warn', title: 'These bots are set to receive markdown and to be blocked' },
        `${conflicts.join(', ')}. A blocked bot that obeys robots.txt will never arrive to be routed, so one of the two settings is doing nothing. Decide which one you meant.`,
      ),
    );
    const search = searchCrawlerNames(local.routing, shown);
    swap(searchSlot, 'search', search.join(', '), () =>
      banner({ tone: 'warn', title: 'Search engines are set to receive markdown' }, searchCrawlerWarning(search)),
    );
    swap(blockedSlot, 'blocked', local.blocked.length > 0 ? 'on' : '', () =>
      banner(
        { tone: 'info', title: 'Blocking only takes effect after the next generate' },
        'Prod contains no blocking code. The block list is expressed entirely through the robots.txt that generate writes, so run Generate for a change here to reach your site. Note also that robots.txt is a request, not a fence: it stops well-behaved crawlers and nothing else.',
      ),
    );

    setText(sub, `${local.routing.length} receive markdown, ${local.blocked.length} blocked. Unlisted and unknown bots always see the ordinary site.`);
    savedNote.hidden = !(saved && !dirty);
    setBusy(saveButton, busy, !dirty);
    presets.update(routingModeOf(local.routing, routable), routable);
    drawRows();
  }

  /**
   * A banner slot, redrawn only when what it says changes, so it does not replay its entrance on
   * every tick of a checkbox.
   *
   * @param {HTMLElement} slot
   * @param {keyof typeof slotShown} id
   * @param {string} key Empty means no banner.
   * @param {() => HTMLElement} make
   */
  function swap(slot, id, key, make) {
    if (slotShown[id] === key) return;
    slotShown[id] = key;
    fill(slot, key ? make() : null);
  }

  function drawRows() {
    // Rebuilt only when the crawlers change, so ticking a box keeps focus on it.
    const signature = JSON.stringify(shown);
    if (signature !== rowsDrawn) {
      boxes = new Map();
      fill(rows, shown.map(botRow));
      rowsDrawn = signature;
    }
    for (const [name, box] of boxes) {
      box.markdown.checked = local.routing.includes(name);
      box.block.checked = local.blocked.includes(name);
    }
  }

  /** @param {AiBot} bot */
  function botRow(bot) {
    const robotsOnly = bot.uaPatterns.length === 0;
    // The visible text is one word, so the name says which bot it belongs to. Without it a screen
    // reader hears twenty-eight checkboxes called "markdown".
    const markdown = el('input', {
      attrs: { type: 'checkbox', 'aria-label': robotsOnly ? `${bot.name}: markdown, n/a` : `${bot.name}: markdown` },
      on: { change: () => edit({ ...local, routing: toggled(local.routing, bot.name) }) },
    });
    markdown.disabled = robotsOnly;
    const block = el('input', {
      attrs: { type: 'checkbox', 'aria-label': `${bot.name}: block` },
      on: { change: () => edit({ ...local, blocked: toggled(local.blocked, bot.name) }) },
    });
    boxes.set(bot.name, { markdown, block });

    return el(
      'div',
      { className: 'bot-row' },
      el(
        'div',
        {},
        el(
          'div',
          { className: 'bot-name' },
          bot.name,
          ' ',
          pill('mute', bot.kind),
          ' ',
          bot.custom ? pill('ok', 'yours') : null,
          ' ',
          robotsOnly ? pill('mute', 'robots.txt only') : null,
        ),
        el(
          'div',
          { className: 'bot-meta' },
          `${bot.vendor}. ${bot.notes ?? KIND_NOTE[bot.kind]}`,
          bot.custom
            ? [
                ` Matches any User-Agent containing ${bot.uaPatterns.join(' or ')}. `,
                el('button', {
                  className: 'link-btn',
                  attrs: { type: 'button', 'aria-label': `Remove ${bot.name}` },
                  text: 'remove',
                  on: { click: () => removeCrawler(bot.name) },
                }),
              ]
            : null,
        ),
      ),
      el('label', { className: 'toggle' }, markdown, robotsOnly ? 'n/a' : 'markdown'),
      el('label', { className: 'toggle' }, block, 'block'),
    );
  }

  draw();
  return {
    node,
    update() {
      // An untouched form follows the server, so a change made by `opengeo settings` or another tab
      // shows up. An edited one is left alone until it is saved.
      const server = fromServer();
      if (same(local, synced)) local = server;
      synced = server;
      draw();
    },
  };
}

/**
 * The three canned answers. The by-hand one is the table underneath, so it is a note here rather
 * than a button: there is nothing extra to reveal.
 *
 * @param {(mode: RoutingMode) => void} onPick
 */
function createRoutingPresets(onPick) {
  const title = el('span', { className: 'group-title', style: { margin: '0' }, text: 'Markdown routing', attrs: { id: 'bots-routing-title' } });
  const all = button({ label: 'Every AI agent', small: true, onClick: () => onPick('all') });
  const assistants = button({ label: 'Assistants only', small: true, onClick: () => onPick('assistants') });
  const none = button({ label: 'Nobody', small: true, onClick: () => onPick('none') });
  const note = el('span', { className: 'note note-sm' });

  return {
    node: el('div', { className: 'row', attrs: { role: 'group', 'aria-labelledby': 'bots-routing-title' } }, title, all, assistants, none, el('div', { className: 'grow' }), note),
    /**
     * @param {RoutingMode} mode
     * @param {AiBot[]} routable
     */
    update(mode, routable) {
      setLabel(all, `Every AI agent (${agentNames(routable).length})`);
      setLabel(assistants, `Assistants only (${assistantNames(routable).length})`);
      // Said on the page, because the omission from "every" is deliberate and looks like a bug.
      all.title = 'Every crawler except search engines such as Bingbot: a markdown response is marked noindex, which would drop the page from their results.';
      all.setAttribute('aria-pressed', String(mode === 'all'));
      assistants.setAttribute('aria-pressed', String(mode === 'assistants'));
      none.setAttribute('aria-pressed', String(mode === 'none'));
      setText(note, mode === 'custom' ? 'A list you picked by hand.' : 'Or tick them one by one below.');
    },
  };
}
