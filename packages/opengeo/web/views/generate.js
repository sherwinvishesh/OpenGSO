import { api, ApiError } from '../api.js';
import { createProgress } from '../components/progress.js';
import { isAbort, startRun } from '../runs.js';
import { banner, button, card, cardHead, doc, el, empty, field, fill, pageHead, pill, setBusy, setLabel, setText } from '../ui.js';

/**
 * @import { GeneratePageResult, GenerateResponse, SiteFileResult, StateResponse } from '../../../core/src/shared/api-types.js'
 * @import { Ctx, View } from '../context.js'
 */

/**
 * Generate: crawl the site once and write the markdown twins plus robots.txt, llms.txt and
 * sitemap.xml (§6, one crawl, three outputs).
 *
 * The preview matters more than it looks. Everything else in this app describes the generated
 * files; this is the only place that shows the bytes an agent actually receives, read straight back
 * off disk rather than re-rendered from the response.
 */

/**
 * `/` -> `md/index.md`, `/resume` -> `md/resume.md`. Mirrors core's routeToMdRelPath.
 *
 * @param {string} route
 * @returns {string}
 */
export function mdRelPath(route) {
  const normalized = route.length > 1 && route.endsWith('/') ? route.slice(0, -1) : route;
  return `md/${normalized === '/' ? 'index' : normalized.replace(/^\//, '')}.md`;
}

/**
 * @param {GenerateResponse} result
 * @returns {string}
 */
export function pagesSummary(result) {
  const count = (/** @type {GeneratePageResult['status']} */ status) => result.pages.filter((page) => page.status === status).length;
  return `${count('written')} written, ${count('cached')} unchanged, ${count('failed')} failed in ${(result.durationMs / 1000).toFixed(1)}s`;
}

/**
 * @param {StateResponse} state
 * @returns {string}
 */
export function lastRunText(state) {
  if (!state.manifest) return 'No markdown twins exist for this project yet.';
  const pages = state.manifest.pages.length;
  return `The last run wrote ${pages} page${pages === 1 ? '' : 's'}. Run generate again to refresh them.`;
}

/**
 * @param {Ctx} ctx
 * @returns {View}
 */
export function createGenerateView(ctx) {
  /** @type {GenerateResponse | undefined} */
  let result;
  let busy = false;
  // What the inputs were last set to from server state. While the value still matches, the user has
  // not touched it, so a reload may move it; once it differs, it is theirs.
  let syncedUrl = '';

  const publicDir = doc().createTextNode('');

  const urlInput = el('input', {
    attrs: { type: 'text', spellcheck: 'false', 'aria-label': 'Site URL to generate from' },
    on: { input: () => sync() },
  });
  const tierSelect = el(
    'select',
    { on: { change: () => sync() } },
    el('option', { attrs: { value: 'free' }, text: 'free (algorithmic, no key)' }),
    el('option', { attrs: { value: 'ai' }, text: 'ai (BYOK, fidelity-checked)' }),
  );
  let syncedTier = tierSelect.value;
  const single = el('input', { attrs: { type: 'checkbox' } });
  const force = el('input', { attrs: { type: 'checkbox' } });
  const runButton = button({ label: 'Generate', primary: true, onClick: () => void run() });

  const keyNote = el('p', {
    className: 'note note-spaced',
    hidden: true,
    text: 'The AI tier needs a key. Add one in Settings first. The free tier needs nothing and is what produces the fallback whenever the AI output loses a fact.',
  });
  const progress = createProgress('Starting');
  const progressWrap = el('div', { className: 'row-spaced', hidden: true }, progress.node);
  const ciNote = el('p', {
    className: 'note note-spaced',
    hidden: true,
    text: 'CI is set in this environment, so the AI tier will refuse to run. That is deliberate: generation is a local-machine step, never a build step.',
  });

  const errorSlot = el('div', { className: 'contents' });
  const resultSlot = el('div', { className: 'contents' });
  const emptyText = el('p');
  const emptyCard = card('card-pad', el('div', { className: 'empty' }, el('strong', { text: 'Nothing generated in this session' }), emptyText));

  const node = el(
    'div',
    {},
    pageHead(
      'Generate',
      'Crawl the site from this URL and write a markdown twin for every page it reaches, plus robots.txt, llms.txt and sitemap.xml. Files land in ',
      publicDir,
      '.',
    ),
    card(
      'card-pad',
      el('div', { className: 'row row-end' }, el('div', { className: 'grow' }, field('Site URL', urlInput)), field('Tier', tierSelect), runButton),
      el(
        'div',
        { className: 'row row-spaced' },
        el('label', { className: 'checkbox' }, single, 'This page only, do not crawl'),
        el('label', { className: 'checkbox' }, force, 'Rewrite unchanged pages and overwrite existing site files'),
      ),
      keyNote,
      progressWrap,
      ciNote,
    ),
    errorSlot,
    resultSlot,
    emptyCard,
  );

  /** Everything that depends on the inputs and on `busy`, but not on server state. */
  function sync() {
    const state = ctx.state();
    keyNote.hidden = !(tierSelect.value === 'ai' && !state.key.present);
    setLabel(runButton, busy ? 'Generating' : 'Generate');
    setBusy(runButton, busy, !urlInput.value.trim());
    progressWrap.hidden = !busy;
    emptyCard.hidden = Boolean(result) || busy;
  }

  async function run() {
    busy = true;
    fill(errorSlot);
    progress.set(undefined);
    sync();
    const input = {
      url: urlInput.value,
      tier: /** @type {'free' | 'ai'} */ (tierSelect.value),
      single: single.checked,
      force: force.checked,
    };
    try {
      result = await startRun('generate', (signal) => api.generate(input, progress.set, signal));
      fill(resultSlot, results(result));
      busy = false;
      sync();
      await ctx.reload();
    } catch (thrown) {
      // Closing the page aborts the run. Nobody is left to read about it.
      if (isAbort(thrown)) return;
      const message = thrown instanceof ApiError ? thrown.message : String(thrown);
      const needsKey = thrown instanceof ApiError && thrown.extra.needsKey === true;
      fill(
        errorSlot,
        banner({ tone: 'fail', title: 'Generate did not finish' }, message, needsKey ? ' Add a key in Settings, or switch to the free tier.' : ''),
      );
      result = undefined;
      fill(resultSlot);
    } finally {
      busy = false;
      progress.set(undefined);
      sync();
    }
  }

  function update() {
    const state = ctx.state();
    if (urlInput.value === syncedUrl) urlInput.value = syncedUrl = state.config.site;
    if (tierSelect.value === syncedTier) tierSelect.value = syncedTier = state.config.generate.tier;
    setText(publicDir, state.publicDir);
    ciNote.hidden = !state.ci;
    setText(emptyText, lastRunText(state));
    sync();
  }

  update();
  return { node, update };
}

/**
 * The whole result is redrawn when a new one arrives. It is replaced wholesale, never edited, and
 * that is also what resets the preview to the new run's first page (WEB-4).
 *
 * @param {GenerateResponse} result
 */
function results(result) {
  const warnings = result.warnings.length;
  return [
    warnings
      ? banner({ tone: 'warn', title: `${warnings} warning${warnings === 1 ? '' : 's'}` }, result.warnings.join(' '))
      : null,
    card(
      '',
      cardHead({ title: 'Pages', sub: pagesSummary(result) }),
      el(
        'table',
        { className: 'table' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { text: 'Route' }),
            el('th', { text: 'Status' }),
            el('th', { className: 'num', text: 'Words' }),
            el('th', { className: 'num', text: 'Tokens' }),
            el('th', { text: 'Notes' }),
          ),
        ),
        el('tbody', {}, result.pages.map(pageRow)),
      ),
    ),
    card(
      '',
      cardHead({ title: 'Site files', sub: 'Written from the same crawl, never overwritten without asking.' }),
      el(
        'table',
        { className: 'table' },
        el('thead', {}, el('tr', {}, el('th', { text: 'File' }), el('th', { text: 'Status' }), el('th', { text: 'Path' }))),
        el('tbody', {}, result.files.map(fileRow)),
      ),
    ),
    preview(result.pages),
  ];
}

/** @param {GeneratePageResult} page */
function pageRow(page) {
  const tone = page.status === 'failed' ? 'fail' : page.status === 'written' ? 'ok' : 'mute';
  const notes = [page.reason, ...page.warnings].filter(Boolean).join(' ');
  return el(
    'tr',
    {},
    el('td', { className: 'mono', text: page.route }),
    el('td', {}, pill(tone, page.status)),
    el('td', { className: 'num', text: page.wordCount ? String(page.wordCount) : '' }),
    el('td', { className: 'num', text: page.tokens ? String(page.tokens) : '' }),
    el('td', { className: 'muted', text: notes }),
  );
}

/** @param {SiteFileResult} file */
function fileRow(file) {
  const tone = file.status === 'failed' ? 'fail' : file.status === 'proposed' ? 'warn' : file.status === 'written' ? 'ok' : 'mute';
  return el(
    'tr',
    {},
    el('td', { className: 'mono', text: file.name }),
    el('td', {}, pill(tone, file.status)),
    el('td', { className: 'mono muted' }, file.path, file.message ? el('div', { text: file.message }) : null),
  );
}

/**
 * What an agent receives, for one route at a time.
 *
 * Proposed and skipped-manual pages are listed too, and for those this reads the user's own file
 * rather than the `.opengeo-proposed` beside it. That is the file an agent is served today.
 *
 * @param {GeneratePageResult[]} pages
 * @returns {HTMLElement | null}
 */
function preview(pages) {
  const readable = pages.filter((page) => page.status !== 'failed');
  if (!readable.length) return null;

  // Each load gets a number, and only the latest may draw. Picking a second route while the first
  // is still reading would otherwise let the slower reply land under the wrong name in the select.
  let loads = 0;

  const select = el(
    'select',
    { attrs: { 'aria-label': 'Route to preview' }, on: { change: () => void load(select.value) } },
    readable.map((page) => el('option', { attrs: { value: page.route }, text: page.route })),
  );
  select.value = readable[0].route;
  const show = button({ label: 'Show', small: true, onClick: () => void load(select.value) });
  const body = el('div', { className: 'card-pad' });

  const hint = () => el('span', { className: 'muted', text: 'Pick a route and press Show.' });
  fill(body, hint());

  /** @param {string} route */
  async function load(route) {
    const mine = ++loads;
    select.value = route;
    // The old content goes at once: it belongs to a route the select no longer shows.
    fill(body, hint());
    setBusy(show, true);
    try {
      const file = await api.readFile(mdRelPath(route));
      if (mine !== loads) return;
      fill(body, file.content ? el('pre', { className: 'pre', style: { whiteSpace: 'pre-wrap' }, text: file.content }) : hint());
    } catch (thrown) {
      if (mine !== loads) return;
      fill(body, banner({ tone: 'warn' }, thrown instanceof ApiError ? thrown.message : String(thrown)));
    } finally {
      if (mine === loads) setBusy(show, false);
    }
  }

  return card(
    '',
    cardHead({ title: 'What an agent receives', sub: 'Read back off disk, frontmatter and all.', right: el('div', { className: 'row' }, select, show) }),
    body,
  );
}
