import { AEO_SPEC_VERSION } from '../shared/version.js';
import { htmlHeaders, markdownHeaders, notAcceptableHeaders, NOT_ACCEPTABLE_BODY } from './headers.js';
import type { Classification } from './negotiate.js';
import { classify } from './negotiate.js';
import type { MarkdownDoc, MarkdownStore } from './store.js';

/**
 * The framework-agnostic heart of opengeo-prod (idea.md §7).
 *
 * It is a pure function over a request: no I/O, no AI, no API key, no per-request computation
 * beyond a map lookup. Everything a hosting target needs is in the returned decision, so each
 * adapter stays a few lines and nothing about a specific framework leaks in here.
 *
 * It rewrites, never redirects: the URL a visitor asked for is the URL that answers, with the same
 * substantive content in a different format.
 */

export interface ProdContext {
  store: MarkdownStore;
  /** Lever 1 (§7): which bots get markdown. Never a blocking list. */
  markdownRouting: readonly string[];
  specVersion?: string;
}

export interface RequestLike {
  url: string;
  method?: string;
  headers: { get(name: string): string | null };
}

export type ProdDecision =
  | { type: 'markdown'; response: Response; classification: Classification; doc: MarkdownDoc }
  | { type: 'not-acceptable'; response: Response; classification: Classification }
  | {
      type: 'passthrough';
      /** Headers the adapter must copy onto the host's own HTML response. */
      headers: Record<string, string>;
      classification: Classification;
    };

/** Paths prod never touches: static assets and framework internals. `.md` is the exception. */
const IGNORED_PREFIXES = ['/_next/', '/_nuxt/', '/_astro/', '/__nextjs', '/@vite/', '/node_modules/'];
const ASSET_EXTENSION = /\.[a-z0-9]{1,8}$/i;

export function handleRequest(request: RequestLike, ctx: ProdContext): ProdDecision {
  const url = new URL(request.url);
  const method = (request.method ?? 'GET').toUpperCase();
  const specVersion = ctx.specVersion ?? AEO_SPEC_VERSION;

  const isAsset =
    IGNORED_PREFIXES.some((prefix) => url.pathname.startsWith(prefix)) ||
    (ASSET_EXTENSION.test(url.pathname) && !url.pathname.endsWith('.md'));

  const classification = classify({
    pathname: url.pathname,
    userAgent: request.headers.get('user-agent'),
    accept: request.headers.get('accept'),
    markdownRouting: ctx.markdownRouting,
  });

  if (isAsset || (method !== 'GET' && method !== 'HEAD')) {
    return { type: 'passthrough', headers: {}, classification };
  }

  if (classification.serve === 'not-acceptable') {
    return {
      type: 'not-acceptable',
      classification,
      response: new Response(NOT_ACCEPTABLE_BODY, {
        status: 406,
        headers: notAcceptableHeaders(specVersion),
      }),
    };
  }

  const doc = ctx.store.get(classification.route);

  if (classification.serve === 'markdown' && doc) {
    return {
      type: 'markdown',
      classification,
      doc,
      response: new Response(method === 'HEAD' ? null : doc.body, {
        status: 200,
        headers: markdownHeaders({ tokens: doc.tokens, specVersion }),
      }),
    };
  }

  // No twin on disk: fall through to the real site rather than inventing one. An agent seeing the
  // normal HTML is a worse experience, never a broken one.
  return {
    type: 'passthrough',
    classification,
    headers: htmlHeaders({ route: classification.route, hasTwin: Boolean(doc), specVersion }),
  };
}

/** Convenience wrapper for adapters that only care about "did prod answer this request". */
export function createProdHandler(ctx: ProdContext) {
  return (request: RequestLike): ProdDecision => handleRequest(request, ctx);
}
