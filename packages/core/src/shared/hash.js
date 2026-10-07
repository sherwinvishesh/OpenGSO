import { createHash } from 'node:crypto';

/**
 * Stable content hash used for generate's skip-unchanged cache and test's drift check.
 *
 * @param {string} input
 * @returns {string}
 */
export function contentHash(input) {
  return createHash('sha256').update(normalizeForHash(input)).digest('hex').slice(0, 16);
}

/**
 * Collapse insignificant whitespace before hashing so cosmetic reflows in the source HTML don't
 * look like a content change and force a pointless (and, on the AI tier, paid) regeneration.
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeForHash(input) {
  return input.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
