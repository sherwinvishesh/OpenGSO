import { c, heading, SYM, terminalSafe } from '../shared/log.js';
import { indentWrapped, terminalWidth, wrap as wrapText } from '../shared/render/paint.js';
import { ink } from '../shared/render/theme.js';
import { meter } from '../shared/render/meters.js';

/** @import { ProdProbe, ProdVerification } from './verify.js' */

/**
 * Terminal rendering for `opengso prod test`.
 *
 * The section headings are the point of the output. A user who reads nothing else should come away
 * knowing that routing and blocking are two different things, and which one they are looking at.
 */

/**
 * @typedef {object} VerifyReportOptions
 * @property {boolean} [verbose] Show the exact curl for every probe and the headers that came back.
 * @property {number} [width] Overrides the terminal width. Only the tests pass this.
 */

/**
 * @param {ProdVerification} result
 * @param {VerifyReportOptions} [options]
 * @returns {string}
 */
export function renderProdVerification(result, options = {}) {
  result = terminalSafe(result);
  const width = options.width ?? terminalWidth();
  /** @type {string[]} */
  const lines = [];

  lines.push('');
  lines.push(`${c.bold('OpenGSO')} ${c.gray('prod test')}  ${result.target}`);
  lines.push('');
  lines.push(`  ${summaryLine(result)}`);

  if (!result.installed) {
    lines.push('');
    lines.push(`  ${ink.danger('No X-AEO-Version on any response.')}`);
    lines.push(...indentWrapped('opengso-prod is not answering at this URL. Everything below follows from that.', width, c.gray));
  }

  const routing = result.probes.filter((p) => p.lever === 'routing');
  const negotiation = result.probes.filter((p) => p.lever === 'negotiation');

  lines.push(heading('Lever 1 - markdown routing (bots.markdownRouting)'));
  lines.push(`  ${c.gray('Decides which AI agents get the twin. It chooses a format, never access.')}`);
  for (const probe of routing) lines.push(...renderProbe(probe, options, width));

  lines.push(heading('Content negotiation'));
  lines.push(`  ${c.gray('The same URL in two formats, decided by the Accept header.')}`);
  for (const probe of negotiation) lines.push(...renderProbe(probe, options, width));

  lines.push(heading('Lever 2 - blocking (bots.blocked, via robots.txt)'));
  lines.push(`  ${c.gray('Separate, opt-in, and written by generate. prod has no blocking code path.')}`);
  lines.push('');
  lines.push(
    result.robots.found
      ? `  ${SYM.pass()} ${c.bold('robots.txt')} ${c.gray(result.robots.url)}`
      : `  ${SYM.na()} ${c.bold('robots.txt')} ${c.gray(result.robots.url)}`,
  );
  for (const note of result.robots.notes) lines.push(...indentWrapped(note, width));

  if (result.conflicts.length > 0) {
    lines.push(heading('The two levers disagree'));
    for (const conflict of result.conflicts) lines.push(...wrapText(conflict, width - 2).map((line) => `  ${ink.warn(line)}`));
  }

  lines.push('');
  if (result.counts.fail > 0) {
    lines.push(c.gray(`Run \`opengso test ${result.target}\` for the full 0-100 audit of this page.`));
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The one-line verdict, with the same meter the 0-100 report uses.
 *
 * This command has no score, so the bar reads share of probes passed rather than points. It is the
 * same glyphs and the same colour ramp on purpose: two commands in one product should not have two
 * visual languages for "how did that go".
 *
 * @param {ProdVerification} result
 * @returns {string}
 */
function summaryLine(result) {
  const total = result.counts.pass + result.counts.warn + result.counts.fail;
  const share = total === 0 ? 0 : (result.counts.pass / total) * 100;
  const parts = [ink.ok(`${result.counts.pass} passed`)];
  if (result.counts.warn > 0) parts.push(ink.warn(`${result.counts.warn} warned`));
  parts.push(result.counts.fail > 0 ? ink.danger(`${result.counts.fail} failed`) : c.gray('0 failed'));
  return `${meter(share, 18)}  ${parts.join(c.gray(', '))}  ${c.gray(`impersonating ${result.bot}`)}`;
}

/**
 * @param {ProdProbe} probe
 * @param {VerifyReportOptions} options
 * @param {number} width
 * @returns {string[]}
 */
function renderProbe(probe, options, width) {
  const symbol = probe.verdict === 'pass' ? SYM.pass() : probe.verdict === 'warn' ? SYM.warn() : SYM.fail();
  const status = probe.status > 0 ? c.gray(`  ${probe.status}`) : '';
  const lines = ['', `  ${symbol} ${c.bold(probe.id)} ${probe.title}${status}`];
  lines.push(...indentWrapped(probe.reason, width));
  if (probe.detail) lines.push(...indentWrapped(probe.detail, width, c.gray));
  if (options.verbose) {
    lines.push(`      ${c.gray(probe.curl)}`);
    for (const [name, value] of Object.entries(probe.headers)) {
      lines.push(`      ${c.gray(`${name}: ${value}`)}`);
    }
  }
  return lines;
}

/**
 * Machine-readable output for `--json` and for the product website's local API.
 *
 * @param {ProdVerification} result
 * @returns {string}
 */
export function prodVerificationToJson(result) {
  return JSON.stringify(
    {
      target: result.target,
      twinUrl: result.twinUrl,
      bot: result.bot,
      installed: result.installed,
      ok: result.ok,
      counts: result.counts,
      levers: {
        // Named rather than implied, because the whole command exists to keep these apart.
        routing: {
          setting: 'bots.markdownRouting',
          description: 'Which AI agents receive the markdown twin. Never blocks anyone.',
          probes: result.probes.filter((p) => p.lever === 'routing').map(probeJson),
        },
        negotiation: {
          setting: null,
          description: 'The same URL in two formats, decided by the Accept header.',
          probes: result.probes.filter((p) => p.lever === 'negotiation').map(probeJson),
        },
        blocking: {
          setting: 'bots.blocked',
          description: 'Opt-in robots.txt disallow list, written by generate. prod never blocks.',
          robots: result.robots,
        },
      },
      conflicts: result.conflicts,
    },
    null,
    2,
  );
}

/** @param {ProdProbe} probe */
function probeJson(probe) {
  return {
    id: probe.id,
    title: probe.title,
    verdict: probe.verdict,
    status: probe.status,
    reason: probe.reason,
    detail: probe.detail,
    sent: probe.sent,
    headers: probe.headers,
    curl: probe.curl,
  };
}
