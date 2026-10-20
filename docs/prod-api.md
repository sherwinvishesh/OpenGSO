# `opengeo-prod` API

Every export of the six `opengeo-prod` entry points. The package's
[README](../packages/prod/README.md) shows how to wire them into each framework; this page is the
list. `opengeo` re-exports the same six as `opengeo/prod`, `opengeo/prod/next`, `opengeo/prod/node`,
`opengeo/prod/fetch`, `opengeo/prod/vite` and `opengeo/prod/edge`.

| Entry | For | Contents |
| --- | --- | --- |
| `opengeo-prod/next` | Next.js `proxy.ts` (`middleware.ts` on Next 15) | `createNextMiddleware` and `applyPassthroughHeaders`. |
| `opengeo-prod/node` | `(req, res, next)` servers: Express, Connect, Polka, Fastify, Koa, Nest, h3 and Nuxt | `createNodeMiddleware`. |
| `opengeo-prod/fetch` | Servers on Node that pass `Request` around: Hono, SvelteKit, Astro, React Router, SolidStart | `createFetchMiddleware`. |
| `opengeo-prod/vite` | `vite` and `vite preview` | `opengeo`, the plugin, also the default export. |
| `opengeo-prod/edge` | Edge runtimes, or anywhere without a disk | `createEdgeMiddleware`, the request handling, the stores that take data rather than read files, and the helpers below. No `node:` import anywhere. |
| `opengeo-prod` | Anything the adapters do not cover | Everything in `opengeo-prod/edge`, plus `createFsStore`, `buildStartupStatus` and `logStartupStatus`. |

The four adapters for a server with a disk (Next, Node, fetch and Vite) read the project the same
way, so they cannot disagree about which config, which crawlers or which twins a site has.

Nothing here makes a network call, blocks a crawler, or redirects. A request is a lookup in a store
built once at startup. The one exception is an adapter on a development server, which checks once a
second whether the files changed and builds a new store if they did.

None of them can take a page down. A request the handler cannot decide goes to the application as
if OpenGEO were not installed, and the reason is logged once per process.

## Handling a request

**`createProdHandler(ctx)`** returns `(request) => decision`. Build it once and call it per request.

**`handleRequest(request, ctx)`** is the same thing without the closure.

`ctx` is a `ProdContext`:

| Field | Type | |
| --- | --- | --- |
| `store` | `MarkdownStore` | Where the twins come from. See [Stores](#stores). |
| `markdownRouting` | `string[]` | Crawler names that receive markdown at the page's own URL: `bots.markdownRouting` from the config. |
| `bots` | `AiBot[]`, optional | The catalogue User-Agents are matched against. Defaults to `AI_BOTS`; pass `resolveBots(config.bots.custom)` to include the project's own crawlers. |
| `specVersion` | `string`, optional | The `X-AEO-Version` value. Defaults to `AEO_SPEC_VERSION`. |

`request` is anything with `url` (absolute), an optional `method`, and `headers.get(name)`. A
`Request` qualifies. Only `GET` and `HEAD` are ever answered; other methods, static assets and
framework internals pass through untouched.

The decision is one of three:

| `type` | Also carries | What to do |
| --- | --- | --- |
| `'markdown'` | `response`, `doc`, `classification` | Return `response`: the twin, at the URL that was asked for. |
| `'not-acceptable'` | `response`, `classification` | Return `response`: a 406, sent only on a route that has a twin. |
| `'passthrough'` | `headers`, `classification` | Serve your normal response, with `headers` added to it. |

## The adapters

Each of these reads `opengeo.config.json`, builds the store and the crawler list once, and logs the
startup status. If the config cannot be loaded it logs one line and passes every request through.
They take the same options:

| Option | Default |
| --- | --- |
| `root` | `process.cwd()`. The config is looked up from here, so a server started in a subfolder still finds it. |
| `publicDir`, `internalDir` | the config's values |
| `markdownRouting` | the config's `bots.markdownRouting` |
| `specVersion` | `AEO_SPEC_VERSION` |
| `logStartup` | `true`; also covers the reload line |
| `store` | `createFsStore` over the directories above |
| `reload` | `true` unless `NODE_ENV` is `production`; always off when you pass `store` |

Outside production they also reload: at most once a second it compares the modification times of the
config and of every file the store read, and when one changed it builds everything again and logs
"reloaded after a change on disk". So `opengeo generate` during `next dev` shows up on the next
request without a restart. A config that breaks mid-session fails open the same way it would at
boot, and comes back when it is fixed. A reload that fails for any other reason keeps the twins
already loaded. In production (`NODE_ENV=production`) none of this runs, and a request stays a map
lookup.

**`createNextMiddleware(options?)`** returns `(request) => { response?, headers, decision }`. Return
`response` when it is present; otherwise apply `headers` to `NextResponse.next()`.

**`applyPassthroughHeaders(target, headers)`** sets each header on `target.headers`.

**`createNodeMiddleware(options?)`** returns `(req, res, next?) => true | undefined`. When OpenGEO
owns the request (a twin, a 304 or a 406) it answers on `res` and returns `true`. Otherwise it sets
the passthrough headers on `res`, merging `Vary` and `Link` into whatever is already there, calls
`next()` if there is one, and returns nothing, so a framework without `next` (Koa) can tell the two
apart. Nothing rather than `false`, because h3's `fromNodeMiddleware` sends any returned value as
the body. It reads `req.originalUrl` before `req.url`, so a router mounted below `/` still matches
twins by their full path.

**`createFetchMiddleware(options?)`** returns `(request, next) => Promise<Response>`, where `next`
runs the rest of the application and resolves to its response. It is called with no arguments.

**`opengeo(options?)`** (`opengeo-prod/vite`, also the default export) is a Vite plugin that puts
`createNodeMiddleware` in front of `vite` and `vite preview`, ahead of the SPA fallback and the
static file server, with `root` taken from Vite's. It imports nothing from `vite`.

**`createEdgeMiddleware({ data, markdownRouting?, specVersion? })`** (`opengeo-prod/edge`) is the
fetch middleware for a runtime with no disk. `data` is an `EdgeData`: `{ manifest, contents,
markdownRouting?, customBots? }`, the module `opengeo prod data` writes. It carries the project's
routing and custom crawlers, so the edge decides what a Node server reading the config would.
`markdownRouting` here overrides the one in `data`.

**`fetchMiddleware(decide)`** turns any `(request) => decision` function, such as one from
`createProdHandler`, into fetch middleware with the same fail-open behaviour.

**`withPassthroughHeaders(response, headers)`** adds a passthrough decision's headers to a
`Response` and returns it. A response whose headers cannot be changed (one from `fetch()` or
`Response.redirect()`) is copied first; a 101 is returned untouched.

**`mergeHeaderValue(name, existing, value)`** is the merge both use: `Vary` gains `Accept` once and
`Vary: *` is left alone, `Link` gains the twin once, and any other header is replaced.

## Stores

A `MarkdownStore` has `get(route)`, `has(route)`, `routes()`, `size`, and `problems`, the non-fatal
issues found while loading. `createFsStore`'s also has `sources`, the files it read, the manifest
first. `get` returns a `MarkdownDoc`: `route`, `title`, `body` (frontmatter already stripped),
`tokens`, `lastUpdated`, `etag`, and `sourceHash` when generate recorded one.

- **`createFsStore({ root, publicDir?, internalDir? })`** (Node entry only) reads
  `<internalDir>/manifest.json` and the twins it lists, once. A twin that is missing, unreadable or
  outside `publicDir` costs that one page and is listed in `problems`.
- **`createManifestStore({ manifest, contents })`** takes the manifest object and the raw twin
  files keyed by the manifest's `file` field, for a build step that inlines them.
- **`createMemoryStore(docs)`** takes `MarkdownDoc` objects directly, and computes `etag` for any
  that lack one.
- **`entityTag(body)`** is the strong `ETag` the stores give a body: a quoted 64-bit hash, the same
  in every runtime.

## Startup logging (Node entry only)

**`buildStartupStatus({ root, publicDir?, store?, bots? })`** reports which of `robots.txt`,
`llms.txt` and `sitemap.xml` exist, how many twins loaded, and any problems, as data and as `lines`.
**`logStartupStatus(options)`** prints those lines once per process (later calls do nothing) and
also takes a `logger`.

## Negotiation

- **`classify({ pathname, userAgent?, accept?, markdownRouting, bots? })`** is the decision before
  any store lookup: who is asking (`kind`: `human`, `routed-ai` or `unrouted-bot`), the canonical
  `route`, what to `serve` (`markdown`, `html` or `not-acceptable`) and a plain-language `reason`.
- **`parseAccept(header)`** returns `{ type, subtype, q }` entries.
- **`summarizeAccept(header)`** returns `{ absent, acceptsHtml, acceptsMarkdown, prefersMarkdown }`.

## Headers

- **`markdownHeaders({ tokens, specVersion?, lastUpdated?, sourceHash?, selectedByUserAgent? })`**
  and **`htmlHeaders({ route, specVersion?, hasTwin })`** build the two header sets the spec
  defines.
- **`notAcceptableHeaders(specVersion?)`** and **`NOT_ACCEPTABLE_BODY`** are the 406.
- **`linkAlternate(twinPath)`** builds the `<...>; rel="alternate"; type="text/markdown"` `Link` value, and
  **`parseLinkAlternate(header)`** reads the twin path back out of one.
- **`varyIncludesAccept(value)`** checks a `Vary` header.
- **`isNotModified({ ifNoneMatch, ifModifiedSince }, { etag?, lastUpdated? }, now?)`** decides a
  conditional request the way [spec.md](spec.md#conditional-requests) describes, and
  **`notModifiedHeaders(headers)`** keeps the subset of a markdown header set that a 304 carries.
  The handler already uses both.
- **`httpDate(iso)`** turns an ISO timestamp into an HTTP date, or `undefined`.
- **`HEADERS`** holds the header names, **`MARKDOWN_CONTENT_TYPE`** is
  `text/markdown; charset=utf-8`, and **`AEO_SPEC_VERSION`** is the spec version (see
  [versioning.md](versioning.md)).

## Crawlers

- **`AI_BOTS`** is the shipped catalogue, and **`ROUTABLE_BOTS`** is the subset that can be matched
  by User-Agent. **`DEFAULT_MARKDOWN_ROUTING`** is the default for `bots.markdownRouting`.
- **`resolveBots(custom)`** and **`resolveRoutableBots(custom)`** add a config's `bots.custom`
  entries to those two lists. A custom name that matches a shipped crawler is ignored.
- **`identifyBot(userAgent, bots?)`** and **`findBot(name, bots?)`** look one up.

## Routes

- **`normalizeRoute(pathname)`** gives the canonical form of a route: a leading slash, and no
  trailing slash except on `/`.
- **`routeToTwinUrlPath(route)`** gives a route's twin URL (`/about` to `/about.md`, `/` to
  `/index.md`), and **`twinUrlPathToRoute(pathname)`** reverses it, or returns `undefined`.
- **`isMarkdownPath(pathname)`** tests for a `.md` path.

The full wire behaviour these implement is in [spec.md](spec.md).
