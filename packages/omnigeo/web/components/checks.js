import { card, el, empty, pill } from '../ui.js';
import { copyLink } from './fix-prompt.js';

/** @import { CheckResult, FixPrompts, Score } from '../../../core/src/shared/api-types.js' */

/**
 * Scored failures first, then the suggestions, per §5. The order is the point: someone who reads
 * only the first group has read the things that actually stop agents working, and someone who reads
 * the second has read what would set the site apart.
 *
 * The split is the score's own. Seven checks make up the 0-100 and the other fifteen are
 * suggestions: conventions the best-read sites mostly have not adopted, so not having one is not a
 * failure. Both kinds pass the same way, so the passing ones are split too, into Passed and Adopted,
 * and a reader counting to seven never has to subtract.
 *
 * The twin cascade arrives as one card rather than twelve rows each explaining that a document which
 * does not exist cannot be inspected.
 *
 * Group titles are `h2`. They sit straight under the page's `h1`, outside any card, so an `h3` would
 * skip a level.
 */

const DOCS = 'https://github.com/sherwinvishesh/OmniGEO/blob/main/docs/checks.md';

/** @typedef {'ok' | 'fail' | 'warn' | 'mute' | 'info'} Tone */

/**
 * @typedef {object} GroupSpec
 * @property {string} title
 * @property {Tone} tone
 * @property {CheckResult[]} checks
 * @property {string} empty Shown when there are no checks. A blank one hides the group instead.
 * @property {string} [note]
 * @property {Set<string>} [faults] Ids failing on a twin the site already serves, marked `fix`.
 * @property {'failed' | 'partial' | 'suggestions'} [prompt] Which of the server's group prompts this
 *   group copies, if any.
 */

/**
 * Ids of the suggestions failing on a twin the site already serves: the same rule as core's
 * `twinFaults`. Once the twin is served, a failing check on it means agents are sent something
 * wrong, which is not an idea for standing out, so it goes first and says so.
 *
 * @param {readonly CheckResult[]} checks
 * @returns {Set<string>}
 */
export function twinFaultIds(checks) {
  if (!checks.some((check) => check.id === 'B1' && check.status === 'pass')) return new Set();
  return new Set(checks.filter((check) => !check.scored && check.status === 'fail' && check.category === 'B').map((check) => check.id));
}

/**
 * The plain groups, in reading order. Locked is drawn separately, between Suggestions and Passed,
 * because it is a summary rather than a list.
 *
 * @param {CheckResult[]} checks
 * @returns {{ before: GroupSpec[]; after: GroupSpec[]; locked: CheckResult[] }}
 */
export function groupChecks(checks) {
  /**
   * @param {CheckResult['status']} status
   * @param {boolean} scored
   */
  const of = (status, scored) => checks.filter((check) => check.status === status && Boolean(check.scored) === scored);
  const faults = twinFaultIds(checks);
  const suggestions = checks
    .filter((check) => !check.scored && (check.status === 'fail' || check.status === 'partial'))
    .sort((a, b) => Number(faults.has(b.id)) - Number(faults.has(a.id)) || b.weight - a.weight);
  const ids = [...faults];
  const named = ids.length <= 1 ? ids.join('') : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
  const them = ids.length === 1 ? 'it' : 'them';
  return {
    before: [
      {
        title: 'Failed',
        tone: 'fail',
        checks: of('fail', true),
        empty: 'Nothing scored is failing.',
        note: 'These stop AI agents from reading the page.',
        prompt: 'failed',
      },
      {
        title: 'Partly there',
        tone: 'warn',
        checks: of('partial', true),
        empty: '',
        note: 'Scored on what they earned, not all or nothing.',
        prompt: 'partial',
      },
      {
        title: 'Suggestions',
        tone: 'info',
        checks: suggestions,
        empty: '',
        prompt: 'suggestions',
        note:
          faults.size > 0
            ? `${named} ${faults.size === 1 ? 'fails' : 'fail'} on the twin this site already serves, so agents are being sent something wrong. Outside the score, but fix ${them} first: --strict fails a build on ${them}.`
            : 'Outside the score. The best-read sites have not adopted these either, so they are what would set this one apart.',
        faults,
      },
    ],
    locked: checks.filter((check) => check.status === 'locked'),
    after: [
      { title: 'Passed', tone: 'ok', checks: of('pass', true), empty: 'Nothing scored passed yet.' },
      { title: 'Adopted', tone: 'info', checks: of('pass', false), empty: '', note: 'Suggestions this site already follows.' },
      { title: 'Not applicable', tone: 'mute', checks: checks.filter((check) => check.status === 'na'), empty: '', note: 'Excluded entirely, not counted as failures.' },
    ],
  };
}

/**
 * @param {CheckResult[]} checks
 * @param {Score} [score]
 * @param {FixPrompts} [prompts] The server's fix prompts. Without them there are no copy buttons.
 */
export function checkList(checks, score, prompts) {
  const { before, locked, after } = groupChecks(checks);
  return el(
    'div',
    {},
    before.map((spec) => group(spec, prompts)),
    lockedGroup(locked, score, prompts?.groups.locked),
    after.map((spec) => group(spec)),
  );
}

/**
 * The copy button sits outside the `h2`, so a screen reader's heading list stays a list of names.
 *
 * @param {string} title
 * @param {Tone} tone
 * @param {number} count
 * @param {string | undefined} note
 * @param {string} [prompt] This group's fix prompt.
 */
function groupTitle(title, tone, count, note, prompt) {
  const heading = el(
    'h2',
    { className: 'group-title' },
    title,
    pill(tone, String(count)),
    note ? el('span', { style: { textTransform: 'none', letterSpacing: '0' } }, noteParts(note)) : null,
  );
  if (!prompt) return heading;
  return el(
    'div',
    { className: 'group-head' },
    heading,
    copyLink(count === 1 ? 'Copy fix prompt' : `Copy all ${count}`, prompt, `${count} ${title.toLowerCase()}`, `Copy a fix prompt for the ${title} group`),
  );
}

/**
 * A flag in a note is set as code that never wraps, because a browser will otherwise break
 * `--strict` after its first hyphen and leave a reader looking at a stray `--`.
 *
 * @param {string} note
 */
function noteParts(note) {
  return note
    .split(/(--[a-z][a-z-]*)/)
    .map((part, index) => (index % 2 === 1 ? el('code', { style: { whiteSpace: 'nowrap' }, text: part }) : part));
}

/**
 * @param {GroupSpec} spec
 * @param {FixPrompts} [prompts]
 */
function group({ title, tone, checks, empty: emptyText, note, faults, prompt }, prompts) {
  if (checks.length === 0 && !emptyText) return null;
  return el(
    'div',
    { className: 'check-group' },
    groupTitle(title, tone, checks.length, checks.length > 0 ? note : undefined, prompt && checks.length > 0 ? prompts?.groups[prompt] : undefined),
    card('', checks.length === 0 ? empty(emptyText) : checks.map((check) => checkRow(check, faults?.has(check.id), prompts?.checks[check.id]))),
  );
}

let lockedIds = 0;

/**
 * The twin cascade, as one card.
 *
 * This is the group the `locked` status exists for. Twelve rows each saying that a document which
 * does not exist cannot be inspected is not information; the same twelve, counted and labelled with
 * the one thing that unlocks them, is. Collapsed by default and expandable, because the detail is
 * worth having exactly once and never on the way past.
 *
 * @param {CheckResult[]} checks
 * @param {Score} [score]
 * @param {string} [prompt] The prompt that unlocks them, which is the blocker's.
 */
function lockedGroup(checks, score, prompt) {
  if (checks.length === 0) return null;

  const blockers = score?.locked.unlockedBy ?? [];
  const blocker = blockers[0] ?? checks[0]?.lockedBy;

  const detail = el('div', { attrs: { id: `locked-detail-${++lockedIds}` }, hidden: true }, checks.map((check) => checkRow(check)));
  const closedLabel = `Why each of the ${checks.length} is locked`;
  const toggle = el('button', {
    className: 'link-btn',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': detail.id },
    text: closedLabel,
    on: {
      click: () => {
        const open = detail.hidden;
        detail.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = open ? 'Hide the detail' : closedLabel;
      },
    },
  });

  return el(
    'div',
    { className: 'check-group' },
    groupTitle('Locked', 'mute', checks.length, 'Not failures, and outside the score: suggestions that cannot be measured yet.', prompt),
    card(
      '',
      el(
        'div',
        { className: 'card-pad stack-sm' },
        el(
          'div',
          { className: 'locked-head' },
          el('b', { className: 'locked-points', text: `${checks.length} more ${checks.length === 1 ? 'suggestion applies' : 'suggestions apply'}` }),
          el('span', { className: 'muted', text: `once ${blockers.join(' and ') || 'one fix'} passes` }),
        ),
        blocker === 'B1'
          ? el(
              'p',
              { className: 'muted', style: { margin: '0' } },
              'Serve a markdown twin at the ',
              el('span', { className: 'mono', text: '.md' }),
              ' URL and every one of these becomes measurable. ',
              el('span', { className: 'mono', text: 'omnigeo generate' }),
              ' writes the files, ',
              el('span', { className: 'mono', text: 'omnigeo prod' }),
              ' serves them.',
            )
          : null,
        el(
          'div',
          { className: 'locked-prices', attrs: { title: 'Check weights' } },
          checks.map((check) => el('span', { className: 'locked-price' }, el('b', { text: check.id }), ` ${check.weight}`)),
        ),
        toggle,
      ),
      detail,
    ),
  );
}

/**
 * @param {CheckResult} check
 * @param {boolean} [fault] Failing on a twin already served, so `fix` rather than `tip`.
 * @param {string} [prompt] This check's own fix prompt, when it failed or partly passed.
 */
function checkRow(check, fault = false, prompt) {
  return el(
    'div',
    { className: check.scored ? 'check' : fault ? 'check check-suggestion check-fault' : 'check check-suggestion' },
    el(
      'div',
      { className: 'check-id' },
      el('a', { attrs: { href: docsUrl(check), target: '_blank', rel: 'noreferrer', title: 'What this check verifies' }, text: check.id }),
    ),
    el(
      'div',
      {},
      el(
        'div',
        { className: 'check-title' },
        check.title,
        // A partial carries its arithmetic, because "partly there" with no number is a mood rather
        // than a measurement.
        check.status === 'partial'
          ? el(
              'span',
              { className: 'check-meter', attrs: { title: `${check.earned} of ${check.weight} points` } },
              el(
                'span',
                { className: 'check-meter-track' },
                el('span', { className: 'check-meter-fill', style: { width: `${check.weight > 0 ? (check.earned / check.weight) * 100 : 0}%` } }),
              ),
              `${check.earned} of ${check.weight}`,
            )
          : null,
      ),
      el('div', { className: 'check-reason', text: check.reason }),
      check.detail ? el('div', { className: 'check-detail', text: check.detail }) : null,
      // Last, and only when there is one, because it is the part the reader acts on.
      check.fix ? el('div', { className: 'check-fix', text: check.fix }) : null,
      prompt ? el('div', { className: 'check-copy' }, copyLink('Copy fix prompt', prompt, check.id, `Copy a fix prompt for ${check.id}`)) : null,
    ),
    el('div', {
      className: 'check-points',
      attrs: { title: fault ? 'Fails on the twin agents are served. Outside the score, but --strict fails a build on it' : pointsTitle(check) },
      text: fault ? 'fix' : points(check),
    }),
  );
}

/**
 * What the check is doing to the score, in the fewest characters that stay honest. A scored fail is
 * in score points, the headline's unit; a partial's earned/weight is the check's own arithmetic. A
 * suggestion has no price, because adopting it moves no score, so it says what it is instead.
 *
 * @param {Pick<CheckResult, 'status' | 'weight' | 'earned' | 'price' | 'scored'>} check
 * @returns {string}
 */
export function points(check) {
  if (check.status === 'na') return 'n/a';
  if (check.status === 'partial') return `${check.earned}/${check.weight}`;
  if (!check.scored) return check.status === 'fail' ? 'tip' : `${check.weight}`;
  if (check.status === 'fail') return `-${check.price ?? check.weight}`;
  return `${check.weight}`;
}

/**
 * The unit behind `points`, as the cell's tooltip. A fail is priced on the 0-100 headline and a pass
 * shows its check weight, so two checks of equal weight read "-18" and "9" side by side; this is
 * what tells them apart.
 *
 * @param {Pick<CheckResult, 'status' | 'weight' | 'earned' | 'price' | 'scored'>} check
 * @returns {string}
 */
export function pointsTitle(check) {
  if (check.status === 'na') return 'Excluded from the score';
  if (check.status === 'partial') {
    return `Earned ${check.earned} of this check's weight of ${check.weight}${check.scored ? '' : ', outside the score'}`;
  }
  if (!check.scored) return check.status === 'fail' ? 'Outside the score' : `Check weight ${check.weight}, outside the score`;
  if (check.status === 'fail') return `Fixing this adds ${check.price ?? check.weight} to the 0-100 score`;
  return `Check weight ${check.weight}, counted in the points line under the score`;
}

/**
 * Matches the heading anchors GitHub generates for docs/checks.md.
 *
 * @param {string} title
 * @returns {string}
 */
export function slug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/ /g, '-');
}

/**
 * @param {Pick<CheckResult, 'id' | 'title'>} check
 * @returns {string}
 */
export function docsUrl(check) {
  return `${DOCS}#${check.id.toLowerCase()}---${slug(check.title)}`;
}
