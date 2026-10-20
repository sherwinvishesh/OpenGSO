import { AI_BOTS, identifyBot } from '../shared/bots.js';
import { isMarkdownPath, normalizeRoute, twinUrlPathToRoute } from '../shared/routes.js';

/** @import { AiBot } from '../shared/bots.js' */

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

/** @typedef {'human' | 'routed-ai' | 'unrouted-bot'} VisitorKind */

/**
 * @typedef {object} AcceptSummary
 * @property {boolean} absent No Accept header at all - treated as `*` / `*`, the same as a plain
 *   HTTP client.
 * @property {boolean} acceptsHtml
 * @property {boolean} acceptsMarkdown
 * @property {boolean} prefersMarkdown Markdown explicitly listed and ranked at least as high as HTML.
 */

/**
 * @typedef {object} Classification
 * @property {VisitorKind} kind
 * @property {AiBot} [bot]
 * @property {AcceptSummary} accept
 * @property {string} route Canonical route being asked for, with any `.md` suffix already resolved
 *   away.
 * @property {boolean} explicitTwin True when the request targeted the markdown twin URL directly
 *   (`/resume.md`).
 * @property {'markdown' | 'html' | 'not-acceptable'} serve What prod should do.
 * @property {string} reason Plain-language reason, surfaced by `opengso prod test`.
 */

/**
 * @typedef {object} AcceptEntry
 * @property {string} type
 * @property {string} subtype
 * @property {number} q
 */

/**
 * @param {string | null | undefined} header
 * @returns {AcceptEntry[]}
 */
export function parseAccept(header) {
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

/**
 * @param {AcceptEntry[]} entries
 * @param {string} type
 * @param {string} subtype
 * @returns {number}
 */
function qualityFor(entries, type, subtype) {
  let best = -1;
  for (const entry of entries) {
    const typeMatch = entry.type === '*' || entry.type === type;
    const subtypeMatch = entry.subtype === '*' || entry.subtype === subtype;
    if (typeMatch && subtypeMatch) best = Math.max(best, entry.q);
  }
  return best;
}

/**
 * Exact (non-wildcard) match, used to tell "explicitly asked for markdown" from "accepts anything".
 *
 * @param {AcceptEntry[]} entries
 * @param {string} type
 * @param {string} subtype
 * @returns {number}
 */
function explicitQualityFor(entries, type, subtype) {
  let best = -1;
  for (const entry of entries) {
    if (entry.type === type && entry.subtype === subtype) best = Math.max(best, entry.q);
  }
  return best;
}

/**
 * @param {string | null | undefined} header
 * @returns {AcceptSummary}
 */
export function summarizeAccept(header) {
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

/**
 * @typedef {object} ClassifyInput
 * @property {string} pathname
 * @property {string | null} [userAgent]
 * @property {string | null} [accept]
 * @property {readonly string[]} markdownRouting Bot names from `bots.markdownRouting` - lever 1.
 *   Never used to block anything.
 * @property {readonly AiBot[]} [bots] The crawler catalogue to recognise User-Agents against.
 *   Defaults to the shipped list; a project with `bots.custom` entries passes the resolved list so
 *   its own crawlers are routable too.
 */

/**
 * @param {ClassifyInput} input
 * @returns {Classification}
 */
export function classify(input) {
  const accept = summarizeAccept(input.accept);
  const explicitTwin = isMarkdownPath(input.pathname);
  const route = explicitTwin
    ? twinUrlPathToRoute(input.pathname) ?? normalizeRoute(input.pathname)
    : normalizeRoute(input.pathname);

  const bot = identifyBot(input.userAgent, input.bots ?? AI_BOTS);
  const routed = Boolean(bot && input.markdownRouting.some((name) => name.toLowerCase() === bot.name.toLowerCase()));
  /** @type {VisitorKind} */
  const kind = routed ? 'routed-ai' : bot ? 'unrouted-bot' : 'human';

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
