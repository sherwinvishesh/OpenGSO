/**
 * OpenGEO's own spec version, advertised via the `X-AEO-Version` response header (idea.md §7).
 * This names OpenGEO's published behaviour, never a third party's spec.
 */
export const AEO_SPEC_VERSION = 'opengeo/1.0';

/** Header name constants, so test and prod can never drift apart on spelling. */
export const HEADERS = {
  contentType: 'Content-Type',
  markdownTokens: 'X-Markdown-Tokens',
  contentTypeOptions: 'X-Content-Type-Options',
  robotsTag: 'X-Robots-Tag',
  vary: 'Vary',
  link: 'Link',
  aeoVersion: 'X-AEO-Version',
} as const;

export const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';
