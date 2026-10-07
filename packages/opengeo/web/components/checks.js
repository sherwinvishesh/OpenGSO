import { card, el, empty, pill } from '../ui.js';

/** @import { CheckResult, Score } from '../../../core/src/shared/api-types.js' */

/**
 * Failures first, required before recommended, per §5. The order is the point: someone who
 * reads only the first group has read the things that actually stop agents working.
 *
 * Six groups rather than four, because two statuses had nowhere to go. A partial fell through every
 * filter and vanished from the page entirely while still counting in the score, and the twin cascade
 * arrived as thirteen separate rows each explaining that a document which does not exist cannot be
 * inspected. Both now have a home, and the locked one is a single priced card rather than thirteen
 * shrugs.
 *
 * Group titles are `h2`. They sit straight under the page's `h1`, outside any card, so the `h3` the
 * React version used skipped a level.
 */

const DOCS = 'https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/checks.md';

/** @typedef {'ok' | 'fail' | 'warn' | 'mute'} Tone */

/**
 * @typedef {object} GroupSpec
 * @property {string} title
 * @property {Tone} tone
 * @property {CheckResult[]} checks
 * @property {string} empty Shown when there are no checks. A blank one hides the group instead.
 * @property {string} [note]
 */

/**
 * The five plain groups, in reading order. Locked is drawn separately, between Partly there and
 * Passed, because it is a priced summary rather than a list.
 *
 * @param {CheckResult[]} checks
 * @returns {{ before: GroupSpec[]; after: GroupSpec[]; locked: CheckResult[] }}
 */
export function groupChecks(checks) {
  /** @param {CheckResult['status']} status */
  const of = (status) => checks.filter((check) => check.status === status);
  const failed = of('fail');
  return {
    before: [
      {
        title: 'Failed - required',
        tone: 'fail',
        checks: failed.filter((check) => check.importance === 'required'),
        empty: 'Nothing required is failing.',
        note: 'These stop AI agents from reading the page.',
      },
      {
        title: 'Failed - recommended',
        tone: 'warn',
        checks: failed.filter((check) => check.importance === 'recommended'),
        empty: 'Nothing recommended is failing.',
        note: 'These make things better, but nothing here is broken.',
      },
      { title: 'Partly there', tone: 'warn', checks: of('partial'), empty: '', note: 'Scored on what they earned, not all or nothing.' },
    ],
    locked: of('locked'),
    after: [
      { title: 'Passed', tone: 'ok', checks: of('pass'), empty: 'Nothing passed yet.' },
      { title: 'Not applicable', tone: 'mute', checks: of('na'), empty: '', note: 'Excluded from the score entirely, not counted as failures.' },
    ],
  };
}

/**
 * @param {CheckResult[]} checks
 * @param {Score} [score]
 */
export function checkList(checks, score) {
  const { before, locked, after } = groupChecks(checks);
  return el('div', {}, before.map(group), lockedGroup(locked, score), after.map(group));
}

/**
 * @param {string} title
 * @param {Tone} tone
 * @param {number} count
 * @param {string | undefined} note
 */
function groupTitle(title, tone, count, note) {
  return el(
    'h2',
    { className: 'group-title' },
    title,
    pill(tone, String(count)),
    note ? el('span', { style: { textTransform: 'none', letterSpacing: '0' }, text: note }) : null,
  );
}

/** @param {GroupSpec} spec */
function group({ title, tone, checks, empty: emptyText, note }) {
  if (checks.length === 0 && !emptyText) return null;
  return el(
    'div',
    { className: 'check-group' },
    groupTitle(title, tone, checks.length, checks.length > 0 ? note : undefined),
    card('', checks.length === 0 ? empty(emptyText) : checks.map(checkRow)),
  );
}

let lockedIds = 0;

/**
 * The twin cascade, as one priced card.
 *
 * This is the group the `locked` status exists for. Thirteen rows each saying that a document which
 * does not exist cannot be inspected is not information; the same thirteen, summed and labelled with
 * the one thing that unlocks them, is. Collapsed by default and expandable, because the detail is
 * worth having exactly once and never on the way past.
 *
 * @param {CheckResult[]} checks
 * @param {Score} [score]
 */
function lockedGroup(checks, score) {
  if (checks.length === 0) return null;

  const waiting = score?.locked.points ?? checks.reduce((total, check) => total + check.weight, 0);
  const blockers = score?.locked.unlockedBy ?? [];
  const blocker = blockers[0] ?? checks[0]?.lockedBy;

  const detail = el('div', { attrs: { id: `locked-detail-${++lockedIds}` }, hidden: true }, checks.map(checkRow));
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
    groupTitle('Locked', 'mute', checks.length, 'Not failures. Not measurable yet either, so they are outside the score.'),
    card(
      '',
      el(
        'div',
        { className: 'card-pad stack-sm' },
        el(
          'div',
          { className: 'locked-head' },
          el('b', { className: 'locked-points', text: `${waiting} points` }),
          el('span', { className: 'muted', text: `waiting behind ${blockers.join(' and ') || 'one fix'}` }),
        ),
        blocker === 'B1'
          ? el(
              'p',
              { className: 'muted', style: { margin: '0' } },
              'Serve a markdown twin at the ',
              el('span', { className: 'mono', text: '.md' }),
              ' URL and every one of these becomes measurable. ',
              el('span', { className: 'mono', text: 'opengeo generate' }),
              ' writes the files, ',
              el('span', { className: 'mono', text: 'opengeo prod' }),
              ' serves them.',
            )
          : null,
        el(
          'div',
          { className: 'locked-prices' },
          checks.map((check) => el('span', { className: 'locked-price' }, el('b', { text: check.id }), ` ${check.weight}`)),
        ),
        toggle,
      ),
      detail,
    ),
  );
}

/** @param {CheckResult} check */
function checkRow(check) {
  return el(
    'div',
    { className: 'check' },
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
    ),
    el('div', { className: 'check-points', text: points(check) }),
  );
}

/**
 * What the check is doing to the score, in the fewest characters that stay honest.
 *
 * @param {Pick<CheckResult, 'status' | 'weight' | 'earned'>} check
 * @returns {string}
 */
export function points(check) {
  if (check.status === 'fail') return `-${check.weight}`;
  if (check.status === 'partial') return `${check.earned}/${check.weight}`;
  if (check.status === 'locked') return `${check.weight}`;
  if (check.status === 'na') return 'n/a';
  return `${check.weight}`;
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
