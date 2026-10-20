import { api, ApiError } from '../api.js';
import { isAbort, startRun } from '../runs.js';
import { banner, button, card, cardHead, el, empty, field, fill, pageHead, pill, setBusy, setLabel, setText } from '../ui.js';

/**
 * @import { AiBot, LeverId, ProdProbe, ProdVerification } from '../../../core/src/shared/api-types.js'
 * @import { Ctx, View } from '../context.js'
 */

/**
 * Prod: probe a running site and report the two levers separately (§7).
 *
 * The grouping here is the whole point. Lever 1 decides which agents receive markdown and can
 * never deny anyone anything; lever 2 is an opt-in robots.txt block list that prod does not even
 * have code for. Showing them in one merged list would quietly teach the reader that routing is a
 * form of blocking, which is the exact confusion the design avoids.
 */

/** @type {Array<{ id: LeverId; title: string; sub: string }>} */
const LEVERS = [
  {
    id: 'routing',
    title: 'Lever 1 - markdown routing',
    sub: 'Which agents receive the twin. This never denies anyone anything: an unlisted bot sees the ordinary site.',
  },
  {
    id: 'negotiation',
    title: 'Content negotiation',
    sub: 'Same URL, different representation, driven by the Accept header rather than by who is asking.',
  },
  {
    id: 'blocking',
    title: 'Lever 2 - robots.txt blocking',
    sub: 'Opt-in, empty by default, and written by generate. Prod has no blocking code path at all.',
  },
];

/**
 * The crawlers worth impersonating: a robots.txt-only entry has no User-Agent to send.
 *
 * @param {AiBot[]} bots
 * @returns {string[]}
 */
export function routableNames(bots) {
  return bots.filter((bot) => bot.uaPatterns.length > 0).map((bot) => bot.name);
}

/**
 * @param {ProdProbe} probe
 * @returns {string}
 */
export function probeTranscript(probe) {
  const headers = Object.entries(probe.headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
  return `${probe.curl}\n\n${headers || '(no OpenGEO headers came back)'}`;
}

/**
 * @param {Ctx} ctx
 * @returns {View}
 */
export function createProdView(ctx) {
  let busy = false;
  let hasResult = false;
  let syncedUrl = '';
  /** @type {string | undefined} */
  let optionsShown;

  const urlInput = el('input', {
    attrs: { type: 'text', spellcheck: 'false', 'aria-label': 'Site URL to probe' },
    on: { input: () => sync() },
  });
  // The empty value means "whatever the server impersonates by default", so the request leaves
  // `bot` out and the server's own choice applies. The name shown beside it is the server's too.
  const botSelect = el('select');
  const runButton = button({ label: 'Run probes', primary: true, onClick: () => void run() });

  const errorSlot = el('div', { className: 'contents' });
  const resultSlot = el('div', { className: 'contents' });
  const emptyCard = card(
    'card-pad',
    empty('No probes run yet', 'Start your site, then run the probes to see the levers from the outside, exactly as an agent would.'),
  );

  const node = el(
    'div',
    {},
    pageHead(
      'Prod',
      'Probe a running site to see whether the middleware is installed and what each of the two bot levers is actually doing. This reads your deployment, it never changes it.',
    ),
    card(
      'card-pad',
      el('div', { className: 'row row-end' }, el('div', { className: 'grow' }, field('Site URL', urlInput)), field('Impersonate', botSelect), runButton),
    ),
    errorSlot,
    resultSlot,
    emptyCard,
  );

  function sync() {
    setLabel(runButton, busy ? 'Probing' : 'Run probes');
    setBusy(runButton, busy, !urlInput.value.trim());
    emptyCard.hidden = hasResult || busy;
  }

  /**
   * Redrawn only when the list really changed, so an open dropdown is not yanked closed by a reload
   * that brought the same crawlers back. The choice survives the redraw while it is still offered.
   */
  function syncBots() {
    const defaultBot = ctx.state().defaultBot;
    const names = routableNames(ctx.bots());
    const key = JSON.stringify([defaultBot, names]);
    if (key === optionsShown) return;
    optionsShown = key;
    const chosen = botSelect.value;
    fill(
      botSelect,
      el('option', { attrs: { value: '' }, text: `${defaultBot} (default)` }),
      names.map((name) => el('option', { attrs: { value: name }, text: name })),
    );
    botSelect.value = names.includes(chosen) ? chosen : '';
  }

  async function run() {
    busy = true;
    fill(errorSlot);
    sync();
    const input = { url: urlInput.value, bot: botSelect.value || undefined };
    try {
      const result = await startRun('prod', () => api.prodTest(input));
      hasResult = true;
      fill(resultSlot, report(result));
    } catch (thrown) {
      if (isAbort(thrown)) return;
      fill(errorSlot, banner({ tone: 'fail', title: 'The probes could not run' }, thrown instanceof ApiError ? thrown.message : String(thrown)));
      hasResult = false;
      fill(resultSlot);
    } finally {
      busy = false;
      sync();
    }
  }

  function update() {
    const state = ctx.state();
    if (urlInput.value === syncedUrl) urlInput.value = syncedUrl = state.config.site;
    syncBots();
    sync();
  }

  update();
  return { node, update };
}

/** @param {ProdVerification} result */
function report(result) {
  return [
    result.installed
      ? null
      : banner(
          { tone: 'fail', title: 'No response carried X-AEO-Version' },
          `Nothing at ${result.target} answered like OpenGEO's middleware, so every probe below is describing a site without prod installed. ` +
            'Install opengeo-prod and wire it into your server: on Next.js 16 that is a proxy.ts file, and the opengeo-prod README has the code.',
        ),
    result.conflicts.length ? banner({ tone: 'warn', title: 'The two levers contradict each other' }, result.conflicts.join(' ')) : null,
    card(
      'card-pad',
      el(
        'div',
        { className: 'row' },
        pill('ok', `${result.counts.pass} pass`),
        pill('warn', `${result.counts.warn} warn`),
        pill('fail', `${result.counts.fail} fail`),
        el('span', { className: 'muted' }, `Impersonated ${result.bot}. Twin URL `, el('span', { className: 'mono', text: result.twinUrl }), '.'),
      ),
    ),
    LEVERS.map((lever) => {
      const probes = result.probes.filter((probe) => probe.lever === lever.id);
      if (!probes.length) return null;
      return card('', cardHead({ title: lever.title, sub: lever.sub }), el('div', { className: 'card-pad stack' }, probes.map(probeRow)));
    }),
    card(
      '',
      cardHead({ title: 'robots.txt', sub: result.robots.found ? result.robots.url : `Nothing served at ${result.robots.url}` }),
      el(
        'div',
        { className: 'card-pad stack-sm' },
        result.robots.found
          ? [
              el('div', {}, el('span', { className: 'group-title', text: 'Allowed' }), ' ', el('span', { className: 'muted', text: result.robots.allowed.join(', ') || 'nothing named explicitly' })),
              el('div', {}, el('span', { className: 'group-title', text: 'Blocked' }), ' ', el('span', { className: 'muted', text: result.robots.blocked.join(', ') || 'nobody' })),
            ]
          : el('span', {
              className: 'muted',
              text: 'Without a robots.txt, most crawlers assume they may fetch everything. Run generate to write one, or hand-write it yourself.',
            }),
        // Two identical notes are two lines. Nothing here is keyed on its text.
        result.robots.notes.map((note) => el('div', { className: 'muted', text: note })),
      ),
    ),
  ];
}

/** @param {ProdProbe} probe */
function probeRow(probe) {
  const tone = probe.verdict === 'pass' ? 'ok' : probe.verdict === 'warn' ? 'warn' : 'fail';
  return el(
    'div',
    { className: 'stack-sm' },
    el('div', { className: 'row' }, pill(tone, probe.verdict), el('strong', { text: probe.title }), el('span', { className: 'muted mono', text: `HTTP ${probe.status}` })),
    el('div', { className: 'muted', text: probe.reason }),
    probe.detail ? el('div', { className: 'mono muted', text: probe.detail }) : null,
    el(
      'details',
      { className: 'probe' },
      el('summary', { text: 'What was sent, and what came back' }),
      el('pre', { className: 'pre', style: { marginTop: '8px', whiteSpace: 'pre-wrap' }, text: probeTranscript(probe) }),
    ),
  );
}
