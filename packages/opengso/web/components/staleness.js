import { ago, banner, button } from '../ui.js';

/** @import { CheckResult, FreshnessReport, StaleKind, StateResponse } from '../../../core/src/shared/api-types.js' */

/**
 * The staleness surface (§6).
 *
 * OpenGSO deliberately never regenerates on a schedule or in CI, which means a markdown twin is a
 * cache that nothing invalidates automatically. `last_updated` plus the B14 drift check are the
 * whole safety net, so this is a banner at the top of the app and not a footnote on a settings
 * page. It is the one piece of UI allowed to interrupt you.
 *
 * A project that generates from its own HTML files has a better net: the server compares each file
 * with the twin made from it every time the state is read, so the banner can name the pages.
 */

/** How many of the out-of-date pages the banner names before it says "and N more". */
const NAMED = 3;

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
 * @param {string} [testedAgainst] The manifest's `generatedAt` when the test that produced `drift`
 *   ran. A different one now means the twins were rewritten after that test.
 * @returns {StalenessVerdict | undefined}
 */
export function stalenessOf(state, drift, now = Date.now(), testedAgainst) {
  if (!state) return undefined;

  if (!state.manifest || state.manifest.pages.length === 0) {
    return {
      tone: 'warn',
      title: 'Nothing has been generated yet',
      message: 'There are no markdown twins for this project, so AI agents see only your HTML.',
      actionable: true,
    };
  }

  // Read off disk moments ago and naming the files, so it comes before anything else.
  if (state.freshness && state.freshness.stale.length > 0) return freshnessVerdict(state.freshness);

  // The banner's own button leads here: the test found the twin out of date, and generate has
  // rewritten the twins since. Repeating the old failure would be wrong, and so would calling it
  // fixed before anything has checked.
  if (drift && drift.status === 'fail' && testedAgainst && state.manifest.generatedAt !== testedAgainst) {
    return {
      tone: 'ok',
      title: 'Regenerated since the last test',
      message: 'The twins were rewritten after that test found one out of date. Run the test again to confirm it matches the live page now.',
      actionable: false,
    };
  }

  // A B14 failure is direct evidence, so it outranks any guess based on the clock. Its reason already
  // says agents are reading the old version and names what moved, and the banner's button is the fix.
  if (drift && drift.status === 'fail') {
    return {
      tone: 'fail',
      title: 'The served markdown no longer matches the live page',
      message: drift.reason,
      actionable: true,
    };
  }

  // The clock is only a guess, and for these files there is no need to guess. Good news on every
  // page load is not worth interrupting anybody for; the Generate tab says it instead.
  if (state.freshness) return undefined;

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

/** @type {Record<StaleKind, string>} */
const ONE_TITLE = {
  changed: 'A page changed after its twin was written',
  manual: 'A page changed after its hand-written twin',
  new: 'A page has no twin yet',
  missing: 'A twin is left over from a deleted page',
};

/**
 * @param {FreshnessReport} report
 * @returns {StalenessVerdict}
 */
function freshnessVerdict(report) {
  const count = report.stale.length;
  const named = report.stale.slice(0, NAMED).map((twin) => twin.message);
  if (count > NAMED) named.push(`And ${count - NAMED} more.`);
  // Only a changed page has an agent reading something wrong. A new one has nothing to read yet, and
  // a deleted one has a twin left describing a page that is gone.
  const outdated = report.stale.some((twin) => twin.kind === 'changed' || twin.kind === 'manual');
  return {
    tone: 'warn',
    title: count === 1 ? ONE_TITLE[report.stale[0]?.kind ?? 'changed'] : `${count} pages are out of date`,
    message: [outdated ? 'Agents are reading the old version.' : '', ...named].filter(Boolean).join(' '),
    // Generate leaves a hand-written twin alone, so a button that cannot help is not offered.
    actionable: report.stale.some((twin) => twin.kind !== 'manual'),
  };
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
