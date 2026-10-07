import { ago, banner, button } from '../ui.js';

/** @import { CheckResult, StateResponse } from '../../../core/src/shared/api-types.js' */

/**
 * The staleness surface (§6).
 *
 * OpenGEO deliberately never regenerates on a schedule or in CI, which means a markdown twin is a
 * cache that nothing invalidates automatically. `last_updated` plus the B14 drift check are the
 * whole safety net, so this is a banner at the top of the app and not a footnote on a settings
 * page. It is the one piece of UI allowed to interrupt you.
 */

const DAY = 24 * 60 * 60 * 1000;
const STALE_AFTER_DAYS = 14;

/**
 * @typedef {object} StalenessVerdict
 * @property {'ok' | 'warn' | 'fail'} tone
 * @property {string} title
 * @property {string} message
 * @property {boolean} actionable
 */

/**
 * @param {StateResponse | undefined} state
 * @param {CheckResult | undefined} drift
 * @param {number} [now]
 * @returns {StalenessVerdict | undefined}
 */
export function stalenessOf(state, drift, now = Date.now()) {
  if (!state) return undefined;

  if (!state.manifest || state.manifest.pages.length === 0) {
    return {
      tone: 'warn',
      title: 'Nothing has been generated yet',
      message: 'There are no markdown twins for this project, so AI agents see only your HTML.',
      actionable: true,
    };
  }

  // A B14 failure is direct evidence, so it outranks any guess based on the clock.
  if (drift && drift.status === 'fail') {
    return {
      tone: 'fail',
      title: 'The served markdown no longer matches the live page',
      message: `${drift.reason} Agents are being handed content that your site has since changed.`,
      actionable: true,
    };
  }

  const generated = new Date(state.manifest.generatedAt).getTime();
  const age = Number.isNaN(generated) ? 0 : now - generated;
  if (age > STALE_AFTER_DAYS * DAY) {
    return {
      tone: 'warn',
      title: `Last generated ${ago(state.manifest.generatedAt, now)}`,
      message:
        'Nothing regenerates these files for you, on purpose. If the site has changed since then, agents are reading the old version.',
      actionable: true,
    };
  }

  if (drift && drift.status === 'pass') {
    return {
      tone: 'ok',
      title: 'The markdown matches the live page',
      message: `Checked against what your site serves right now. Generated ${ago(state.manifest.generatedAt, now)}.`,
      actionable: false,
    };
  }

  return undefined;
}

/**
 * The banner for a verdict, or nothing. Its button only switches to the Generate tab: starting a
 * crawl from a banner the user did not ask about would be a surprise.
 *
 * @param {StalenessVerdict | undefined} verdict
 * @param {() => void} onGenerate
 * @returns {HTMLElement | null}
 */
export function stalenessBanner(verdict, onGenerate) {
  if (!verdict) return null;
  return banner(
    {
      tone: verdict.tone,
      title: verdict.title,
      action: verdict.actionable ? button({ label: 'Generate', small: true, onClick: onGenerate }) : undefined,
    },
    verdict.message,
  );
}
