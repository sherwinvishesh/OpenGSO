# nextjs-demo

A four-page Next.js 16 site used to drive the whole OpenGEO loop for real: generate the markdown
twins, serve them from `opengeo-prod`, and score the result with `opengeo test`.

The pages carry deliberately specific facts (`3 March 2024`, `$12,500`, `42%`, `21,400 EUR`) so the
AI tier's fidelity verifier has something concrete to protect.

## Run it

```bash
# from the repo root
npm install
npm run build

# terminal A
npm run example:dev                 # or: npm run example:start (production build)

# terminal B
node packages/cli/dist/cli.js generate http://localhost:3000 --project examples/nextjs-demo
node packages/cli/dist/cli.js test http://localhost:3000/
```

`OPENGEO_PROD=off npm run example:start` disables the middleware, which is the "before" state:
every category B check fails with a specific reason.

## The integration

All of it is in `middleware.ts`:

```ts
const opengeo = createNextMiddleware({ root: process.cwd() });

export function middleware(request: Request) {
  const { response, headers } = opengeo(request);
  if (response) return response;
  const next = NextResponse.next();
  applyPassthroughHeaders(next, headers);
  return next;
}

export const config = { runtime: 'nodejs', matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
```

`runtime: 'nodejs'` is required: the store reads the generated twins from disk at boot.

Next 16 renamed the `middleware.ts` convention to `proxy.ts` and warns about the old name. Both work
in 16; `middleware.ts` is kept here because it is also what Next 15 users need. Rename the file and
the exported function to `proxy` if you only target 16.

## Known limitation: `Vary: Accept` on Next's App Router

`opengeo test` scores B7 as a partial here, 2 of 4, and it is telling the truth. Next's app-page runtime
calls `res.setHeader('vary', 'rsc, next-router-state-tree, ...')` while rendering, which replaces
anything middleware or `next.config.js` `headers()` set earlier. The markdown response is unaffected
(it is a `Response` object OpenGEO returns directly, and it carries `Vary: Accept` correctly), but
the HTML response loses it.

Verified against Next 16.3.4 in both `next dev` and `next start`, from middleware and from
`headers()`, and re-checked from middleware on 16.3.8 in both. Route handlers keep the header; only
app pages drop it.

Until that changes upstream, add `Vary: Accept` to the HTML response at your CDN or reverse proxy.
OpenGEO does not monkey-patch `http.ServerResponse` to work around it.
