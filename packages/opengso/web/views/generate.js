import { api, ApiError } from '../api.js';
import { createProgress } from '../components/progress.js';
import { isAbort, startRun } from '../runs.js';
import { banner, button, card, cardHead, doc, el, empty, field, fill, pageHead, pill, projectPath, setBusy, setLabel, setText } from '../ui.js';

/**
 * @import { GeneratePageResult, GenerateResponse, SiteFileResult, StaleKind, StateResponse } from '../../../core/src/shared/api-types.js'
 * @import { Ctx, View } from '../context.js'
 */

/**
 * Generate: crawl the site once and write the markdown twins plus robots.txt, llms.txt and
 * sitemap.xml (§6, one crawl, three outputs). A project whose pages are a folder of HTML files is
 * read from that folder instead, and has no URL to type.
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
 * The twin a page's preview reads. The page result names it, beside the page or under `md/`; a
 * proposed page names the copy OpenGSO left, and what an agent is served is the file beside that.
 *
 * @param {GeneratePageResult} page
 * @returns {string}
 */
export function twinPath(page) {
  return page.file ? page.file.replace(/\.opengso-proposed$/, '') : mdRelPath(page.route);
}

/**
 * @param {GenerateResponse} result
 * @param {'free' | 'ai'} [tier] What the run asked for. An AI run says how many pages the model
 *   actually wrote, since a refused key or a fidelity fallback still leaves every page written.
 * @returns {string}
 */
export function pagesSummary(result, tier = 'free') {
  const count = (/** @type {GeneratePageResult['status']} */ status) => result.pages.filter((page) => page.status === status).length;
  const ai = tier === 'ai' ? `, ${result.pages.filter((page) => page.tier === 'ai').length} AI-enhanced` : '';
  return `${count('written')} written, ${count('cached')} unchanged, ${count('failed')} failed${ai} in ${(result.durationMs / 1000).toFixed(1)}s`;
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
  const lead = doc().createTextNode('');

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
  const urlField = el('div', { className: 'grow' }, field('Site URL', urlInput));
  const folderInput = el('input', { attrs: { type: 'text', readonly: 'readonly', 'aria-label': 'Folder the pages are read from' } });
  const folderField = el('div', { className: 'grow', hidden: true }, field('Folder', folderInput, 'Every HTML file in it, with each twin written beside its page.'));
  const single = el('input', { attrs: { type: 'checkbox' } });
  const singleLabel = el('label', { className: 'checkbox' }, single, 'This page only, do not crawl');
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

  const freshnessSlot = el('div', { className: 'contents' });
  let freshnessShown = '';
  const errorSlot = el('div', { className: 'contents' });
  const resultSlot = el('div', { className: 'contents' });
  const emptyText = el('p');
  const emptyCard = card('card-pad', el('div', { className: 'empty' }, el('strong', { text: 'Nothing generated in this session' }), emptyText));

  const node = el(
    'div',
    {},
    pageHead('Generate', lead, publicDir, '.'),
    freshnessSlot,
    card(
      'card-pad',
      el('div', { className: 'row row-end' }, urlField, folderField, field('Tier', tierSelect), runButton),
      el(
        'div',
        { className: 'row row-spaced' },
        singleLabel,
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

  const fromFiles = () => ctx.state().config.generate.source === 'files';

  /** Everything that depends on the inputs and on `busy`, but not on server state. */
  function sync() {
    const state = ctx.state();
    keyNote.hidden = !(tierSelect.value === 'ai' && !state.key.present);
    setLabel(runButton, busy ? 'Generating' : 'Generate');
    setBusy(runButton, busy, !fromFiles() && !urlInput.value.trim());
    progressWrap.hidden = !busy;
    emptyCard.hidden = Boolean(result) || busy;
  }

  async function run() {
    busy = true;
    fill(errorSlot);
    progress.set(undefined);
    sync();
    const tier = /** @type {'free' | 'ai'} */ (tierSelect.value);
    // A URL would make the server crawl it, so a folder project sends none. Unchanged files cost
    // nothing to read again, which is why there is no single-file box to tick.
    const input = fromFiles() ? { tier, force: force.checked } : { url: urlInput.value, tier, single: single.checked, force: force.checked };
    try {
      result = await startRun('generate', (signal) => api.generate(input, progress.set, signal));
      fill(resultSlot, results(result, ctx.state().root, tier));
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
    const files = fromFiles();
    urlField.hidden = files;
    singleLabel.hidden = files;
    folderField.hidden = !files;
    folderInput.value = projectPath(state.publicDir, state.root);
    setText(
      lead,
      files
        ? 'Read every HTML file in this folder and write a markdown twin beside each one, plus robots.txt, llms.txt and sitemap.xml. Files land in '
        : 'Crawl the site from this URL and write a markdown twin for every page it reaches, plus robots.txt, llms.txt and sitemap.xml. Files land in ',
    );
    setText(publicDir, projectPath(state.publicDir, state.root));
    // Redrawn only when it changes, so a reload does not reset the reader's scroll through it.
    const freshnessKey = JSON.stringify(state.freshness ?? null);
    if (freshnessKey !== freshnessShown) {
      fill(freshnessSlot, freshnessCard(state));
      freshnessShown = freshnessKey;
    }
    ciNote.hidden = !state.ci;
    setText(emptyText, lastRunText(state));
    sync();
  }

  update();
  return { node, update };
}

/** @type {Record<StaleKind, { label: string; tone: 'warn' | 'info' | 'mute' }>} */
const STALE_KINDS = {
  changed: { label: 'changed', tone: 'warn' },
  missing: { label: 'deleted', tone: 'warn' },
  new: { label: 'no twin', tone: 'info' },
  manual: { label: 'hand-written', tone: 'mute' },
};

/**
 * Which pages changed after their twins were written. The server compares the files every time the
 * state is read, so this is as current as the last reload.
 *
 * @param {StateResponse} state
 * @returns {HTMLElement | null}
 */
export function freshnessCard(state) {
  const report = state.freshness;
  if (!report || (report.checked === 0 && report.stale.length === 0)) return null;
  if (report.stale.length === 0) {
    const title = report.checked === 1 ? 'The twin matches its page' : `All ${report.checked} twins match their pages`;
    return banner({ tone: 'ok', title }, 'Compared with the HTML files on disk when this page last loaded. Nothing to regenerate.');
  }
  const count = report.stale.length;
  const fixable = report.stale.some((twin) => twin.kind !== 'manual');
  return card(
    '',
    cardHead({
      title: count === 1 ? '1 page is out of date' : `${count} pages are out of date`,
      sub: fixable ? 'Agents are reading the old version until you press Generate.' : 'Hand-written twins are yours to update; generate leaves them alone.',
    }),
    el(
      'table',
      { className: 'table' },
      el('thead', {}, el('tr', {}, el('th', { text: 'Page' }), el('th', { text: 'What happened' }), el('th', { text: 'Details' }))),
      el(
        'tbody',
        {},
        report.stale.map((twin) =>
          el(
            'tr',
            {},
            el('td', { className: 'mono', text: twin.sourceFile }),
            el('td', {}, pill(STALE_KINDS[twin.kind].tone, STALE_KINDS[twin.kind].label)),
            el('td', { className: 'muted', text: twin.message }),
          ),
        ),
      ),
    ),
  );
}

/**
 * The whole result is redrawn when a new one arrives. It is replaced wholesale, never edited, and
 * that is also what resets the preview to the new run's first page (WEB-4).
 *
 * @param {GenerateResponse} result
 * @param {string} root
 * @param {'free' | 'ai'} tier
 */
function results(result, root, tier) {
  const warnings = result.warnings.length;
  // A provider that refuses on the first page gives every later page the same warning. Saying it
  // once keeps the pages that had something else to say readable.
  /** @type {Set<string>} */
  const seen = new Set();
  return [
    warnings
      ? banner({ tone: 'warn', title: `${warnings} warning${warnings === 1 ? '' : 's'}` }, result.warnings.join(' '))
      : null,
    result.notes?.length ? banner({ tone: 'info' }, result.notes.join(' ')) : null,
    card(
      '',
      cardHead({ title: 'Pages', sub: pagesSummary(result, tier) }),
      el(
        'table',
        { className: 'table' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { text: result.source === 'files' ? 'Page' : 'Route' }),
            el('th', { text: 'Status' }),
            el('th', { className: 'num', text: 'Words' }),
            el('th', { className: 'num', text: 'Tokens' }),
            el('th', { text: 'Notes' }),
          ),
        ),
        el('tbody', {}, result.pages.map((page) => pageRow(page, seen))),
      ),
    ),
    card(
      '',
      cardHead({ title: 'Site files', sub: `Written from the same ${result.source === 'files' ? 'pages' : 'crawl'}, never overwritten without asking.` }),
      el(
        'table',
        { className: 'table' },
        el('thead', {}, el('tr', {}, el('th', { text: 'File' }), el('th', { text: 'Status' }), el('th', { text: 'Path' }))),
        el('tbody', {}, result.files.map((file) => fileRow(file, root))),
      ),
    ),
    preview(result.pages),
  ];
}

/**
 * @param {GeneratePageResult} page
 * @param {Set<string>} seen Warnings an earlier row already showed.
 */
function pageRow(page, seen) {
  const tone = page.status === 'failed' ? 'fail' : page.status === 'written' ? 'ok' : 'mute';
  // A repeat keeps its first sentence, which says what happened to this page; the advice after it
  // is on an earlier row.
  const warnings = page.warnings.map((warning) => {
    if (seen.has(warning)) return firstSentence(warning);
    seen.add(warning);
    return warning;
  });
  const notes = [page.reason, ...warnings].filter(Boolean).join('\n');
  return el(
    'tr',
    {},
    // A page read from a file is named by that file, which is what the person edits.
    el('td', { className: 'mono' }, page.sourceFile ?? page.route, page.sourceFile ? el('div', { className: 'muted', text: page.route }) : null),
    el('td', {}, pill(tone, page.status), page.tier === 'ai' ? [' ', pill('info', 'AI')] : null),
    el('td', { className: 'num', text: page.wordCount ? String(page.wordCount) : '' }),
    el('td', { className: 'num', text: page.tokens ? String(page.tokens) : '' }),
    // The warnings were written for a terminal, so their line breaks are part of the meaning.
    el('td', { className: 'muted' }, el('span', { className: 'pre-wrap', text: notes })),
  );
}

/** @param {string} text */
export function firstSentence(text) {
  return text.split(/(?<=\.)\s/)[0] ?? text;
}

/**
 * @param {SiteFileResult} file
 * @param {string} root
 */
function fileRow(file, root) {
  const tone = file.status === 'failed' ? 'fail' : file.status === 'proposed' ? 'warn' : file.status === 'written' ? 'ok' : 'mute';
  return el(
    'tr',
    {},
    el('td', { className: 'mono', text: file.name }),
    el('td', {}, pill(tone, file.status)),
    el('td', { className: 'mono muted' }, projectPath(file.path, root), file.message ? el('div', { text: file.message }) : null),
  );
}

/**
 * What an agent receives, for one route at a time.
 *
 * Proposed and skipped-manual pages are listed too, and for those this reads the user's own file
 * rather than the `.opengso-proposed` beside it. That is the file an agent is served today.
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
    readable.map((page) => el('option', { attrs: { value: page.route }, text: page.sourceFile ?? page.route })),
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
      const page = readable.find((candidate) => candidate.route === route);
      const file = await api.readFile(page ? twinPath(page) : mdRelPath(route));
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
