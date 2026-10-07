import { HEADERS } from '../shared/version.js';
import { parseFrontmatter } from '../generate/frontmatter.js';
import { verifyFidelity } from '../generate/fidelity.js';
import { contentHash } from '../shared/hash.js';
import { fail, na, partial, pass } from './checks.js';
import { liveExtract } from './live-page.js';

/**
 * @import { CheckResult } from './checks.js'
 * @import { Evidence } from './evidence.js'
 */

/**
 * B14: whether the twin still says what the live page says (§5).
 */

/**
 * B14 - staleness and drift.
 *
 * This is the check §5 singles out as the one only OpenGEO can make, and the reason is
 * structural: OpenGEO owns both halves of the pipeline, so it knows the hash of the HTML each twin
 * was built from. Nothing that only inspects a live site from the outside can tell "this markdown
 * is a faithful copy of the current page" apart from "this markdown was accurate six months ago".
 *
 * It matters more here than it would elsewhere, because §6 rules out regenerating in CI. Nothing
 * catches a forgotten `opengeo generate` except this check.
 *
 * @param {Evidence} e
 * @returns {CheckResult}
 */
export function checkDrift(e) {
  if (!e.twin.ok || !e.twin.body.trim()) {
    return fail(
      'B14',
      `There is no markdown twin to compare against the live page (HTTP ${e.twin.status || 'unreachable'}).`,
      undefined,
      'Fix B1 first: there is no twin to compare against the live page (+4).',
    );
  }
  if (!e.html.ok || !e.html.body.trim()) {
    return na('B14', 'The live HTML page did not respond, so there is nothing to compare the twin against.');
  }

  const parsed = parseFrontmatter(e.twin.body);
  // Two places the provenance can live, and prod only ever exposes the first. It strips frontmatter
  // at load so the body is clean markdown, and answers with the hash as a response header instead.
  // A twin served straight off a static host keeps its frontmatter, so both are read.
  const sourceHash =
    e.twin.headers.get(HEADERS.markdownSourceHash) ??
    (typeof parsed.data.source_hash === 'string' ? parsed.data.source_hash : undefined);
  const lastUpdated =
    e.twin.headers.get(HEADERS.lastModified) ??
    (typeof parsed.data.last_updated === 'string' ? parsed.data.last_updated : undefined);
  const age = describeAge(lastUpdated);

  // Extracted content, never raw HTML: generate hashes the same thing, for the same reason. A build
  // id or a script nonce changing is not the page changing, and a check that says otherwise on every
  // deploy is a check people learn to ignore.
  const extracted = liveExtract(e);

  if (sourceHash) {
    const liveHash = contentHash(extracted.markdown);
    if (liveHash === sourceHash) {
      return pass(
        'B14',
        `The twin was generated from exactly this version of the page${age ? `, ${age}` : ''}.`,
        `source_hash ${sourceHash} matches the content of the live page.`,
      );
    }
    // The hash says something changed. How much is a different question, and it is the one the
    // reader actually has: a typo fix and a rewritten page both break the hash, and only one of them
    // is serving agents wrong information. Fidelity compares the facts, so it can tell them apart.
    const drift = verifyFidelity(extracted.markdown, parsed.body, { minWordRatio: 0.4, rejectInvented: false });
    if (drift.ok) {
      return partial(
        'B14',
        2,
        `The live page has changed since the twin was generated${age ? ` ${age}` : ''}, but every number, date and price on it still appears in the twin, so the drift is cosmetic so far.`,
        {
          detail: `Twin source_hash ${sourceHash}, the live page's content hashes to ${liveHash}.`,
          fix: 'Re-run `opengeo generate` to bring the twin back in step before the next edit makes it wrong (+2).',
        },
      );
    }
    return fail(
      'B14',
      `The live page has changed since the twin was generated${age ? ` ${age}` : ''}. AI agents are being served stale content. Re-run \`opengeo generate\`.`,
      `Twin source_hash ${sourceHash}, the live page's content hashes to ${liveHash}. ${drift.errors[0]}`,
      'Re-run `opengeo generate` (+4).',
    );
  }

  // No hash anywhere: a hand-written twin, or one produced by something other than OpenGEO. Fall back
  // to comparing the facts on the live page against the facts in the twin, which is slower to
  // reason about but works without any bookkeeping.
  const report = verifyFidelity(extracted.markdown, parsed.body, { minWordRatio: 0.4, rejectInvented: false });
  if (report.ok) {
    return pass(
      'B14',
      `The twin reports no source hash, but every number, date and price on the live page still appears in it${age ? ` (twin last updated ${age})` : ''}.`,
    );
  }
  if (report.errors.length === 1) {
    return partial('B14', 2, `The twin has drifted from the live page in one place${age ? `, and was last updated ${age}` : ''}. ${report.errors[0]}`, {
      detail: 'The twin reports no source hash, so this was compared fact by fact rather than by hash.',
      fix: 'Re-run `opengeo generate` (+2).',
    });
  }
  return fail(
    'B14',
    `The twin no longer matches the live page${age ? `, and was last updated ${age}` : ''}. ${report.errors[0]}`,
    `The twin reports no source hash, so this was compared fact by fact rather than by hash. ${report.errors.length} facts differ.`,
    'Re-run `opengeo generate` (+4).',
  );
}

/**
 * "3 days ago", "today". Undefined when there is no usable last_updated to report.
 *
 * @param {string | undefined} lastUpdated
 * @returns {string | undefined}
 */
function describeAge(lastUpdated) {
  if (!lastUpdated) return undefined;
  const then = Date.parse(lastUpdated);
  if (Number.isNaN(then)) return undefined;
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  return `${Math.floor(days / 30)} months ago`;
}
