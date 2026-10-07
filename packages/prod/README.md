# opengeo-prod

Runtime middleware that serves your markdown twins to AI agents at the same URL a human visits.

- **Zero dependencies.** Not "few". The bundle contains no jsdom, no AI client, no framework.
- **Never needs an API key**, by construction. There is no code path in it that could use one.
- **Never blocks anybody.** It cannot: there is no blocking branch in the package.
- Every request is a map lookup. Nothing is parsed, crawled or generated at request time.

Part of [OpenGEO](https://github.com/sherwinvishesh/OpenGEO). This is the *serving* half; the files
it serves are written by [`opengeo-generate`](https://github.com/sherwinvishesh/OpenGEO/blob/main/packages/generate/README.md).

## Install

```bash
npm install opengeo-prod
```

## Next.js

`opengeo-prod` imports nothing from `next`. Your `middleware.ts` owns the two Next-specific lines:

```ts
import { NextResponse } from 'next/server';
import { applyPassthroughHeaders, createNextMiddleware } from 'opengeo-prod/next';

// Built once at module scope, so a request is a lookup and nothing else.
const opengeo = createNextMiddleware({ root: process.cwd() });

export function middleware(request: Request) {
  const { response, headers } = opengeo(request);
  if (response) return response;          // markdown, or a 406

  const next = NextResponse.next();
  applyPassthroughHeaders(next, headers); // Vary, X-AEO-Version, Link on the HTML
  return next;
}

export const config = {
  runtime: 'nodejs',
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

**`runtime: 'nodejs'` is required.** The middleware reads the generated files from disk, which the
Edge runtime cannot do. If you need Edge, use `createManifestStore` with a manifest you inline at
build time.

### A known Next limitation

Next's app-page runtime calls `res.setHeader('vary', ...)` while rendering, which replaces the
`Vary: Accept` this adapter sets on **HTML** responses. There is no supported way to prevent it.

Markdown responses are unaffected and carry a clean `Vary: Accept`.

`opengeo test` scores this as a B7 partial, 2 of 4, rather than special-casing it, and `opengeo
prod test` reports it as a warning that names the exact `Vary` string Next produced. Verified against
Next 16.3.4 and 16.3.8.

## Any other Node server

The core is a pure function: hand it a request, get back a decision. Nothing about it is
framework-specific.

```ts
import { createProdHandler, createFsStore } from 'opengeo-prod';

const handle = createProdHandler({
  store: createFsStore({ root: process.cwd(), publicDir: 'public', internalDir: '.opengeo' }),
  markdownRouting: ['ClaudeBot', 'GPTBot', 'Perplexity-User'],
});

// In your request pipeline:
const decision = handle({ url, method, headers });
```

A decision is one of: serve this markdown with these headers, return a 406, or pass through with
these headers added to whatever you were going to send. A 406 is only ever returned on a route that
has a twin; an API route asking for JSON passes through untouched.

### Crawlers OpenGEO does not ship with

A project can define its own agents under `bots.custom` in `opengeo.config.json`, added through
`opengeo settings` or the dashboard's Bot settings tab. Pass the resolved list so the handler can
recognise them:

```ts
import { createProdHandler, createFsStore, resolveBots } from 'opengeo-prod';

const handle = createProdHandler({
  store: createFsStore({ root: process.cwd(), publicDir: 'public', internalDir: '.opengeo' }),
  markdownRouting: ['ClaudeBot', 'AcmeBot'],
  bots: resolveBots(config.bots.custom),
});
```

The Next adapter does this for you. Like everything else here it is resolved once at boot, so a
crawler added later needs a restart before the running server sees it.

### Stores

| Store | Use it when |
|---|---|
| `createFsStore` | Node runtime. Reads `public/md/**` through `.opengeo/manifest.json`. |
| `createManifestStore` | Edge runtime, or anywhere without disk. Takes an inlined manifest. |
| `createMemoryStore` | Tests. |

All three are loaded once. None of them touch the filesystem per request.

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

This command is the *only* command in this package. `opengeo-prod generate` will tell you, by name,
which package to install instead.

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
the project), the Next adapter does not throw. It logs one `[opengeo-prod]` line to stderr naming the
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
