# nextjs-demo

A three-page Next.js 16 site used to drive the whole OpenGSO loop for real: generate the markdown
twins, serve them from `opengso-prod`, and score the result with `opengso test`.

The pages carry deliberately specific facts (`3 March 2024`, `$12,500`, `42%`, `21,400 EUR`) so the
AI tier's fidelity verifier has something concrete to protect.

## Run it

```bash
# from the repo root
npm install
npm run build

# terminal A
npm run example:dev                 # or: npm run example:start (production build)

# terminal B, from the repo root: the workspace puts the built CLI on npx's path
npx opengso generate http://localhost:3000 --project examples/nextjs-demo
npx opengso prod test http://localhost:3000/ --project examples/nextjs-demo
npx opengso test http://localhost:3000/
```

The demo expects 100/100 with one suggestion partial (B7, explained below) and `A8` not
applicable, because HTTPS means nothing on localhost. `npm run install:global` installs the same
build as a global `opengso`, which is what the rest of the docs assume.

`OPENGSO_PROD=off npm run example:start` disables the proxy, which is the "before" state:
every category B check fails with a specific reason.

## The integration

All of it is in `proxy.ts`:

```ts
const opengso = createNextMiddleware({ root: process.cwd() });

export function proxy(request: Request) {
  const { response, headers } = opengso(request);
  if (response) return response;
  const next = NextResponse.next();
  applyPassthroughHeaders(next, headers);
  return next;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
```

Next 16 renamed middleware to proxy, and a proxy always runs on Node, which the store needs because
it reads the generated twins from disk. A proxy file refuses a `runtime` option, so there is none.
On Next 15 the same code goes in `middleware.ts`, exports `middleware`, and adds `runtime: 'nodejs'`
to `config`.

Under `next dev`, running `opengso generate` again is enough: the proxy notices the new twins within
a second and logs `reloaded after a change on disk`. `next start` reads them once, at boot.

## Known limitation: `Vary: Accept` on Next's App Router

`opengso test` scores B7 as a partial here, 2 of 4, and it is telling the truth. Next's app-page runtime
calls `res.setHeader('vary', 'rsc, next-router-state-tree, ...')` while rendering, which replaces
anything middleware or `next.config.js` `headers()` set earlier. The markdown response is unaffected
(it is a `Response` object OpenGSO returns directly, and it carries `Vary: Accept` correctly), but
the HTML response loses it.

Verified against Next 16.3.4 in both `next dev` and `next start`, from middleware and from
`headers()`, and re-checked from middleware on 16.3.8 in both. Route handlers keep the header; only
app pages drop it.

Until that changes upstream, add `Vary: Accept` to the HTML response at your CDN or reverse proxy.
OpenGSO does not monkey-patch `http.ServerResponse` to work around it.
