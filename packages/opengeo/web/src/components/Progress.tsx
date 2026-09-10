import type { ApiProgress } from '../types';

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
export function RunProgress({ event, idle }: { event?: ApiProgress; idle: string }) {
  const step = describe(event) ?? { label: idle };

  return (
    <div className="progress" role="status" aria-live="polite">
      <div className="progress-head">
        <span className="spinner" aria-hidden="true" />
        <b>{step.label}</b>
        {step.count ? <span className="progress-count">{step.count}</span> : null}
      </div>
      {step.total ? (
        <div className="progress-track">
          <span className="progress-fill" style={{ width: `${Math.min(100, ((step.done ?? 0) / step.total) * 100)}%` }} />
        </div>
      ) : (
        // Nothing to divide by yet, or a denominator that is still being discovered. A bar that
        // slides backwards when the crawl finds two more links is worse than no bar at all.
        <div className="progress-track" aria-hidden="true">
          <span className="progress-drift" />
        </div>
      )}
      {step.detail ? <div className="progress-detail mono">{step.detail}</div> : null}
    </div>
  );
}

interface Step {
  label: string;
  /** Drawn as a bar only when the denominator is known and fixed. */
  done?: number;
  total?: number;
  /** The same arithmetic as words, for the cases where a bar would be a guess. */
  count?: string;
  detail?: string;
}

function describe(event?: ApiProgress): Step | undefined {
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
      return {
        label: 'Following links',
        count: `${event.visited} of ${event.found} found so far`,
        detail: event.route,
      };
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
