import { ago, el, svg } from '../ui.js';

/** @import { BandThresholds, Framework, HistoryEntry, Score } from '../../../core/src/shared/api-types.js' */

/**
 * The score indicator: a number from 0 to 100 and nothing else.
 *
 * No letter grade and no tier label anywhere, per §5. A "B+" invites you to feel fine about
 * a site that is invisible to half the agents on the web, and a tier name turns a measurement into
 * a marketing category. The number and the list of what failed are the whole story.
 */

/**
 * The colour a score is drawn in. The thresholds come from the server, which takes them from the
 * same place the terminal does, so the dial and the CLI never disagree about what 87 means.
 *
 * @param {number} value
 * @param {BandThresholds} bands
 * @returns {string}
 */
export function scoreColour(value, bands) {
  if (value >= bands.good) return 'var(--ok)';
  if (value >= bands.fair) return 'var(--warn)';
  return 'var(--danger)';
}

/**
 * The share of the suggestions this site has adopted, out of every suggestion that applies here,
 * the locked ones included. A site with no twin reads low on it, and that is the point: the dial
 * says the score is 100, the thread says there is still a layer the site has not built.
 *
 * @param {Score} score
 * @returns {number}
 */
export function adoptedShare(score) {
  const { adopted, count } = score.suggestions;
  return count === 0 ? 0 : adopted / count;
}

/**
 * @param {Score} score
 * @param {BandThresholds} bands
 */
export function scoreDial(score, bands) {
  const size = 116;
  const stroke = 9;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = Math.max(0, Math.min(100, score.value)) / 100;
  const colour = scoreColour(score.value, bands);
  const centre = size / 2;

  // Suggestions sit outside the denominator by construction, so there is no share of *this* ring for
  // them to take. They get their own thread inside instead, drawn as the share adopted, over a faint
  // track for the whole. The outer ring says the score is 100; the thread says how much of the layer
  // beyond it is built. Same centre and same axis so the two read as one figure, a third of the
  // weight so neither is mistaken for the other.
  const innerRadius = radius - stroke / 2 - 4;
  const innerCircumference = 2 * Math.PI * innerRadius;
  const adopted = adoptedShare(score);
  const hasSuggestions = score.suggestions.count > 0;

  return el(
    'div',
    { className: 'score-dial' },
    svg(
      'svg',
      { width: size, height: size, 'aria-hidden': 'true' },
      svg('circle', { cx: centre, cy: centre, r: radius, fill: 'none', stroke: 'var(--border)', 'stroke-width': stroke }),
      hasSuggestions
        ? svg('circle', { cx: centre, cy: centre, r: innerRadius, fill: 'none', stroke: 'var(--border)', 'stroke-width': 3, 'stroke-opacity': 0.6 })
        : null,
      hasSuggestions && adopted > 0
        ? svg('circle', {
            cx: centre,
            cy: centre,
            r: innerRadius,
            fill: 'none',
            stroke: 'var(--info)',
            'stroke-width': 3,
            'stroke-linecap': 'round',
            'stroke-dasharray': `${innerCircumference * adopted} ${innerCircumference}`,
          })
        : null,
      svg('circle', {
        cx: centre,
        cy: centre,
        r: radius,
        fill: 'none',
        stroke: colour,
        'stroke-width': stroke,
        'stroke-linecap': 'round',
        'stroke-dasharray': `${circumference * fraction} ${circumference}`,
        class: 'score-arc',
      }),
    ),
    el('div', { className: 'value', style: { color: colour }, text: String(score.value) }),
    el(
      'span',
      { className: 'sr-only', text: `${score.value} out of 100${hasSuggestions ? `, ${score.suggestions.adopted} of ${score.suggestions.count} suggestions adopted` : ''}` },
    ),
  );
}

/**
 * @typedef {object} ScorePanelProps
 * @property {Score} score
 * @property {string} url
 * @property {Pick<Framework, 'name'>} [framework]
 * @property {{ trend: number[]; previous: HistoryEntry | null }} [history] The runs before this one,
 *   so the number can be read as a direction and not just a value.
 * @property {BandThresholds} bands
 */

/** @param {ScorePanelProps} props */
export function scorePanel({ score, url, framework, history, bands }) {
  /**
   * @param {number} n
   * @param {string} label
   */
  const count = (n, label) => el('span', {}, el('b', { text: String(n) }), ` ${label}`);
  const { counts, scored, suggestions } = score;

  return el(
    'div',
    { className: 'score' },
    scoreDial(score, bands),
    el(
      'div',
      { className: 'score-meta' },
      el(
        'div',
        { className: 'score-headline' },
        el('span', { className: 'mono note note-sm', style: { wordBreak: 'break-all' }, text: url }),
        delta(score, history?.previous ?? null),
        // The current score is appended rather than left off: `trend` is the history from before
        // this run, and a line that stops one run short tells a different story than the dial
        // beside it. Two earlier runs minimum, matching the terminal report, because a line through
        // two points is a slope the delta chip has already said in words.
        history && history.trend.length > 1 ? sparkline([...history.trend, score.value]) : null,
      ),
      // The scored checks first, since they are the number, then the suggestions as their own
      // fraction. Partial, locked and n/a only when there are some: a site with none of them should
      // not be asked to wonder what those words mean.
      el(
        'div',
        { className: 'counts' },
        el('span', {}, el('b', { text: `${scored.pass} of ${scored.count}` }), ' scored passed'),
        scored.partial > 0 ? count(scored.partial, 'partly there') : null,
        scored.fail > 0 ? count(scored.fail, 'failed') : null,
        suggestions.count > 0 ? el('span', {}, el('b', { text: `${suggestions.adopted} of ${suggestions.count}` }), ' suggestions adopted') : null,
        counts.locked > 0 ? count(counts.locked, 'locked') : null,
        counts.na > 0 ? count(counts.na, 'not applicable') : null,
      ),
      el('div', { className: 'note note-sm', text: pointsLine(score, framework) }),
    ),
  );
}

/**
 * @param {Score} score
 * @param {Pick<Framework, 'name'>} [framework]
 * @returns {string}
 */
export function pointsLine(score, framework) {
  const na = score.counts.na;
  return [
    `${score.earned} of ${score.possible} points across the scored checks`,
    na > 0 ? `, with ${na} check${na === 1 ? '' : 's'} excluded because ${na === 1 ? 'it does' : 'they do'} not apply here` : '',
    score.locked.count > 0 ? `, and ${score.locked.count} suggestion${score.locked.count === 1 ? '' : 's'} waiting on ${score.locked.unlockedBy.join(' and ') || 'one fix'}` : '',
    framework ? ` · ${framework.name} detected` : '',
  ].join('');
}

/**
 * The change since the last run of this same URL.
 *
 * Only against the same URL, which is what `previous` already guarantees: a delta between two
 * different sites is a number with no meaning. Nothing is drawn when the score has not moved, since
 * "+0" is noise, and nothing is drawn on a first run, which is most runs.
 *
 * @param {Score} score
 * @param {HistoryEntry | null} previous
 */
function delta(score, previous) {
  if (!previous || previous.score === undefined) return null;
  const change = score.value - previous.score;
  if (change === 0) return null;
  return el('span', { className: `delta ${change > 0 ? 'delta-up' : 'delta-down'}`, text: `${change > 0 ? '+' : ''}${change} since ${ago(previous.at)}` });
}

/**
 * The polyline for the last few runs.
 *
 * Scaled to its own range rather than to 0-100, so a site that has been sitting between 94 and 98
 * shows a shape instead of a flat line at the top. That makes the height meaningless in absolute
 * terms, which is why there is no axis and no label: it is a direction, and the number beside it is
 * the measurement.
 *
 * @param {number[]} values At least two.
 * @param {number} [width]
 * @param {number} [height]
 * @returns {string}
 */
export function sparklinePoints(values, width = 56, height = 16) {
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - (span === 0 ? 0.5 : (value - low) / span) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** @param {number[]} values */
function sparkline(values) {
  const width = 56;
  const height = 16;
  return svg(
    'svg',
    { class: 'sparkline', width, height, 'aria-hidden': 'true' },
    svg('polyline', {
      points: sparklinePoints(values, width, height),
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.5,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    }),
  );
}
