/**
 * OpenGSO's own spec version, advertised via the `X-AEO-Version` response header (§7).
 * This names OpenGSO's published behaviour, never a third party's spec.
 */
export const AEO_SPEC_VERSION = 'opengso/1.0';

/** Header name constants, so test and prod can never drift apart on spelling. */
export const HEADERS = /* @__PURE__ */ Object.freeze({
  contentType: 'Content-Type',
  markdownTokens: 'X-Markdown-Tokens',
  contentTypeOptions: 'X-Content-Type-Options',
  robotsTag: 'X-Robots-Tag',
  vary: 'Vary',
  link: 'Link',
  aeoVersion: 'X-AEO-Version',
  /**
   * The hash of the HTML the twin was generated from. Not in §7's required list, which is a floor
   * rather than an exclusive set: without it the B14 drift check can only compare facts, because
   * prod strips frontmatter from the body before serving it.
   */
  markdownSourceHash: 'X-Markdown-Source-Hash',
  lastModified: 'Last-Modified',
  /** Set to `private` only on markdown the User-Agent chose, which `Vary: Accept` cannot describe. */
  cacheControl: 'Cache-Control',
  /** A hash of the served body, taken once at load, so a cache can revalidate instead of refetching. */
  etag: 'ETag',
});

export const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';
