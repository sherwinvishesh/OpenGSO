import { extractPage } from '@opengeo/core/generate';
import { contentHash } from '@opengeo/core/shared';

/**
 * The hash generate would stamp into a twin built from this HTML.
 *
 * Written out here rather than imported so the B14 tests fail loudly if the two sides of the
 * pipeline ever stop hashing the same thing. Both hash the extracted content, not the raw markup.
 *
 * @param {string} html
 * @param {string} [url]
 * @returns {string}
 */
export function liveContentHash(html, url = 'https://example.com/resume') {
  return contentHash(extractPage(html, { url, minWords: 50 }).markdown);
}
