# opengeo-prod

> **Pre-release.** Nothing is published to npm yet, and the APIs may change before 1.0.

Runtime middleware that serves your markdown twins to AI agents at the same URL a human visits.

- **Zero dependencies.** Not "few". The bundle contains no jsdom, no AI client, no framework.
- **Never needs an API key**, by construction. There is no code path in it that could use one.
- **Never blocks anybody.** It cannot: there is no blocking branch in the package.
- Every request is a map lookup. Nothing is parsed, crawled or generated at request time.

Part of [OpenGEO](https://github.com/sherwinvishesh/OpenGEO). This is the *serving* half; the files
it serves are written by [`opengeo-generate`](https://github.com/sherwinvishesh/OpenGEO/blob/main/packages/generate/README.md).

## Install

Needs Node.js 22 or later. The `opengeo-prod/edge` entry imports no Node module, so it also runs
on edge runtimes.

```bash
npm install opengeo-prod
```

## Next.js

`opengeo-prod` imports nothing from `next`. On Next 16, a `proxy.ts` at the project root (or in
`src/`) owns the two Next-specific lines:

```ts
import { NextResponse } from 'next/server';
import { applyPassthroughHeaders, createNextMiddleware } from 'opengeo-prod/next';

// Built once at module scope, so a request is a lookup and nothing else.
const opengeo = createNextMiddleware({ root: process.cwd() });

export function proxy(request: Request) {
  const { response, headers } = opengeo(request);
  if (response) return response;          // markdown, a 304, or a 406

  const next = NextResponse.next();
  applyPassthroughHeaders(next, headers); // Vary, X-AEO-Version, Link on the HTML
  return next;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

A proxy always runs on Node, which this needs because it reads the generated files from disk. Do
not add `runtime` to `config`: Next refuses it in a proxy file.

**On Next 15** (15.5 or later), the same code goes in `middleware.ts`, the function is named
`middleware`, and `config` needs `runtime: 'nodejs'`, because middleware there defaults to the Edge
runtime, which cannot read files. Next 16 still accepts that file but warns that the name is
deprecated; `npx @next/codemod@canary middleware-to-proxy .` renames it. If you need Edge, see
[Edge runtimes](#edge-runtimes) below.

**Under `next dev` there is nothing to restart.** At most once a second the adapter checks whether
`opengeo.config.json`, the manifest or a twin changed, and if one did it loads them again and logs
`[opengeo-prod] reloaded after a change on disk`. In production (`next start`, or any
`NODE_ENV=production`) it reads them once, at boot, and a request never touches the disk. Pass
`reload: false` to turn the check off in development too.

### A known Next limitation

Next's app-page runtime calls `res.setHeader('vary', ...)` while rendering, which replaces the
`Vary: Accept` this adapter sets on **HTML** responses. There is no supported way to prevent it.

Markdown responses are unaffected and carry a clean `Vary: Accept`.

`opengeo test` scores this as a B7 partial, 2 of 4, rather than special-casing it, and `opengeo
prod test` reports it as a warning that names the exact `Vary` string Next produced. Verified against
Next 16.3.4 and 16.3.8.

## Every other framework

One adapter per kind of server, not per framework. Each reads the same `opengeo.config.json`,
`public/` and `.opengeo/manifest.json`, so they all decide a request the same way.

| Entry | Your server | Shape |
| --- | --- | --- |
| `opengeo-prod/next` | Next.js | above |
| `opengeo-prod/node` | Express, Connect, Polka, Fastify, Koa, Nest, Nuxt, h3, Angular SSR and Qwik City on Express | `(req, res, next)` |
| `opengeo-prod/fetch` | Hono, SvelteKit, Astro, React Router, SolidStart, Bun, Deno | `(request, next) => Response` |
| `opengeo-prod/vite` | `vite` and `vite preview`: vanilla, React, Vue, Svelte, Solid, Lit | a plugin |
| `opengeo-prod/edge` | Cloudflare Workers, Vercel and Netlify edge functions, Deno Deploy | `(request, next) => Response`, no disk |

Every recipe below was run against a real app on the version named, with an AI agent, a browser,
`Accept: text/markdown`, the `.md` twin URL, a `HEAD`, a 406 and a page with no twin, in development
and in a production build. Build the middleware once, at module scope: a request is then a lookup.
SolidStart, Bun, Deno, and Vercel and Netlify edge functions take the same shapes but have not been
run yet, so they are listed by the shape they share rather than as verified.

### Express, Connect, Polka, Fastify

```js
import { createNodeMiddleware } from 'opengeo-prod/node';

app.use(createNodeMiddleware()); // first, before your routes and static files
```

Verified on Express 5.3, Connect 3.7 and Polka 0.5. Fastify 5.12 takes it the same way once
[`@fastify/middie`](https://github.com/fastify/middie) 9.3 is registered
(`await app.register(middie)`), and so does Nest 12 on its default Express platform
(`app.use(createNodeMiddleware())` in `main.ts`, before `app.listen`).

A `Vary` already on the response, such as `Accept-Encoding` from compression, is kept and `Accept`
is added to it. A route that sets `Vary` itself after the middleware has run replaces the whole
header, which takes `Accept` out of it: append instead (`res.vary('Accept-Encoding')` in Express,
`ctx.vary()` in Koa), or leave `Vary` to the middleware. On Fastify, `reply.header('vary', ...)`
always replaces it. `opengeo prod test` reports a page whose `Vary` lost `Accept`.

### Koa

Koa has no `next` to hand a Node middleware, so the adapter says whether it answered:

```js
const opengeo = createNodeMiddleware();

app.use(async (ctx, next) => {
  if (opengeo(ctx.req, ctx.res)) {
    ctx.respond = false; // the twin has been sent
    return;
  }
  await next();
});
```

Verified on Koa 3.2.

### Nuxt, Nitro and h3

```js
// server/middleware/opengeo.js
import { fromNodeMiddleware } from 'h3';
import { createNodeMiddleware } from 'opengeo-prod/node';

export default fromNodeMiddleware(createNodeMiddleware());
```

Verified on Nuxt 4.4 (h3 1.15) under `nuxt dev` and the built `.output/server`.

### Hono

```js
import { createFetchMiddleware } from 'opengeo-prod/fetch';

const opengeo = createFetchMiddleware();

app.use((c, next) => opengeo(c.req.raw, async () => {
  await next();
  return c.res;
}));
```

Verified on Hono 4.13 with `@hono/node-server` 2.1. On Cloudflare, use `createEdgeMiddleware` in
the same place (see [Edge runtimes](#edge-runtimes)).

### SvelteKit

```js
// src/hooks.server.js
import { createFetchMiddleware } from 'opengeo-prod/fetch';

const opengeo = createFetchMiddleware();

export const handle = ({ event, resolve }) => opengeo(event.request, () => resolve(event));
```

Verified on SvelteKit 3.1 with `adapter-node`. If you already have a `handle`, put this first
inside `sequence(...)`.

### Astro

```js
// src/middleware.js
import { createFetchMiddleware } from 'opengeo-prod/fetch';

const opengeo = createFetchMiddleware();

export const onRequest = (context, next) => opengeo(context.request, next);
```

Verified on Astro 6.4 with `@astrojs/node` 10, on pages rendered on demand. A prerendered page is
a static file, and runs middleware only at build time: serve those the way a static host does.

### React Router (and Remix)

```jsx
// app/root.jsx
import { createFetchMiddleware } from 'opengeo-prod/fetch';

const opengeo = createFetchMiddleware();

export const middleware = [({ request }, next) => opengeo(request, next)];
```

Verified on React Router 8.5 under `react-router dev` and `react-router-serve`. Route middleware
runs only for a URL some route matches, so the app needs a catch-all route (`route('*', ...)`,
which most apps already have for their 404 page) for `/about.md` to reach it. On React Router 7
middleware sits behind the `v8_middleware` future flag. On a custom Express server, use
`createNodeMiddleware` in front of the request handler instead, which covers every URL.

### Angular SSR

```ts
// src/server.ts, before express.static and the Angular handler
import { createNodeMiddleware } from 'opengeo-prod/node';

app.use(createNodeMiddleware());
```

Verified on Angular 20.3 with `@angular/ssr` and its generated Express server, on routes rendered
per request (`RenderMode.Server`). Angular answers a host it does not know with the client-only
shell, so add your domain to `security.allowedHosts` in `angular.json` before crawling it. A
client-only Angular build is static files: see Static sites below for what that means in production.

### Qwik City

```tsx
// src/entry.express.tsx, after `const app = express()` (from `npm run qwik add express`)
import { createNodeMiddleware } from 'opengeo-prod/node';

app.use(createNodeMiddleware());
```

Verified on Qwik 1.20 with its Express adapter, and under `vite --mode ssr` with the Vite plugin
below. Qwik's adapters write their own `sitemap.xml` over the one in `public/`, an empty one unless
routes are prerendered, so turn that off where the adapter is configured:
`nodeServerAdapter({ name: 'express', ssg: { include: [], sitemapOutFile: null } })` in
`adapters/express/vite.config.ts`.

### Vite

```js
// vite.config.js
import opengeo from 'opengeo-prod/vite';

export default { plugins: [opengeo()] };
```

Verified on Vite 8.3, under `vite` and `vite preview`, with a single-page app, and in front of
Qwik's own Vite server. Angular's dev server is built on Vite but does not take Vite plugins. A
production build is static files with no server in it: see the next section.

### Static sites

Vite, VitePress, Gatsby, Docusaurus, Hugo, Jekyll, Eleventy and plain HTML build to static files,
so there is nowhere to put middleware. Two ways to serve the twins:

- **An edge function** in front of the host's static files, as in [Edge runtimes](#edge-runtimes).
  It answers at the `.md` URLs, gives agents the markdown at the page's own URL, and sets every
  header.
- **No server code at all.** Build, run `opengeo generate` on the build folder, and deploy that
  folder. Generate reads the HTML files and writes each twin beside its page (`guide/index.html`
  gets `guide.md`), so any static host serves it at its `.md` URL. A static host cannot negotiate,
  so an agent asking for the page itself still gets HTML, and the headers the B checks look for
  are missing. Run it by hand before each deploy, since a hosted build never runs generate. This
  is also the way for a site in a folder of its host, such as a GitHub Pages project site: the
  adapters expect a site at the root of its host, and `--origin https://user.github.io/repo` puts
  the folder in every URL generate writes.

```bash
npx vitepress build docs && npx opengeo generate docs/.vitepress/dist --origin https://your-site.com
```

Verified on VitePress 1.6 with `vitepress preview`, which served the twins as `text/markdown`. The
build folders are `dist` for Vite, `docs/.vitepress/dist` for VitePress, `build` for Docusaurus,
`public` for Gatsby and Hugo, and `_site` for Jekyll and Eleventy. Crawling a VitePress site instead
writes the twins into `docs/public/md/`, and VitePress then builds those into pages of their own:
add `srcExclude: ['public/**']` to `.vitepress/config` if you do.

### Anything else

The adapters are thin. Underneath is a pure function: hand it a request, get back a decision.

```js
import { createFsStore, createProdHandler, resolveBots } from 'opengeo-prod';

const handle = createProdHandler({
  store: createFsStore({ root: process.cwd(), publicDir: 'public', internalDir: '.opengeo' }),
  markdownRouting: ['ClaudeBot', 'GPTBot', 'Perplexity-User'],
  bots: resolveBots(config.bots.custom), // the project's own crawlers, from opengeo.config.json
});

const decision = handle({ url, method, headers });
```

A decision is one of: serve this markdown with these headers, return a 406, or pass through with
these headers added to whatever you were going to send. A 406 is only ever returned on a route that
has a twin; an API route asking for JSON passes through untouched. `fetchMiddleware(handle)` from
`opengeo-prod/edge` turns it into the fetch-style middleware above.

### Crawlers OpenGEO does not ship with

A project can define its own agents under `bots.custom` in `opengeo.config.json`, added through
`opengeo settings` or the dashboard's Bot settings tab. Every adapter picks them up from the config,
and `opengeo prod data` carries them to the edge. Like everything else they are read once at boot,
so in production a crawler added later needs a restart. On a development server the adapter reloads
it with the config.

### Stores

| Store | Use it when |
|---|---|
| `createFsStore` | Node runtime. Reads `public/md/**` through `.opengeo/manifest.json`. |
| `createManifestStore` | Edge runtime, or anywhere without disk. Takes an inlined manifest. |
| `createMemoryStore` | Tests. |

All three are loaded once. None of them touch the filesystem per request.

### When something goes wrong

No adapter can take a page down. A broken `opengeo.config.json` is logged once and every request
goes to your app as if OpenGEO were not installed. So does a request the handler cannot decide, for
whatever reason, logged once per process. A broken config costs you the markdown, never the site.

## Edge runtimes

An edge function has no disk, so the twins travel as data. `opengeo prod data` writes them, with
your routing and custom crawlers, into one module:

```bash
npx opengeo-prod prod data      # writes opengeo-edge-data.js (.ts in a TypeScript project)
```

Run it after `opengeo generate` and before your bundler; as the first step of your build script is
simplest. When `opengeo generate` runs in a project that already has the module, it refreshes it
too. It writes nothing when there are no twins, rather than an empty module that would quietly turn
the markdown off, and like everything OpenGEO writes it never replaces a file it did not write
(`--force` does). It warns past 1 MB, since edge hosts cap a function's size.

Then import from `opengeo-prod/edge`, which imports no Node module, so an edge bundler takes it:

```js
// A Cloudflare Worker in front of its static assets
import { createEdgeMiddleware } from 'opengeo-prod/edge';
import data from './opengeo-edge-data.js';

const opengeo = createEdgeMiddleware({ data });

export default {
  fetch: (request, env) => opengeo(request, () => env.ASSETS.fetch(request)),
};
```

Verified with wrangler 4.151 (`wrangler dev`, which runs Cloudflare's workerd), with
`assets.run_worker_first` on so the Worker sees page requests before the static files do. A
response from `fetch()` has headers that cannot be changed; the middleware copies it rather than
failing. Any runtime with `Request` and `Response` takes the same middleware, Vercel and Netlify
edge functions and Deno Deploy among them, though only workerd has been run.

On Next.js, Edge middleware is the same idea: return `decision.response` from a
`createProdHandler({ store: createManifestStore(data), ... })` when there is one, otherwise
`NextResponse.next()` with `applyPassthroughHeaders`. Do not import `opengeo-prod/next` there: it is
the Node adapter and reads the disk. There is no startup log at the edge; check a deployment with
`opengeo prod test` instead.

## Verifying a deployment

```bash
npx opengeo-prod prod test https://your-site.com/some-page
```

Five probes, each isolating exactly one variable, reported under the lever they belong to:

```
Lever 1 - markdown routing (bots.markdownRouting)
Content negotiation
Lever 2 - blocking (bots.blocked, via robots.txt)
```

The routed-bot probe sends a browser-typical `Accept` header, so a markdown response can only have
been caused by the User-Agent. The Accept probe sends a browser User-Agent, so a markdown response
can only have been caused by the `Accept` header. When the two levers disagree, for example a bot
you route markdown to that your own `robots.txt` disallows, that gets its own section.

```
--bot <name>       impersonate a specific bot (default: ClaudeBot)
--verbose, -v      print the exact curl and the returned headers for each probe
--json             machine-readable
```

The exit code follows the failures, not the warnings. A warning is a real finding, but it is the
kind a CDN can cause and that you may knowingly accept.

`prod test` and `prod data` are the only two commands in this package. `opengeo-prod generate`
will tell you, by name, which package to install instead.

## Startup logging

On boot, once per process, `opengeo-prod` reports what it found:

```
[opengeo-prod] startup check
[opengeo-prod] robots.txt: found - blocking no AI bots
[opengeo-prod] llms.txt: found
[opengeo-prod] sitemap.xml: found
[opengeo-prod] markdown twins loaded: 3
```

There is a module-scoped guard, so this happens at startup and never per request. When a file is
missing it says so and names the command that would create it. Pass `logStartup: false` to silence
it.

If `opengeo.config.json` is broken (malformed JSON, a field of the wrong type, a `publicDir` outside
the project), no adapter throws. It logs one `[opengeo-prod]` line to stderr naming the
problem, serves no markdown, and passes every request through to the normal site until the file is
fixed. A broken config costs you the markdown, never the site.

## The two levers

`opengeo-prod` implements exactly one of OpenGEO's two bot settings.

**`bots.markdownRouting` (lever 1) chooses a format.** A bot on this list gets markdown. A bot not on
it gets the normal HTML page, exactly like a human visitor. An agent nobody has heard of gets HTML,
not a 403. Unknown means unknown, not hostile.

**`bots.blocked` (lever 2) is not implemented here at all.** Blocking is expressed through the
`robots.txt` that `opengeo generate` writes. It is advisory, it lives in a file your users can read,
and there is no code in this package that could enforce it. That is deliberate, not an omission.

`bots.custom` is neither lever. It widens the catalogue of crawlers that can be recognised at all,
and a crawler in it still has to be named in `markdownRouting` before anything routes to it.

## What it does not do

It does not crawl, generate, extract, call an AI provider, read an API key, write files, block
requests, or redirect anybody. Serving markdown to a human is a worse outcome than not installing
this at all, so the HTML path is left alone unless the request asked for something else.

## Reference

- [The wire spec](https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/spec.md) - headers, negotiation, the twin URL convention.
- [The check catalogue](https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/checks.md) - what `opengeo test` verifies, and why.
