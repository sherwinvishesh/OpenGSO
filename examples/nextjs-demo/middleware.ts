import { NextResponse } from 'next/server';
import { applyPassthroughHeaders, createNextMiddleware } from 'opengeo-prod/next';

/**
 * The entire production integration: two Next-specific lines around one call into opengeo-prod.
 *
 * The store is built once, here at module scope, so a request is a map lookup and nothing else.
 * `OPENGEO_PROD=off` disables it, which is how the demo shows the same page scoring badly before
 * OpenGEO is installed and well after.
 */
const enabled = process.env.OPENGEO_PROD !== 'off';
const opengeo = enabled ? createNextMiddleware({ root: process.cwd() }) : undefined;

export function middleware(request: Request) {
  if (!opengeo) return NextResponse.next();

  const { response, headers } = opengeo(request);
  if (response) return response;

  const next = NextResponse.next();
  applyPassthroughHeaders(next, headers);
  return next;
}

export const config = {
  runtime: 'nodejs',
  // Everything except Next's own build output and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
