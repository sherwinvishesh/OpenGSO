import { el, setText } from '../ui.js';

/** @import { ApiProgress } from '../../../core/src/shared/api-types.js' */

/**
 * What a long run is doing right now.
 *
 * Test and generate are the two things in this app that can take minutes, and until the endpoints
 * streamed there was nothing to show for that time but a spinning button. A run that reports
 * nothing for four minutes is indistinguishable from one that has hung, and the difference matters
 * most to exactly the person least able to tell: someone using it for the first time.
 *
 * The wording is the terminal's wording, on purpose. The same run narrated two different ways in
 * two different places is two things to learn instead of one.
 */

/**
 * @typedef {object} Step
 * @property {string} label
 * @property {number} [done] Drawn as a bar only when the denominator is known and fixed.
 * @property {number} [total]
 * @property {string} [count] The same arithmetic as words, for the cases where a bar would be a guess.
 * @property {string} [detail]
 */

/**
 * @param {ApiProgress | undefined} event
 * @returns {Step | undefined}
 */
export function describeProgress(event) {
  if (!event) return undefined;
  switch (event.phase) {
    case 'structure':
      return { label: 'Auditing the live URL' };
    case 'structure-done':
      return { label: 'Structural checks finished' };
    case 'discover':
      return { label: 'Looking for Markdown documents' };
    case 'discovered':
      return { label: `Found ${event.documents} document${event.documents === 1 ? '' : 's'}` };
    case 'review':
      // One provider call per document, so this is the phase that actually takes the minutes.
      return { label: 'Reviewing content', done: event.done, total: event.total, detail: event.url };
    case 'crawl':
      // `found` grows while the crawl runs, so it is reported as a count and never as a fraction.
      return { label: 'Following links', count: `${event.visited} of ${event.found} found so far`, detail: event.route };
    case 'generate':
      return {
        label: 'Converting pages',
        done: event.index,
        total: event.total,
        detail: event.step === 'ai' ? `${event.route}  (AI)` : event.route,
      };
    case 'files':
      return { label: 'Writing robots.txt, llms.txt and sitemap.xml' };
    default:
      return undefined;
  }
}

/**
 * The progress panel. It is one set of nodes for the whole run: frames arrive many times a second,
 * and each one changes a few text nodes and a width rather than redrawing the panel.
 *
 * Only the phase is announced. The live region used to wrap the count and the current URL too, so a
 * screen reader was handed a new sentence on every frame of a crawl and read none of them through.
 *
 * @param {string} idle What to say before the first frame arrives.
 * @returns {{ node: HTMLElement; set: (event: ApiProgress | undefined) => void }}
 */
export function createProgress(idle) {
  const label = el('b');
  const count = el('span', { className: 'progress-count', hidden: true });
  const announce = el('span', { className: 'sr-only', attrs: { role: 'status', 'aria-live': 'polite' } });
  const fill = el('span', { className: 'progress-fill' });
  const bar = el(
    'div',
    { className: 'progress-track', attrs: { role: 'progressbar', 'aria-valuemin': 0 } },
    fill,
  );
  // Nothing to divide by yet, or a denominator that is still being discovered. A bar that slides
  // backwards when the crawl finds two more links is worse than no bar at all.
  const drift = el('div', { className: 'progress-track', attrs: { 'aria-hidden': 'true' } }, el('span', { className: 'progress-drift' }));
  const detail = el('div', { className: 'progress-detail mono', hidden: true });

  const node = el(
    'div',
    { className: 'progress' },
    el('div', { className: 'progress-head' }, el('span', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }), label, count),
    bar,
    drift,
    detail,
    announce,
  );

  /** @param {ApiProgress | undefined} event */
  function set(event) {
    const step = describeProgress(event) ?? { label: idle };
    setText(label, step.label);
    setText(announce, step.label);
    setText(count, step.count ?? '');
    count.hidden = !step.count;
    setText(detail, step.detail ?? '');
    detail.hidden = !step.detail;

    const measured = Boolean(step.total);
    bar.hidden = !measured;
    drift.hidden = measured;
    if (measured && step.total) {
      const done = step.done ?? 0;
      fill.style.width = `${Math.min(100, (done / step.total) * 100)}%`;
      bar.setAttribute('aria-valuenow', String(done));
      bar.setAttribute('aria-valuemax', String(step.total));
      bar.setAttribute('aria-label', step.label);
    }
  }

  set(undefined);
  return { node, set };
}
