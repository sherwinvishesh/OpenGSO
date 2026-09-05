/**
 * Token estimate for the `X-Markdown-Tokens` header (idea.md §5B / §7).
 *
 * Deliberately dependency-free: a real tokenizer would mean shipping vocab files in a package whose
 * whole point is to stay tiny. ~1.3 tokens per whitespace-delimited word tracks common BPE
 * tokenizers closely enough for an agent deciding "is this worth fetching", which is what the header
 * is for. Always computed at generate time and stamped into the manifest, so prod computes nothing.
 */
export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 1;
  return Math.max(1, Math.ceil(words * 1.3));
}
