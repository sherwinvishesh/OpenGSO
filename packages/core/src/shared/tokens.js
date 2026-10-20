/**
 * Token estimate for the `X-Markdown-Tokens` header (§5B / §7).
 *
 * Deliberately dependency-free: a real tokenizer would mean shipping vocab files in a package whose
 * whole point is to stay tiny. ~1.3 tokens per whitespace-delimited word tracks common BPE
 * tokenizers closely enough for an agent deciding "is this worth fetching", which is what the header
 * is for. Always computed at generate time and stamped into the manifest, so prod computes nothing.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const words = countWords(text);
  if (words === 0) return 1;
  return Math.max(1, Math.ceil(words * 1.3));
}

/**
 * Whitespace-delimited words. The one definition every count in OmniGEO uses (the extractor's
 * threshold, B3's twin-versus-page comparison, the fidelity ratio, the manifest's wordCount), so
 * two counts that get compared were always made the same way.
 *
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  const words = text.trim().match(/\S+/g);
  return words ? words.length : 0;
}
