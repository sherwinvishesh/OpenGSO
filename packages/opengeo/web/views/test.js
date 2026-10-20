import { api, ApiError } from '../api.js';
import { checkList } from '../components/checks.js';
import { copyPrompt, fixPromptCard } from '../components/fix-prompt.js';
import { createProgress } from '../components/progress.js';
import { scorePanel } from '../components/score.js';
import { isAbort, startRun } from '../runs.js';
import { ago, banner, button, card, cardHead, doc, el, empty, fill, pageHead, pill, setBusy, setLabel, setText } from '../ui.js';

/**
 * @import {
 *   AreaScore, BandThresholds, ContentReview, DocumentReview, HistoryEntry, QualityRecommendation,
 *   StructurePayload, TestMode, TestResponse,
 * } from '../../../core/src/shared/api-types.js'
 * @import { Ctx, View } from '../context.js'
 */

/**
 * Test, in the same three shapes the CLI has (§5).
 *
 * Full runs the structural checks and then reviews the Markdown those checks found. Structure is
 * that first half alone and needs no key. Content is the second half alone, for the loop where you
 * are editing the Markdown and already know the headers are fine.
 *
 * The content review renders in its own cards, well below the score and visually separate from it.
 * That separation is §5's rule and not a layout preference: the 0-100 number is a structural
 * measurement, and folding a model's opinion into it would make the number unreproducible.
 */

/** @type {Array<{ value: TestMode; label: string; note: string }>} */
const MODES = [
  { value: 'full', label: 'Everything', note: 'The checks, then an AI review of every Markdown document they find.' },
  { value: 'structure', label: 'Structure only', note: 'The 0-100 score. No key, no model, no cost.' },
  { value: 'content', label: 'Content only', note: 'Skip the checks and just review the Markdown. Needs an AI provider.' },
];

/** Past runs on screen. The file keeps twenty, and a row of twenty numbers is a table nobody asked for. */
const PAST_RUNS_SHOWN = 8;

/**
 * @param {Ctx} ctx
 * @returns {View}
 */
export function createTestView(ctx) {
  /** @type {TestMode} */
  let mode = 'full';
  /** @type {TestMode} */
  let runningMode = mode;
  let busy = false;
  /** @type {string | undefined} */
  let error;
  // Seeded rather than empty, so the tab opens on the number the user has already watched arrive
  // (onboarding's closing score is one) instead of on "No result yet" inviting them to run the test
  // they just ran.
  /** @type {TestResponse | undefined} */
  let result = ctx.lastTest();
  let seenLast = result;
  /** @type {HistoryEntry[] | undefined} */
  let history;
  let historyTicket = 0;
  // The box follows the configured site until somebody types in it, and never after.
  let edited = false;

  const intro = doc().createTextNode('');
  const modeButtons = MODES.map((option) =>
    el(
      'button',
      {
        className: 'mode',
        attrs: { type: 'button', 'aria-pressed': 'false' },
        on: {
          click: () => {
            mode = option.value;
            drawForm();
          },
        },
      },
      el('strong', { text: option.label }),
      el('span', { text: option.note }),
    ),
  );
  const urlInput = el('input', {
    className: 'grow',
    attrs: { type: 'text', spellcheck: 'false', 'aria-label': 'URL to test', placeholder: 'http://localhost:3000/resume' },
    on: {
      input: () => {
        edited = true;
        drawForm();
        drawPast();
      },
      keydown: (event) => {
        if (event.key === 'Enter') void run();
      },
    },
  });
  urlInput.value = ctx.state().config.site;
  const runButton = button({ label: 'Run test', primary: true, onClick: () => void run() });
  const keyBlockedNote = el('p', {
    className: 'note',
    hidden: true,
    text: 'A content review needs an API key. Add one in Settings, or switch to Structure only.',
  });
  const keyPartialNote = el('p', {
    className: 'note',
    hidden: true,
    text: 'No key configured, so this will run the structural checks and stop there. That is the whole score either way.',
  });
  const progress = createProgress('Starting');
  const slowNote = el('p', {
    className: 'note',
    hidden: true,
    text: 'Reading each Markdown document is a separate model call, so this takes a while.',
  });

  const errorSlot = el('div', { className: 'contents' });
  const scoreSlot = el('div', { className: 'contents' });
  const promptSlot = el('div', { className: 'contents' });
  const checksSlot = el('div', { className: 'contents' });
  const contentSlot = el('div', { className: 'contents' });
  const pastSlot = el('div', { className: 'contents' });
  /** Whatever each slot was last drawn from, so a redraw that changes nothing touches nothing. */
  const drawn = { error: '', score: '', prompt: '', checks: '', content: '', past: '' };

  const node = el(
    'div',
    {},
    pageHead('Test', intro),
    card(
      'card-pad stack',
      el('div', { className: 'modes', attrs: { role: 'group', 'aria-label': 'What to run' } }, modeButtons),
      el('div', { className: 'row' }, urlInput, runButton),
      keyBlockedNote,
      keyPartialNote,
      progress.node,
      slowNote,
    ),
    errorSlot,
    scoreSlot,
    promptSlot,
    checksSlot,
    contentSlot,
    pastSlot,
  );

  // Only `content` is blocked outright by a missing key. `full` degrades to the structural half and
  // says so afterwards, which is the common case and should not read as an error before it runs.
  const keyBlocked = () => mode === 'content' && !ctx.state().key.present;

  async function run() {
    const url = urlInput.value;
    if (busy || !url.trim() || keyBlocked()) return;
    const runMode = mode;
    busy = true;
    runningMode = runMode;
    error = undefined;
    progress.set(undefined);
    draw();
    try {
      // The run lives in `runs.js`, not here, so a second press from anywhere joins it instead of
      // paying for an overlapping content review.
      const next = await startRun('test', (signal) =>
        api.test(
          { url, mode: runMode },
          (event) => {
            progress.set(event);
            // The structural half is a finished answer on its own, and the content review after it
            // is one provider call per document. Showing the score the moment it exists is what the
            // terminal does, and it is the difference between a two second wait and a four minute one.
            if (event.phase === 'structure-done') {
              result = interimResult(runMode, event.structure);
              drawResult();
            }
          },
          signal,
        ),
      );
      result = next;
      seenLast = next;
      ctx.onTestResult(next);
    } catch (thrown) {
      // The page is closing. There is nobody to tell.
      if (!isAbort(thrown)) {
        error = thrown instanceof ApiError ? thrown.message : String(thrown);
        result = undefined;
      }
    } finally {
      busy = false;
      progress.set(undefined);
      draw();
      // A finished run is a new history entry, so the past-runs card is never a session behind.
      void loadHistory();
    }
  }

  async function loadHistory() {
    const ticket = ++historyTicket;
    /** @type {HistoryEntry[]} */
    let entries;
    try {
      entries = (await api.history()).entries;
    } catch {
      // A project with no history at all is the normal first-run case, and it arrives as an empty
      // list or a failed read depending on whether `.opengeo/` exists yet.
      entries = [];
    }
    if (ticket !== historyTicket) return;
    history = entries;
    drawPast();
  }

  function drawForm() {
    const state = ctx.state();
    setText(
      intro,
      `Run the ${state.checkCount} structural checks on one live URL for a score out of 100, and have a model read the Markdown your site serves. Nothing is written to disk.`,
    );
    modeButtons.forEach((modeButton, index) => modeButton.setAttribute('aria-pressed', String(MODES[index]?.value === mode)));
    setLabel(runButton, busy ? 'Testing' : 'Run test');
    setBusy(runButton, busy, !urlInput.value.trim() || keyBlocked());
    keyBlockedNote.hidden = !keyBlocked();
    keyPartialNote.hidden = !(mode === 'full' && !state.key.present);
    progress.node.hidden = !busy;
    slowNote.hidden = !(busy && runningMode !== 'structure');
  }

  function drawResult() {
    const { bands } = ctx.state();

    const errorKey = error ?? '';
    if (errorKey !== drawn.error) {
      fill(errorSlot, error ? banner({ tone: 'fail', title: 'The test could not run' }, error) : null);
      drawn.error = errorKey;
    }

    // Three slots with their own keys, because a full run arrives twice: the structural half first,
    // then the whole thing. The checks are identical both times, and redrawing them would snap shut a
    // locked group the reader had just opened.
    const score = result?.score;
    const scoreKey = result && score ? JSON.stringify([score, result.url, result.framework?.name, result.history, bands.structural]) : '';
    if (scoreKey !== drawn.score) {
      fill(
        scoreSlot,
        result && score
          ? card('', scorePanel({ score, url: result.url, framework: result.framework, history: result.history, bands: bands.structural }))
          : null,
      );
      drawn.score = scoreKey;
    }

    // Only when there is something to ask for: a prompt that says "nothing to fix" is not worth a card.
    const prompts = result?.prompts;
    const worthCopying = prompts && Object.keys(prompts.groups).length > 0 ? prompts : undefined;
    const promptKey = worthCopying ? worthCopying.all : '';
    if (promptKey !== drawn.prompt) {
      fill(promptSlot, worthCopying ? fixPromptCard(worthCopying) : null);
      drawn.prompt = promptKey;
    }

    const checksKey = result?.checks ? JSON.stringify([result.checks, score?.locked, Boolean(prompts)]) : '';
    if (checksKey !== drawn.checks) {
      fill(checksSlot, result?.checks ? checkList(result.checks, score, prompts) : null);
      drawn.checks = checksKey;
    }

    const contentKey = result
      ? JSON.stringify([result.contentError, result.contentSkipped, result.content, result.discovery?.rejected, bands.content])
      : '';
    if (contentKey !== drawn.content) {
      fill(contentSlot, result ? contentCards(result, bands.content) : null);
      drawn.content = contentKey;
    }
  }

  function drawPast() {
    const visible = !result && !busy;
    const { checkCount } = ctx.state();
    const runs = visible && history ? pastRunsOf(history, urlInput.value) : undefined;
    const key = visible ? JSON.stringify([runs ?? null, checkCount]) : '';
    if (key === drawn.past) return;
    fill(pastSlot, visible ? pastRuns(runs, checkCount) : null);
    drawn.past = key;
  }

  function draw() {
    drawForm();
    drawResult();
    drawPast();
  }

  draw();
  void loadHistory();

  return {
    node,
    onKey(key) {
      const prompts = result?.prompts;
      if (key !== 'c' || !prompts || Object.keys(prompts.groups).length === 0) return false;
      void copyPrompt(prompts.all, prompts.summary);
      return true;
    },
    update() {
      if (!edited) {
        const site = ctx.state().config.site;
        if (urlInput.value !== site) urlInput.value = site;
      }
      // A result that arrived from elsewhere, onboarding's first run being the one that exists.
      const latest = ctx.lastTest();
      if (latest !== seenLast) {
        seenLast = latest;
        if (!busy && latest) result = latest;
      }
      draw();
    },
  };
}

/**
 * The structural half as a result in its own right, with the content half still to come.
 *
 * @param {TestMode} mode
 * @param {StructurePayload} structure
 * @returns {TestResponse}
 */
function interimResult(mode, structure) {
  return {
    ...structure,
    mode,
    history: { trend: [], previous: null },
    structure: undefined,
    content: null,
    discovery: null,
    contentSkipped: null,
    contentError: null,
  };
}

// -- past runs -----------------------------------------------------------------------------------

/**
 * @typedef {object} PastRun
 * @property {string} at
 * @property {number} score
 * @property {number | undefined} change Against the run drawn before it. Absent for the first.
 */

/**
 * The runs of this URL worth drawing, oldest first, which is the only order in which the deltas
 * between the chips mean what they say.
 *
 * Filtered to the URL in the box, because a trend mixing two different sites is a line with no
 * meaning. The box is the right thing to filter on here because this card only shows when no
 * result is on screen, so there is no other URL it could mean.
 *
 * @param {HistoryEntry[]} entries
 * @param {string} url
 * @returns {{ total: number; shown: PastRun[] }}
 */
export function pastRunsOf(entries, url) {
  const mine = entries.filter((entry) => entry.score !== undefined && sameUrl(entry.url, url));
  const recent = mine.slice(-PAST_RUNS_SHOWN);
  return {
    total: mine.length,
    shown: recent.map((entry, index) => {
      const before = recent[index - 1];
      const score = /** @type {number} */ (entry.score);
      return { at: entry.at, score, change: before?.score === undefined ? undefined : score - before.score };
    }),
  };
}

/**
 * Where this URL has been, on the screen that has no result on it yet.
 *
 * "No result yet, run a test" is true and useless: the project has almost certainly been tested
 * before, the scores are on disk, and a returning user asking "did my change help" should not have
 * to run something to find out where they started.
 *
 * Local only. `.opengeo/history.json` sits beside the manifest and is never web-served, so this is
 * the only way to see it short of opening the file.
 *
 * @param {{ total: number; shown: PastRun[] } | undefined} runs Undefined while history is still loading.
 * @param {number} checkCount
 */
function pastRuns(runs, checkCount) {
  const latest = runs?.shown[runs.shown.length - 1];
  if (!runs || !latest) {
    return card('card-pad', empty('No result yet', `Run a test to see which of the ${checkCount} checks pass, which fail, and exactly why.`));
  }
  return card(
    '',
    cardHead({ title: 'Where this URL has been', sub: `${runs.total} recorded run${runs.total === 1 ? '' : 's'}, on this machine only` }),
    el(
      'div',
      { className: 'card-pad stack-sm' },
      el(
        'div',
        { className: 'past-runs' },
        runs.shown.map((run) =>
          el(
            'div',
            { className: 'past-run' },
            el('b', { text: String(run.score) }),
            el('span', { className: 'muted', text: ago(run.at) }),
            run.change
              ? el('span', { className: run.change > 0 ? 'delta delta-up' : 'delta delta-down', text: `${run.change > 0 ? '+' : ''}${run.change}` })
              : null,
          ),
        ),
      ),
      el('p', { className: 'note note-sm', text: `Last run ${ago(latest.at)} and scored ${latest.score}. Run it again to see what has moved.` }),
    ),
  );
}

/**
 * Whether two URL strings name the same page.
 *
 * The box holds whatever was typed and the history holds what the runner resolved, so
 * `http://localhost:3100` and `http://localhost:3100/` are one site recorded two ways. Compared as
 * parsed URLs rather than as strings, because a string comparison hid every past run behind a
 * trailing slash nobody types.
 *
 * @param {string} a
 * @param {string} b
 */
export function sameUrl(a, b) {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a.trim() === b.trim();
  }
}

// -- content review ------------------------------------------------------------------------------

/**
 * The first line of a message written for a terminal, capitalised, without the block under it.
 *
 * `ERRORS.noApiKey` is hard-wrapped at 68 columns with indented shell lines beneath it. That is
 * right where it was written and collapses into one grey paragraph the moment HTML lays it out. The
 * first line is the reason, which is the only part of it a page with a Settings tab needs.
 *
 * @param {string} message
 */
export function reasonOnly(message) {
  const line = (message.split('\n', 1)[0] ?? '').trim();
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * The same bands the terminal report colours by, so the two never disagree about what 74 means.
 *
 * @param {number} score
 * @param {BandThresholds} bands
 * @returns {'ok' | 'warn' | 'fail'}
 */
export function toneFor(score, bands) {
  if (score >= bands.good) return 'ok';
  if (score >= bands.fair) return 'warn';
  return 'fail';
}

/**
 * The path is what tells two twins apart. The origin is the same for all of them.
 *
 * @param {string} url
 */
export function shortPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Weakest first, so the page that most needs work is the first one read. A document that was never
 * scored goes last: it has nothing to compare.
 *
 * @param {DocumentReview[]} documents
 */
export function sortDocuments(documents) {
  return [...documents].sort((a, b) => (a.review?.score ?? 999) - (b.review?.score ?? 999));
}

const PRIORITIES = new Set(['high', 'medium', 'low']);

/**
 * The priority comes from a model, and it is the one piece of model output that reaches a class
 * name. Anything but the three known words keeps the base class and is shown as text only.
 * `rec-low` has no rule of its own; it falls back to the base colour, which is the intended look.
 *
 * @param {string} priority
 */
export function priorityClass(priority) {
  return PRIORITIES.has(priority) ? `rec-priority rec-${priority}` : 'rec-priority';
}

/**
 * Where an edit goes, as one line: the area, the heading or phrase, and every document it touches.
 *
 * @param {QualityRecommendation & { documents?: string[] }} recommendation
 */
export function whereLine(recommendation) {
  return [recommendation.area, recommendation.where, ...(recommendation.documents ?? []).map(shortPath)].filter(Boolean).join('  ');
}

const SEPARATE = 'Separate from the score, always.';

/**
 * @param {TestResponse} result
 * @param {BandThresholds} bands
 * @returns {Array<HTMLElement | null> | HTMLElement | null}
 */
function contentCards(result, bands) {
  if (result.contentError) {
    return card(
      '',
      cardHead({ title: 'Content review', sub: SEPARATE }),
      el(
        'div',
        { className: 'card-pad' },
        // Line structure preserved. These messages are written for a terminal and some of them are
        // several lines with an indented command in the middle, which HTML otherwise lays out as one
        // unreadable grey paragraph.
        banner({ tone: 'fail', title: 'The review did not run' }, el('span', { className: 'pre-wrap', text: result.contentError })),
      ),
    );
  }

  if (result.contentSkipped) {
    return card(
      '',
      cardHead({ title: 'Content review', sub: SEPARATE }),
      el(
        'div',
        { className: 'card-pad' },
        // The reason only. The rest of the canonical message is instructions for setting a key up by
        // hand in a terminal, and this page has a Settings tab that does it with a form, so it points
        // at that instead of reprinting a shell transcript.
        banner(
          { tone: 'info', title: 'Skipped' },
          `${reasonOnly(result.contentSkipped)} Add one in Settings and run this again. The structural score above is complete either way.`,
        ),
      ),
    );
  }

  const content = result.content;
  if (!content) return null;

  if (content.documents.length === 0) {
    return card(
      '',
      cardHead({ title: 'Content review', sub: `${content.provider} / ${content.model}` }),
      el(
        'div',
        { className: 'card-pad' },
        empty('No Markdown documents found', 'OpenGEO looked in llms.txt, the sitemap, and at the twin URL for this page. Run Generate to write them.'),
      ),
    );
  }

  return [
    summaryCard(content, result.discovery?.rejected ?? [], bands, result.mode !== 'content'),
    // Every recommendation is drawn, even two with the same text: deduplicating by the action would
    // hide an edit the model asked for twice.
    content.recommendations.length > 0
      ? card(
          '',
          cardHead({
            title: 'What to change first',
            sub: 'One list for the whole site. The same edit needed on two pages appears once, with both.',
          }),
          el('div', { className: 'card-pad stack-sm' }, content.recommendations.map((recommendation, index) => recommendationRow(recommendation, index + 1))),
        )
      : null,
    ...sortDocuments(content.documents).map((entry) => documentCard(entry, bands)),
  ];
}

/**
 * @param {ContentReview} content
 * @param {Array<{ url: string; reason: string }>} rejected
 * @param {BandThresholds} bands
 * @param {boolean} scored Whether the structural score is on the page above this card.
 */
function summaryCard(content, rejected, bands, scored) {
  const read = content.documents.length;
  return card(
    '',
    cardHead({
      title: 'Content review',
      sub: `${content.provider} / ${content.model}. How good the Markdown is, scored apart from the structural 0-100${scored ? ' above' : ''}.`,
      right: content.score !== undefined ? pill(toneFor(content.score, bands), `${content.score} / 100`) : null,
    }),
    el(
      'div',
      { className: 'card-pad stack' },
      el('p', {
        className: 'muted',
        style: { margin: '0' },
        text: `${read} document${read === 1 ? '' : 's'} read${content.notReviewed > 0 ? `, ${content.notReviewed} left out to keep the run short` : ''}.`,
      }),
      content.areaScores.length > 0 ? areaBars(content.areaScores, bands) : null,
      rejected.length > 0
        ? el(
            'div',
            {},
            el('div', { className: 'group-title', text: 'Looked like documents, were not' }),
            el(
              'ul',
              { className: 'muted', style: { margin: '6px 0 0', paddingLeft: '20px' } },
              rejected.map((entry) => el('li', {}, el('span', { className: 'mono', text: shortPath(entry.url) }), ` ${entry.reason}`)),
            ),
          )
        : null,
    ),
  );
}

/**
 * Costliest area first, which is not the same as weakest.
 *
 * The last column is what the gap in that area takes off the 100, so a middling score in a heavy
 * area outranks a bad one in a light area. That is the ordering somebody deciding what to fix
 * actually needs, and it is why the number beside the bar is a loss rather than a rating.
 *
 * @param {AreaScore[]} areas
 * @param {BandThresholds} bands
 */
function areaBars(areas, bands) {
  return el(
    'div',
    { className: 'areas' },
    areas.map((area) =>
      el(
        'div',
        { className: 'area' },
        el('span', { className: 'area-label' }, area.area, area.weight !== undefined ? el('span', { className: 'muted', text: ` /${area.weight}` }) : null),
        el(
          'span',
          { className: 'area-track' },
          // `tone-ok` has no rule of its own; the base fill is already the ok colour.
          el('span', { className: `area-fill tone-${toneFor(area.score, bands)}`, style: { width: `${Math.max(0, Math.min(100, area.score))}%` } }),
        ),
        el('span', { className: 'area-value num', text: area.lost > 0 ? `-${area.lost}` : String(area.score) }),
      ),
    ),
  );
}

/**
 * One edit: what to change, where, and what the reader gains by it.
 *
 * @param {QualityRecommendation & { documents?: string[] }} recommendation
 * @param {number} [index]
 */
function recommendationRow(recommendation, index) {
  return el(
    'div',
    { className: 'rec' },
    el('span', { className: priorityClass(recommendation.priority), text: recommendation.priority }),
    el(
      'div',
      {},
      el('div', {}, index !== undefined ? el('span', { className: 'muted', text: `${index}. ` }) : null, recommendation.action),
      recommendation.impact ? el('div', { className: 'muted', text: recommendation.impact }) : null,
      el('div', { className: 'muted mono rec-where', text: whereLine(recommendation) }),
    ),
  );
}

/**
 * @param {DocumentReview} entry
 * @param {BandThresholds} bands
 */
function documentCard(entry, bands) {
  const review = entry.review;
  return card(
    '',
    cardHead({
      title: shortPath(entry.url),
      sub: `${entry.words.toLocaleString()} words, found via ${entry.source}`,
      right: review?.score !== undefined ? pill(toneFor(review.score, bands), `${review.score} / 100`) : null,
    }),
    el(
      'div',
      { className: 'card-pad stack' },
      entry.error ? banner({ tone: 'warn', title: 'Not reviewed' }, entry.error) : null,
      review
        ? [
            el('p', { style: { margin: '0' }, text: review.summary }),
            review.findings.length > 0
              ? el(
                  'div',
                  { className: 'stack-sm' },
                  review.findings.map((finding) =>
                    el(
                      'div',
                      {},
                      el('strong', { text: finding.area }),
                      finding.score !== undefined ? el('span', { className: 'muted', text: ` ${finding.score}/100` }) : null,
                      el('span', { className: 'muted', text: `. ${finding.note}` }),
                    ),
                  ),
                )
              : null,
            review.recommendations.length > 0
              ? el(
                  'div',
                  { className: 'stack-sm' },
                  el('div', { className: 'group-title', text: 'What to change here' }),
                  review.recommendations.map((recommendation) => recommendationRow(recommendation)),
                )
              : null,
          ]
        : null,
    ),
  );
}
