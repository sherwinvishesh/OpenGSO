import { resolveBots } from '../../shared/bots.js';
import { loadConfig } from '../../shared/config.js';
import type { ProdContext, ProdDecision, RequestLike } from '../middleware.js';
import { createProdHandler } from '../middleware.js';
import { logStartupStatus } from '../startup.js';
import type { MarkdownStore } from '../store.js';
import { createFsStore } from '../store.js';

/**
 * Next.js adapter (§19: one thin adapter per hosting target).
 *
 * Deliberately does not import anything from `next`. The user's own middleware.ts owns the two
 * Next-specific lines; keeping `next` out of opengeo-prod's dependency graph is what lets the same
 * package sit in a Netlify function or a plain Node server without dragging a framework along.
 *
 * Requires the Node.js middleware runtime, because it reads the generated files from disk:
 *
 *   export const config = { runtime: 'nodejs', matcher: [...] };
 *
 * Known upstream limitation: Next's app-page runtime calls `res.setHeader('vary', ...)` while
 * rendering, which replaces the `Vary: Accept` this adapter hands back for the HTML response.
 * Markdown responses are unaffected. Verified on 16.3.4; see examples/nextjs-demo/README.md.
 */

export interface NextAdapterOptions {
  /** Project root - where opengeo.config.json, public/ and .opengeo/ live. */
  root?: string;
  publicDir?: string;
  internalDir?: string;
  /** Overrides the config file's `bots.markdownRouting`. */
  markdownRouting?: readonly string[];
  specVersion?: string;
  /** Startup status logging is on by default and only ever runs once per process (§7). */
  logStartup?: boolean;
  /** Pre-built store, for tests or for a build-time-inlined manifest. */
  store?: MarkdownStore;
}

export interface NextMiddlewareResult {
  /** Present when prod answered the request itself: markdown, or a 406. */
  response?: Response;
  /** Headers to copy onto the host's own HTML response when prod did not answer. */
  headers: Record<string, string>;
  decision: ProdDecision;
}

export function createNextMiddleware(options: NextAdapterOptions = {}) {
  const root = options.root ?? process.cwd();
  const loaded = loadConfig(root);
  const store =
    options.store ??
    createFsStore({
      root,
      publicDir: options.publicDir ?? loaded.config.publicDir,
      internalDir: options.internalDir ?? loaded.config.internalDir,
    });

  const ctx: ProdContext = {
    store,
    markdownRouting: options.markdownRouting ?? loaded.config.bots.markdownRouting,
    // Resolved once at boot, like everything else here: a request must stay a map lookup (§7).
    bots: resolveBots(loaded.config.bots.custom),
    specVersion: options.specVersion,
  };

  if (options.logStartup !== false) {
    logStartupStatus({ root, publicDir: options.publicDir ?? loaded.config.publicDir, store, bots: ctx.bots });
  }

  const handler = createProdHandler(ctx);

  return function openGeoNextMiddleware(request: RequestLike): NextMiddlewareResult {
    const decision = handler(request);
    if (decision.type === 'passthrough') return { headers: decision.headers, decision };
    return { response: decision.response, headers: {}, decision };
  };
}

/** Copy prod's passthrough headers onto a NextResponse (or any Headers-bearing response). */
export function applyPassthroughHeaders(
  target: { headers: { set(name: string, value: string): void } },
  headers: Record<string, string>,
): void {
  for (const [name, value] of Object.entries(headers)) target.headers.set(name, value);
}
