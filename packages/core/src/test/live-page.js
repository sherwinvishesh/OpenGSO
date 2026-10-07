import { JSDOM } from 'jsdom';
import { extractPage } from '../generate/extract.js';

/**
 * @import { Evidence } from './evidence.js'
 * @import { ProbeResult } from '../shared/http.js'
 * @import { ExtractedPage } from '../generate/extract.js'
 */

/**
 * The live page, parsed once per run and shared by the checks that read it.
 */

/** Below this word count, a page's raw HTML is not meaningfully extractable without running JS. */
export const SSR_MIN_WORDS = 60;

/**
 * A4 and A7 both read the live page's markup as it arrived, without changing it, so they share one
 * parse. It is made on first use, so a run with no HTML body never parses, and closed when the run
 * ends. Extraction cannot share it: it strips the document as it goes.
 *
 * @param {Evidence} e
 * @returns {{ get: () => Document; close: () => void }}
 */
export function rawDocument(e) {
  /** @type {JSDOM | undefined} */
  let dom;
  return {
    get: () => {
      dom ??= new JSDOM(e.html.body, { url: e.target.toString() });
      return dom.window.document;
    },
    close: () => dom?.window.close(),
  };
}

/**
 * A5, B3 and B14 all read the live page's extracted content, with the same options, and extraction
 * is a full JSDOM parse plus Readability. One extraction per page serves all three.
 *
 * Keyed on the response and checked against the body and URL it was made from, because evidence is
 * a plain object and nothing stops a caller swapping either between runs.
 *
 * @type {WeakMap<ProbeResult, { body: string; url: string; extracted: ExtractedPage }>}
 */
const extractions = new WeakMap();

/**
 * Only called once the caller has checked that there is a body.
 *
 * @param {Evidence} e
 * @returns {ExtractedPage}
 */
export function liveExtract(e) {
  const url = e.target.toString();
  const cached = extractions.get(e.html);
  if (cached && cached.body === e.html.body && cached.url === url) return cached.extracted;
  const extracted = extractPage(e.html.body, { url, minWords: SSR_MIN_WORDS });
  extractions.set(e.html, { body: e.html.body, url, extracted });
  return extracted;
}
