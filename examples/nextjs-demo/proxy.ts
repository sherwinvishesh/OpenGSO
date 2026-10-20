import { NextResponse } from 'next/server';
import { applyPassthroughHeaders, createNextMiddleware } from 'omnigeo-prod/next';

/**
 * The entire production integration: two Next-specific lines around one call into omnigeo-prod.
 *
 * The store is built once, here at module scope, so in production a request is a map lookup and
 * nothing else. Under `next dev` it also picks up a fresh `omnigeo generate` without a restart.
 * `OMNIGEO_PROD=off` disables it, which is how the demo shows the same page scoring badly before
 * OmniGEO is installed and well after.
 *
 * This is Next 16's proxy.ts, which always runs on Node and refuses a `runtime` option. On Next 15
 * the same code goes in middleware.ts, exports `middleware`, and adds `runtime: 'nodejs'` to config.
 */
const enabled = process.env.OMNIGEO_PROD !== 'off';
const omnigeo = enabled ? createNextMiddleware({ root: process.cwd() }) : undefined;

export function proxy(request: Request) {
  if (!omnigeo) return NextResponse.next();

  const { response, headers } = omnigeo(request);
  if (response) return response;

  const next = NextResponse.next();
  applyPassthroughHeaders(next, headers);
  return next;
}

export const config = {
  // Everything except Next's own build output and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
