import type { AiBot } from '../shared/bots.js';
import { AI_BOTS, identifyBot } from '../shared/bots.js';
import { isMarkdownPath, normalizeRoute, twinUrlPathToRoute } from '../shared/routes.js';

/**
 * Visitor classification and content negotiation (§7).
 *
 * Two rules this module exists to guarantee:
 *  1. An unrecognised bot is treated exactly like a human. Never blocked, never special-cased.
 *     New AI products launch constantly; blocking unknowns by default would wall a site off from
 *     every one of them until this repo's bot list catches up.
 *  2. Markdown and HTML are the same content in two formats at the same URL. Nothing here can
 *     serve substantively different content to bots, which would be cloaking.
 */

export type VisitorKind = 'human' | 'routed-ai' | 'unrouted-bot';

export interface AcceptSummary {
  /** No Accept header at all - treated as `*` / `*`, the same as a plain HTTP client. */
  absent: boolean;
  acceptsHtml: boolean;
  acceptsMarkdown: boolean;
  /** Markdown explicitly listed and ranked at least as high as HTML. */
  prefersMarkdown: boolean;
}

export interface Classification {
  kind: VisitorKind;
  bot?: AiBot;
  accept: AcceptSummary;
  /** Canonical route being asked for, with any `.md` suffix already resolved away. */
  route: string;
  /** True when the request targeted the markdown twin URL directly (`/resume.md`). */
  explicitTwin: boolean;
  /** What prod should do. */
  serve: 'markdown' | 'html' | 'not-acceptable';
  /** Plain-language reason, surfaced by `opengeo prod test`. */
  reason: string;
}

interface AcceptEntry {
  type: string;
  subtype: string;
  q: number;
}

export function parseAccept(header: string | null | undefined): AcceptEntry[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [media = '', ...params] = part.split(';').map((p) => p.trim());
      const [type = '*', subtype = '*'] = media.split('/');
      const qParam = params.find((p) => p.toLowerCase().startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
      return {
        type: type.toLowerCase(),
        subtype: subtype.toLowerCase(),
        q: Number.isFinite(q) ? Math.min(Math.max(q, 0), 1) : 1,
      };
    });
}

function qualityFor(entries: AcceptEntry[], type: string, subtype: string): number {
  let best = -1;
  for (const entry of entries) {
    const typeMatch = entry.type === '*' || entry.type === type;
    const subtypeMatch = entry.subtype === '*' || entry.subtype === subtype;
    if (typeMatch && subtypeMatch) best = Math.max(best, entry.q);
  }
  return best;
}

/** Exact (non-wildcard) match, used to tell "explicitly asked for markdown" from "accepts anything". */
function explicitQualityFor(entries: AcceptEntry[], type: string, subtype: string): number {
  let best = -1;
  for (const entry of entries) {
    if (entry.type === type && entry.subtype === subtype) best = Math.max(best, entry.q);
  }
  return best;
}

export function summarizeAccept(header: string | null | undefined): AcceptSummary {
  const entries = parseAccept(header);
  if (entries.length === 0) {
    return { absent: true, acceptsHtml: true, acceptsMarkdown: true, prefersMarkdown: false };
  }
  const html = Math.max(
    qualityFor(entries, 'text', 'html'),
    qualityFor(entries, 'application', 'xhtml+xml'),
  );
  const markdown = Math.max(qualityFor(entries, 'text', 'markdown'), qualityFor(entries, 'text', 'x-markdown'));
  const explicitMarkdown = Math.max(
    explicitQualityFor(entries, 'text', 'markdown'),
    explicitQualityFor(entries, 'text', 'x-markdown'),
  );
  return {
    absent: false,
    acceptsHtml: html > 0,
    acceptsMarkdown: markdown > 0,
    prefersMarkdown: explicitMarkdown > 0 && explicitMarkdown >= Math.max(html, 0),
  };
}

export interface ClassifyInput {
  pathname: string;
  userAgent?: string | null;
  accept?: string | null;
  /** Bot names from `bots.markdownRouting` - lever 1. Never used to block anything. */
  markdownRouting: readonly string[];
  /**
   * The crawler catalogue to recognise User-Agents against. Defaults to the shipped list; a project
   * with `bots.custom` entries passes the resolved list so its own crawlers are routable too.
   */
  bots?: readonly AiBot[];
}

export function classify(input: ClassifyInput): Classification {
  const accept = summarizeAccept(input.accept);
  const explicitTwin = isMarkdownPath(input.pathname);
  const route = explicitTwin
    ? twinUrlPathToRoute(input.pathname) ?? normalizeRoute(input.pathname)
    : normalizeRoute(input.pathname);

  const bot = identifyBot(input.userAgent, input.bots ?? AI_BOTS);
  const routed = Boolean(bot && input.markdownRouting.some((name) => name.toLowerCase() === bot.name.toLowerCase()));
  const kind: VisitorKind = routed ? 'routed-ai' : bot ? 'unrouted-bot' : 'human';

  if (!accept.acceptsHtml && !accept.acceptsMarkdown) {
    return {
      kind,
      bot,
      accept,
      route,
      explicitTwin,
      serve: 'not-acceptable',
      reason: 'The Accept header excludes both text/html and text/markdown, so there is no representation to send.',
    };
  }

  if (explicitTwin) {
    return accept.acceptsMarkdown
      ? {
          kind,
          bot,
          accept,
          route,
          explicitTwin,
          serve: 'markdown',
          reason: 'Request targeted the markdown twin URL directly.',
        }
      : {
          kind,
          bot,
          accept,
          route,
          explicitTwin,
          serve: 'not-acceptable',
          reason: 'The markdown twin URL was requested with an Accept header that excludes markdown.',
        };
  }

  if (accept.prefersMarkdown && accept.acceptsMarkdown) {
    return {
      kind,
      bot,
      accept,
      route,
      explicitTwin,
      serve: 'markdown',
      reason: 'Accept header explicitly asked for text/markdown.',
    };
  }

  if (routed && bot) {
    return {
      kind,
      bot,
      accept,
      route,
      explicitTwin,
      serve: 'markdown',
      reason: `User-Agent matched ${bot.name}, which is on the markdown routing list.`,
    };
  }

  return {
    kind,
    bot,
    accept,
    route,
    explicitTwin,
    serve: 'html',
    reason: bot
      ? `User-Agent matched ${bot.name}, which is not on the markdown routing list - served the normal site, never blocked.`
      : 'Ordinary visitor - served the normal site unchanged.',
  };
}
