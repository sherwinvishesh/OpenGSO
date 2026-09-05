import { AEO_SPEC_VERSION, HEADERS, MARKDOWN_CONTENT_TYPE } from '../shared/version.js';
import { routeToTwinUrlPath } from '../shared/routes.js';

/**
 * The response-header contract from §7, which is the same contract test's category B checks
 * against (§5B). Both sides import this module, so the implementation and the audit can never
 * disagree about a header name or value.
 */

export interface MarkdownHeaderInput {
  tokens: number;
  specVersion?: string;
  /** ISO timestamp from the manifest. Emitted as a standard `Last-Modified`. */
  lastUpdated?: string;
  /** Hash of the HTML the twin was built from, so `test`'s B14 check can detect drift exactly. */
  sourceHash?: string;
}

export function markdownHeaders(input: MarkdownHeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
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
  return headers;
}

/** RFC 7231 IMF-fixdate, or undefined when the input is missing or unparseable. */
export function httpDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toUTCString();
}

export interface HtmlHeaderInput {
  route: string;
  specVersion?: string;
  /** When true, advertise the twin. Omitted for routes with no generated markdown. */
  hasTwin: boolean;
}

export function htmlHeaders(input: HtmlHeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
    [HEADERS.vary]: 'Accept',
    [HEADERS.aeoVersion]: input.specVersion ?? AEO_SPEC_VERSION,
  };
  if (input.hasTwin) {
    headers[HEADERS.link] = linkAlternate(routeToTwinUrlPath(input.route));
  }
  return headers;
}

export function linkAlternate(twinPath: string): string {
  return `<${twinPath}>; rel="alternate"; type="text/markdown"`;
}

export function notAcceptableHeaders(specVersion = AEO_SPEC_VERSION): Record<string, string> {
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
 */
export function varyIncludesAccept(value: string | null | undefined): boolean {
  return (value ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .some((token) => token === 'accept' || token === '*');
}

/** Parse a `Link` header and pull out the markdown alternate, if one is advertised. */
export function parseLinkAlternate(header: string | null | undefined): string | undefined {
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

/** Split on commas that separate link-values, not commas inside angle brackets or quotes. */
function splitLinkHeader(header: string): string[] {
  const parts: string[] = [];
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
