import { c, heading, SYM } from '../shared/log.js';
import type { ProdProbe, ProdVerification } from './verify.js';

/**
 * Terminal rendering for `opengeo prod test`.
 *
 * The section headings are the point of the output. A user who reads nothing else should come away
 * knowing that routing and blocking are two different things, and which one they are looking at.
 */

export interface VerifyReportOptions {
  /** Show the exact curl for every probe and the headers that came back. */
  verbose?: boolean;
}

export function renderProdVerification(result: ProdVerification, options: VerifyReportOptions = {}): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`${c.bold('OpenGEO')} ${c.gray('prod test')}  ${result.target}`);
  lines.push('');
  lines.push(`  ${summaryLine(result)}`);

  if (!result.installed) {
    lines.push('');
    lines.push(`  ${c.red('No X-AEO-Version on any response.')}`);
    lines.push(`  ${c.gray('opengeo-prod is not answering at this URL. Everything below follows from that.')}`);
  }

  const routing = result.probes.filter((p) => p.lever === 'routing');
  const negotiation = result.probes.filter((p) => p.lever === 'negotiation');

  lines.push(heading('Lever 1 - markdown routing (bots.markdownRouting)'));
  lines.push(`  ${c.gray('Decides which AI agents get the twin. It chooses a format, never access.')}`);
  for (const probe of routing) lines.push(...renderProbe(probe, options));

  lines.push(heading('Content negotiation'));
  lines.push(`  ${c.gray('The same URL in two formats, decided by the Accept header.')}`);
  for (const probe of negotiation) lines.push(...renderProbe(probe, options));

  lines.push(heading('Lever 2 - blocking (bots.blocked, via robots.txt)'));
  lines.push(`  ${c.gray('Separate, opt-in, and written by generate. prod has no blocking code path.')}`);
  lines.push('');
  lines.push(
    result.robots.found
      ? `  ${SYM.pass()} ${c.bold('robots.txt')} ${c.gray(result.robots.url)}`
      : `  ${SYM.na()} ${c.bold('robots.txt')} ${c.gray(result.robots.url)}`,
  );
  for (const note of result.robots.notes) lines.push(`      ${note}`);

  if (result.conflicts.length > 0) {
    lines.push(heading('The two levers disagree'));
    for (const conflict of result.conflicts) lines.push(`  ${c.yellow(conflict)}`);
  }

  lines.push('');
  if (result.counts.fail > 0) {
    lines.push(c.gray(`Run \`opengeo test ${result.target}\` for the full 0-100 audit of this page.`));
    lines.push('');
  }
  return lines.join('\n');
}

function summaryLine(result: ProdVerification): string {
  const parts = [c.green(`${result.counts.pass} passed`)];
  if (result.counts.warn > 0) parts.push(c.yellow(`${result.counts.warn} warned`));
  parts.push(result.counts.fail > 0 ? c.red(`${result.counts.fail} failed`) : c.gray('0 failed'));
  return `${parts.join(c.gray(', '))}  ${c.gray(`impersonating ${result.bot}`)}`;
}

function renderProbe(probe: ProdProbe, options: VerifyReportOptions): string[] {
  const symbol = probe.verdict === 'pass' ? SYM.pass() : probe.verdict === 'warn' ? SYM.warn() : SYM.fail();
  const status = probe.status > 0 ? c.gray(`  ${probe.status}`) : '';
  const lines = ['', `  ${symbol} ${c.bold(probe.id)} ${probe.title}${status}`, `      ${probe.reason}`];
  if (probe.detail) lines.push(`      ${c.gray(probe.detail)}`);
  if (options.verbose) {
    lines.push(`      ${c.gray(probe.curl)}`);
    for (const [name, value] of Object.entries(probe.headers)) {
      lines.push(`      ${c.gray(`${name}: ${value}`)}`);
    }
  }
  return lines;
}

/** Machine-readable output for `--json` and for the product website's local API. */
export function prodVerificationToJson(result: ProdVerification): string {
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

function probeJson(probe: ProdProbe) {
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
