import { HEADERS, MARKDOWN_CONTENT_TYPE } from '../shared/version.js';
import { HOSTILE_ACCEPT, isMarkdownResponse } from '../shared/http.js';
import { varyIncludesAccept } from '../prod/headers.js';
import { countWords } from '../shared/tokens.js';
import { checkDefinition } from './checks.js';
import { fail, partial, pass, ramp } from './checks.js';
import { servesFile } from './checks-site.js';
import { liveExtract } from './live-page.js';

/**
 * @import { CheckResult } from './checks.js'
 * @import { Evidence } from './evidence.js'
 * @import { ProbeResult } from '../shared/http.js'
 */

/**
 * Category B: the markdown twin and how it is served, B1 to B13 (§5). Pure over `Evidence`.
 */

/**
 * How much shorter than the live page a twin may be and still count as complete.
 *
 * Markdown is denser than rendered text, and a good twin drops navigation, cookie banners and
 * footers, so it is legitimately shorter. Half is generous on purpose: this check is looking for a
 * stub, not auditing prose.
 */
export const TWIN_FULL_RATIO = 0.5;
export const TWIN_FLOOR_RATIO = 0.08;

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
export function checkTwinReachable(e) {
  if (e.twin.error)
    return fail(
      'B1',
      `Could not reach the markdown twin at ${e.twinUrl}: ${e.twin.error}`,
      undefined,
      `Serve a markdown twin at ${e.twinUrl} (+10). \`opengeo generate\` writes it and the prod middleware serves it.`,
    );
  if (!e.twin.ok) {
    return fail(
      'B1',
      `The markdown twin at ${e.twinUrl} returned HTTP ${e.twin.status}. Agents that follow the .md convention get nothing.`,
      undefined,
      `Serve a markdown twin at ${e.twinUrl} (+10). \`opengeo generate\` writes it and the prod middleware serves it.`,
    );
  }
  if (!servesFile(e.twin)) {
    return fail(
      'B1',
      `The markdown twin URL ${e.twinUrl} answered HTTP ${e.twin.status} with an HTML page, not markdown. A catch-all route or the page renderer is handling the .md URL.`,
      undefined,
      `Route ${e.twinUrl} to the markdown twin, ahead of the page renderer (+10). \`opengeo generate\` writes it and the prod middleware serves it.`,
    );
  }
  return pass('B1', `The markdown twin at ${e.twinUrl} returned HTTP ${e.twin.status}.`);
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
export function checkTwinContentType(e) {
  const actual = e.twin.headers.get(HEADERS.contentType);
  if (!e.twin.ok)
    return fail(
      'B2',
      `No markdown twin response to inspect (HTTP ${e.twin.status || 'unreachable'}).`,
      undefined,
      'Fix B1 first: there is no twin response to read a Content-Type from (+5).',
    );
  if (!actual)
    return fail(
      'B2',
      'The markdown twin response has no Content-Type header at all.',
      undefined,
      `Send \`${MARKDOWN_CONTENT_TYPE}\` on the twin response (+5).`,
    );
  const normalized = actual.toLowerCase().replace(/\s*;\s*/g, '; ').trim();
  if (normalized === MARKDOWN_CONTENT_TYPE) return pass('B2', `Content-Type is exactly ${MARKDOWN_CONTENT_TYPE}.`);
  // The type is right and only the charset is missing. Every agent that matches on the media type
  // is already satisfied; what is left is the one that has to guess the encoding.
  if (normalized.startsWith('text/markdown')) {
    return partial('B2', 3, `Content-Type is "${actual}": the media type is right, but it does not declare "charset=utf-8", so the encoding is left to be guessed.`, {
      fix: `Send exactly \`${MARKDOWN_CONTENT_TYPE}\` (+2).`,
    });
  }
  // text/plain at least stops a browser rendering the markdown as HTML, so it is a smaller error
  // than text/html, but no agent selects on it and none will treat the body as markdown.
  if (normalized.startsWith('text/plain')) {
    return partial('B2', 2, `Content-Type is "${actual}", not "${MARKDOWN_CONTENT_TYPE}". The body will be read as plain text, so nothing selecting on the markdown type will find it.`, {
      fix: `Send \`${MARKDOWN_CONTENT_TYPE}\` (+3).`,
    });
  }
  return fail(
    'B2',
    `Content-Type is "${actual}", not "${MARKDOWN_CONTENT_TYPE}". Agents sniffing the type may treat the body as HTML or plain text.`,
    undefined,
    `Send \`${MARKDOWN_CONTENT_TYPE}\` on the twin response (+5).`,
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
export function checkTwinNonEmpty(e) {
  if (!e.twin.ok)
    return fail(
      'B3',
      `No markdown twin response to inspect (HTTP ${e.twin.status || 'unreachable'}).`,
      undefined,
      'Fix B1 first: there is no twin response to read a body from (+5).',
    );
  const body = e.twin.body.trim();
  if (!body)
    return fail(
      'B3',
      'The markdown twin responded 2xx with an empty body.',
      undefined,
      'Regenerate the twin: the route answers, but with nothing in it (+5).',
    );
  // Non-empty is the letter of the check; complete is the point of it. A twin holding a title and
  // nothing else is technically a body and is useless to the agent that fetched it, so the credit
  // slides with how much of the page actually made it across.
  const twinWords = countWords(body);
  const live = e.html.ok && e.html.body ? liveExtract(e) : undefined;
  const liveWords = live?.wordCount ?? 0;
  const complete = liveWords === 0 || twinWords >= liveWords * TWIN_FULL_RATIO;
  if (complete) return pass('B3', `The markdown twin returned ${body.length} characters of markdown.`);

  const weight = checkDefinition('B3').weight;
  const ratio = twinWords / liveWords;
  const earned = ramp(ratio, TWIN_FLOOR_RATIO, TWIN_FULL_RATIO, weight);
  return partial(
    'B3',
    earned,
    `The twin is ${twinWords} words against the live page's ${liveWords}, so most of the page did not make it into the markdown.`,
    {
      detail: `${Math.round(ratio * 100)}% of the extractable text.`,
      fix: `Regenerate the twin from the live page so it carries the whole body (+${weight - Math.round(earned)}).`,
    },
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
export function checkTokensHeader(e) {
  const raw = e.twin.headers.get(HEADERS.markdownTokens);
  if (!raw) {
    return fail(
      'B4',
      `No ${HEADERS.markdownTokens} header, so an agent cannot gauge the response size before fetching it.`,
      undefined,
      `Send \`${HEADERS.markdownTokens}\` with the token count of the body (+3). The prod middleware sets it from the manifest.`,
    );
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fail(
      'B4',
      `${HEADERS.markdownTokens} is "${raw}", which is not a positive integer.`,
      undefined,
      `Send \`${HEADERS.markdownTokens}\` as a plain positive integer (+3).`,
    );
  }
  return pass('B4', `${HEADERS.markdownTokens}: ${value}.`);
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
export function checkNosniff(e) {
  const value = e.twin.headers.get(HEADERS.contentTypeOptions);
  if (value?.toLowerCase().trim() === 'nosniff') return pass('B5', 'X-Content-Type-Options: nosniff is set on the markdown response.');
  return fail(
    'B5',
    value ? `X-Content-Type-Options is "${value}", not "nosniff".` : 'No X-Content-Type-Options header on the markdown response.',
    undefined,
    'Add `X-Content-Type-Options: nosniff` to the twin response (+3).',
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
export function checkTwinNoindex(e) {
  const value = e.twin.headers.get(HEADERS.robotsTag);
  if (!value) {
    return fail(
      'B6',
      'No X-Robots-Tag on the markdown twin, so search engines may index it as duplicate content alongside the HTML page.',
      undefined,
      'Add `X-Robots-Tag: noindex` to the twin response (+3).',
    );
  }
  if (!/\bnoindex\b/i.test(value)) {
    return partial('B6', 1, `X-Robots-Tag is "${value}" and does not include noindex, so the twin can still be indexed alongside the HTML page as duplicate content.`, {
      fix: 'Add `noindex` to the twin\'s X-Robots-Tag (+2).',
    });
  }
  return pass('B6', `X-Robots-Tag includes noindex ("${value}").`);
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
export function checkVaryAccept(e) {
  const htmlVary = e.html.headers.get(HEADERS.vary) ?? '';
  const twinVary = e.twin.headers.get(HEADERS.vary) ?? '';
  const htmlOk = varyIncludesAccept(htmlVary);
  const twinOk = varyIncludesAccept(twinVary);

  if (htmlOk && twinOk) return pass('B7', 'Vary: Accept is set on both the HTML and the markdown response.');
  const missing = [!htmlOk ? 'the HTML response' : null, !twinOk ? 'the markdown response' : null].filter(Boolean);
  const detail = `HTML Vary: "${htmlVary || 'absent'}"; markdown Vary: "${twinVary || 'absent'}".`;

  // One side set is a materially better position than neither: the format that carries the header
  // is cached correctly, and the poisoning risk is one-directional rather than both. It is also the
  // permanent state of a Next.js App Router deployment, where middleware cannot add a header to a
  // response it did not create, so calling it a total failure would be calling a framework limit a
  // defect on every single run.
  if (htmlOk || twinOk) {
    return partial('B7', 2, `Vary does not include Accept on ${missing.join(' or ')}. A CDN can cache that side's response and serve it to a visitor asking for the other format.`, {
      detail,
      fix: `Add \`Vary: Accept\` to ${missing.join(' and ')} (+2). Some frameworks will not let middleware set it on a response they created; a CDN or reverse-proxy rule in front of the app is the way through.`,
    });
  }
  return fail(
    'B7',
    `Vary does not include Accept on ${missing.join(' or ')}. A CDN will cache one format and serve it to visitors asking for the other.`,
    detail,
    'Add `Vary: Accept` to both responses (+4).',
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
export function checkLinkAlternate(e) {
  if (e.advertisedTwinUrl) {
    return pass('B8', `The HTML response advertises its markdown twin: Link rel="alternate" -> ${e.advertisedTwinUrl}`);
  }
  if (e.foreignTwinUrl) {
    return partial('B8', 1, `The HTML response advertises a markdown twin at ${e.foreignTwinUrl}, which is not on this site's origin, so OpenGEO did not fetch it and checked ${e.twinUrl} instead.`, {
      fix: `Point the Link header at the twin on this origin: \`<${e.twinUrl}>; rel="alternate"; type="text/markdown"\` (+2).`,
    });
  }
  const link = e.html.headers.get(HEADERS.link);
  if (link) {
    return partial('B8', 1, `The HTML response has a Link header ("${link}") but no rel="alternate" entry of type text/markdown, so an agent still has to guess the twin URL.`, {
      fix: `Add \`<${e.twinUrl}>; rel="alternate"; type="text/markdown"\` to the existing Link header (+2).`,
    });
  }
  return fail(
    'B8',
    'The HTML response has no Link rel="alternate" header, so an agent has to guess the markdown twin URL.',
    undefined,
    `Add \`Link: <${e.twinUrl}>; rel="alternate"; type="text/markdown"\` to the HTML response (+3).`,
  );
}

/**
 * Whether a negotiated response reached its markdown by redirect, which breaks the same-URL contract.
 *
 * Compared with where the browser's request landed rather than with the target, so a site that
 * redirects every request (a trailing slash, say) is not blamed for the markdown following suit.
 *
 * @param {ProbeResult} response
 * @param {Evidence} e
 */
function redirectedAway(response, e) {
  return response.redirected && response.finalUrl !== e.html.finalUrl;
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
export function checkAcceptNegotiation(e) {
  if (!e.acceptMarkdown.ok) {
    return fail(
      'B9',
      `A request with Accept: text/markdown returned HTTP ${e.acceptMarkdown.status || 'nothing'}.`,
      undefined,
      'Answer 2xx to a request carrying `Accept: text/markdown` (+6).',
    );
  }
  if (isMarkdownResponse(e.acceptMarkdown) && redirectedAway(e.acceptMarkdown, e)) {
    return fail(
      'B9',
      `A request with Accept: text/markdown was sent by redirect to ${e.acceptMarkdown.finalUrl} for its markdown. An agent that follows it cites that URL instead of the page.`,
      undefined,
      'Rewrite requests that prefer text/markdown to the twin instead of redirecting them, so the markdown is served at the same URL (+6). This is what the prod middleware does.',
    );
  }
  if (isMarkdownResponse(e.acceptMarkdown)) {
    return pass('B9', 'A request with Accept: text/markdown received markdown at the same URL.');
  }
  return fail(
    'B9',
    `A request with Accept: text/markdown received "${e.acceptMarkdown.headers.get(HEADERS.contentType) ?? 'no Content-Type'}" instead of markdown. Content negotiation is not wired up.`,
    undefined,
    'Rewrite requests that prefer text/markdown to the twin, at the same URL (+6). This is what the prod middleware does.',
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
export function checkBotUaNegotiation(e) {
  if (!e.botUa.ok)
    return fail(
      'B10',
      `A ${e.botName ?? 'GPTBot'}-identified request returned HTTP ${e.botUa.status || 'nothing'}.`,
      undefined,
      'Answer 2xx to a known AI bot User-Agent (+6). Check nothing upstream is rate limiting or blocking it.',
    );
  if (isMarkdownResponse(e.botUa) && redirectedAway(e.botUa, e)) {
    return fail(
      'B10',
      `A GPTBot User-Agent was sent by redirect to ${e.botUa.finalUrl} for its markdown. A crawler that follows it indexes that URL instead of the page.`,
      undefined,
      'Rewrite known AI bot User-Agents to the twin instead of redirecting them, so the markdown is served at the same URL (+6). Set `bots.markdownRouting` and let the middleware do it.',
    );
  }
  if (isMarkdownResponse(e.botUa)) {
    return pass('B10', 'A known AI bot User-Agent received markdown without needing to send an Accept header.');
  }
  return fail(
    'B10',
    `A ${e.botName ?? 'GPTBot'} User-Agent received "${e.botUa.headers.get(HEADERS.contentType) ?? 'no Content-Type'}". Most AI crawlers never send Accept: text/markdown, so User-Agent routing is what actually reaches them.`,
    undefined,
    'Route known AI bot User-Agents to the twin as well, not only Accept headers (+6). Set `bots.markdownRouting` and let the middleware do it.',
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
export function checkNotAcceptable(e) {
  if (e.notAcceptable.status === 406) {
    return pass('B11', 'An Accept header excluding both HTML and markdown correctly returned 406 Not Acceptable.');
  }
  return fail(
    'B11',
    `An Accept: ${HOSTILE_ACCEPT} request returned HTTP ${e.notAcceptable.status || 'nothing'} instead of 406 Not Acceptable.`,
    undefined,
    'Return 406 when the Accept header asks for a format the page cannot produce (+2).',
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
export function checkAeoVersion(e) {
  const value = e.twin.headers.get(HEADERS.aeoVersion) ?? e.acceptMarkdown.headers.get(HEADERS.aeoVersion);
  if (value) return pass('B12', `X-AEO-Version advertises "${value}".`);
  return fail(
    'B12',
    'No X-AEO-Version header, so an agent cannot tell which serving spec this site implements.',
    undefined,
    'Add `X-AEO-Version` to the twin response (+2). The prod middleware sets it for you.',
  );
}

/**
 * @param {Evidence} e
 * @returns {CheckResult}
 */
export function checkHtmlUnaffected(e) {
  if (!e.html.ok)
    return fail(
      'B13',
      `The original HTML URL returned HTTP ${e.html.status || 'nothing'}.`,
      undefined,
      'Get the HTML URL answering 2xx to a normal browser again (+9). Serving agents must never cost human visitors the page.',
    );
  const contentType = e.html.headers.get(HEADERS.contentType) ?? '';
  if (!contentType.toLowerCase().includes('text/html')) {
    return fail(
      'B13',
      `A normal browser request received "${contentType}" instead of HTML. Human visitors are being served the wrong format.`,
      undefined,
      'Serve markdown only to requests that asked for it (+9). A browser Accept header must still get HTML.',
    );
  }
  if (!e.html.body.trim())
    return fail(
      'B13',
      'The original HTML URL returned an empty body to a normal browser request.',
      undefined,
      'Return the real HTML page to a normal browser request (+9).',
    );
  return pass('B13', 'A normal browser request still receives the real HTML page, unchanged.');
}
