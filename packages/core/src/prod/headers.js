import { AEO_SPEC_VERSION, HEADERS, MARKDOWN_CONTENT_TYPE } from '../shared/version.js';
import { routeToTwinUrlPath } from '../shared/routes.js';

/**
 * The response-header contract from §7, which is the same contract test's category B checks
 * against (§5B). Both sides import this module, so the implementation and the audit can never
 * disagree about a header name or value.
 */

/**
 * @typedef {object} MarkdownHeaderInput
 * @property {number} tokens
 * @property {string} [specVersion]
 * @property {string} [lastUpdated] ISO timestamp from the manifest. Emitted as a standard
 *   `Last-Modified`.
 * @property {string} [sourceHash] Hash of the HTML the twin was built from, so `test`'s B14 check
 *   can detect drift exactly.
 * @property {boolean} [selectedByUserAgent] True when the User-Agent, not Accept or the URL, is what
 *   chose markdown. `Vary: Accept` cannot describe that, so the response is kept out of shared
 *   caches instead.
 * @property {string} [etag] The store's validator for the body, already quoted.
 */

/**
 * @param {MarkdownHeaderInput} input
 * @returns {Record<string, string>}
 */
export function markdownHeaders(input) {
  /** @type {Record<string, string>} */
  const headers = {
    [HEADERS.contentType]: MARKDOWN_CONTENT_TYPE,
    [HEADERS.markdownTokens]: String(Math.max(1, Math.trunc(input.tokens))),
    [HEADERS.contentTypeOptions]: 'nosniff',
    // Keeps the twin out of search indexes so it is never treated as duplicate content.
    [HEADERS.robotsTag]: 'noindex',
    // Required on every response, not just markdown ones: a CDN that caches the HTML variant
    // without it will happily serve that HTML to the next agent asking for markdown, and vice versa.
    [HEADERS.vary]: 'Accept',
    [HEADERS.aeoVersion]: input.specVersion ?? AEO_SPEC_VERSION,
  };
  // Provenance, so an auditor does not have to trust the body. Both are omitted rather than faked
  // when the manifest has nothing to report: a wrong Last-Modified is worse than none.
  const lastModified = httpDate(input.lastUpdated);
  if (lastModified) headers[HEADERS.lastModified] = lastModified;
  if (input.sourceHash) headers[HEADERS.markdownSourceHash] = input.sourceHash;
  if (input.etag) headers[HEADERS.etag] = input.etag;
  // A shared cache keyed on Accept would hand this body to the next plain `*/*` client. Varying on
  // User-Agent instead would split the cache for every browser build, so this one response opts out.
  if (input.selectedByUserAgent) headers[HEADERS.cacheControl] = 'private';
  return headers;
}

/**
 * RFC 7231 IMF-fixdate, or undefined when the input is missing or unparseable.
 *
 * @param {string | undefined} iso
 * @returns {string | undefined}
 */
export function httpDate(iso) {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toUTCString();
}

/**
 * @typedef {object} Preconditions
 * @property {string | null} ifNoneMatch
 * @property {string | null} ifModifiedSince
 */

/**
 * Whether a conditional GET can be answered with 304, per RFC 9110 section 13.
 *
 * `If-None-Match` wins whenever it is present, and compares weakly, so a CDN that rewrote the tag
 * as `W/` still revalidates. `If-Modified-Since` is only consulted without it, at the one-second
 * resolution an HTTP date has, and a date in the future is ignored rather than trusted.
 *
 * @param {Preconditions} request
 * @param {{ etag?: string, lastUpdated?: string }} doc
 * @param {number} [now]
 * @returns {boolean}
 */
export function isNotModified(request, doc, now = Date.now()) {
  if (request.ifNoneMatch !== null) {
    if (!doc.etag) return false;
    const current = weak(doc.etag);
    return request.ifNoneMatch.split(',').some((tag) => tag.trim() === '*' || weak(tag.trim()) === current);
  }
  if (!request.ifModifiedSince || !doc.lastUpdated) return false;
  const since = Date.parse(request.ifModifiedSince);
  const modified = Date.parse(doc.lastUpdated);
  if (Number.isNaN(since) || Number.isNaN(modified) || since > now) return false;
  return Math.floor(modified / 1000) * 1000 <= since;
}

/** @param {string} tag */
const weak = (tag) => (tag.startsWith('W/') ? tag.slice(2) : tag);

/**
 * The headers a 304 keeps from the 200 it stands in for: the ones a cache uses to update what it
 * holds. The body's own metadata (type, token count) stays with the body.
 */
/** @type {readonly string[]} */
const KEPT_ON_304 = [HEADERS.etag, HEADERS.vary, HEADERS.lastModified, HEADERS.cacheControl, HEADERS.robotsTag, HEADERS.aeoVersion];

/**
 * @param {Record<string, string>} headers The full markdown headers.
 * @returns {Record<string, string>}
 */
export function notModifiedHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => KEPT_ON_304.includes(name)));
}

/**
 * @typedef {object} HtmlHeaderInput
 * @property {string} route
 * @property {string} [specVersion]
 * @property {boolean} hasTwin When true, advertise the twin. Omitted for routes with no generated
 *   markdown.
 */

/**
 * @param {HtmlHeaderInput} input
 * @returns {Record<string, string>}
 */
export function htmlHeaders(input) {
  /** @type {Record<string, string>} */
  const headers = {
    [HEADERS.vary]: 'Accept',
    [HEADERS.aeoVersion]: input.specVersion ?? AEO_SPEC_VERSION,
  };
  if (input.hasTwin) {
    headers[HEADERS.link] = linkAlternate(routeToTwinUrlPath(input.route));
  }
  return headers;
}

/**
 * @param {string} twinPath
 * @returns {string}
 */
export function linkAlternate(twinPath) {
  return `<${twinPath}>; rel="alternate"; type="text/markdown"`;
}

/**
 * @param {string} [specVersion]
 * @returns {Record<string, string>}
 */
export function notAcceptableHeaders(specVersion = AEO_SPEC_VERSION) {
  return {
    [HEADERS.contentType]: 'text/plain; charset=utf-8',
    [HEADERS.vary]: 'Accept',
    [HEADERS.aeoVersion]: specVersion,
  };
}

export const NOT_ACCEPTABLE_BODY = [
  '406 Not Acceptable',
  '',
  'This URL can be served as text/html or text/markdown.',
  'Your Accept header asked for neither.',
].join('\n');

/**
 * `Vary` is a comma-separated list of field names, so this has to compare whole tokens. Matching
 * the substring "accept" would count `Vary: Accept-Encoding` - which almost every compressed
 * response carries - as a pass, and no real site would ever fail the check.
 *
 * It lives here, beside the code that writes the header, so the audit and the implementation can
 * never disagree about what counts.
 *
 * @param {string | null | undefined} value
 * @returns {boolean}
 */
export function varyIncludesAccept(value) {
  return (value ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .some((token) => token === 'accept' || token === '*');
}

/**
 * Parse a `Link` header and pull out the markdown alternate, if one is advertised.
 *
 * @param {string | null | undefined} header
 * @returns {string | undefined}
 */
export function parseLinkAlternate(header) {
  if (!header) return undefined;
  for (const part of splitLinkHeader(header)) {
    const url = /<([^>]+)>/.exec(part)?.[1];
    if (!url) continue;
    const lowered = part.toLowerCase();
    if (!lowered.includes('rel="alternate"') && !lowered.includes('rel=alternate')) continue;
    if (lowered.includes('text/markdown')) return url;
  }
  return undefined;
}

/**
 * Split on commas that separate link-values, not commas inside angle brackets or quotes.
 *
 * @param {string} header
 * @returns {string[]}
 */
function splitLinkHeader(header) {
  /** @type {string[]} */
  const parts = [];
  let current = '';
  let inAngle = false;
  let inQuote = false;
  for (const ch of header) {
    if (ch === '<') inAngle = true;
    else if (ch === '>') inAngle = false;
    else if (ch === '"') inQuote = !inQuote;
    if (ch === ',' && !inAngle && !inQuote) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
