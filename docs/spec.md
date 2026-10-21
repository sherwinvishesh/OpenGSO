# The OpenGSO wire spec, version `opengso/1.0`

This is the contract between a site and an AI agent: which URL holds the markdown, which headers say
so, and what happens when an agent asks for a format the server cannot produce.

It is deliberately small. Everything here is plain HTTP that a CDN, a proxy and a curl one-liner
already understand. There is no new protocol, no manifest an agent has to fetch first, and no
client library.

`opengso-prod` implements this spec. `opengso test` audits it. Both import the same header
constants from the same module, so the two can never drift apart on a spelling.

## Version string

```
X-AEO-Version: opengso/1.0
```

This names **OpenGSO's own published behaviour**, not a third party's standard. If OpenGSO changes
what it serves in a way an agent could notice, this string changes. An agent that does not recognise
the value should ignore it and fall back to plain content negotiation, which works regardless.

## The twin URL

Every HTML page may have a markdown twin at the same path with `.md` appended:

| Page | Twin |
|---|---|
| `/resume` | `/resume.md` |
| `/about/team` | `/about/team.md` |
| `/` | `/index.md` |
| `/docs/` | `/docs.md` (the trailing slash is normalised away first) |

The convention exists so an agent can guess, but guessing is the fallback, not the mechanism. The
HTML response advertises the twin explicitly (see `Link` below), and an agent that respects
content negotiation never needs the URL at all.

The twin is the **same content** as the HTML page in a cleaner format. It is not a summary, not an
abridgement, and not a different document. An implementation that serves different information at
the two URLs is cloaking, and this spec does not permit it.

## Negotiation

There are two ways to ask for markdown, and a correct implementation supports both.

### 1. The Accept header

```
GET /resume HTTP/1.1
Accept: text/markdown
```

Returns markdown at the original URL. This is HTTP content negotiation as RFC 9110 defines it, and
it works for agents nobody has heard of yet, which is the point.

### 2. A known AI User-Agent

```
GET /resume HTTP/1.1
User-Agent: Mozilla/5.0 (compatible; ClaudeBot/1.0; +...)
```

Returns markdown at the original URL, without an Accept header, for agents on the site's
`bots.markdownRouting` list. This is a courtesy for agents that do not send an Accept header, not a
replacement for negotiation.

OpenGSO's default list is every crawler it can recognise by User-Agent **except** the ones whose
job is a search index (Bingbot, Applebot, OAI-SearchBot, Claude-SearchBot, PerplexityBot and the
others marked `search` in the bot list). A markdown response carries `X-Robots-Tag: noindex`, and at
the canonical URL that would tell a search engine to drop the page itself. Those crawlers get the
HTML unless a site routes them on purpose, and can still ask for markdown with an Accept header.

### Rewrite, never redirect

Both paths **rewrite**: same URL, same status code, different body. Neither issues a 3xx.

A redirect would change the URL the agent records, break the link it cites, and cost a round trip.
Serving different bytes at the same URL is exactly what `Vary` exists to describe, which is why the
next section is not optional.

## Response headers

### On a markdown response

| Header | Value | Required |
|---|---|---|
| `Content-Type` | `text/markdown; charset=utf-8` | yes |
| `Vary` | includes `Accept` | yes |
| `X-AEO-Version` | `opengso/1.0` | yes |
| `X-Robots-Tag` | `noindex` | yes |
| `X-Content-Type-Options` | `nosniff` | yes |
| `X-Markdown-Tokens` | positive integer | recommended |
| `X-Markdown-Source-Hash` | hash of the extracted source | optional |
| `Last-Modified` | IMF-fixdate | optional |
| `ETag` | strong tag of the body, e.g. `"9f2c4e1a07b3d566"` | optional |
| `Cache-Control` | `private` | yes, when the User-Agent chose markdown |

`X-Robots-Tag: noindex` is required rather than recommended. Without it the twin is a duplicate of
every page on the site, offered to search engines as a separate document.

`X-Markdown-Tokens` is computed at generate time, not per request, so serving it costs nothing. The
estimate is `ceil(words x 1.3)`, minimum 1. It is an estimate and is documented as one; no
tokenizer is shipped and none is implied.

`X-Markdown-Source-Hash` and `Last-Modified` are OpenGSO's additions beyond the required set. They
exist so an auditor can detect drift without trusting the body: `opengso test`'s B14 check compares
the hash of a freshly extracted page against the hash the server claims. They are omitted rather
than faked when the manifest has nothing to report, because a wrong `Last-Modified` is worse than
none.

### Conditional requests

`ETag` is a hash of the markdown body, computed once when the twins are loaded. An agent that
re-reads a page sends it back as `If-None-Match`, and gets `304 Not Modified` with no body when the
twin is unchanged. The comparison is the weak one, so `W/"..."` matches the same tag, a list matches
if any entry does, and `*` matches any twin. `If-Modified-Since` is honoured only when there is no
`If-None-Match`, against `Last-Modified` to the second. A 304 carries `ETag`, `Vary`,
`Last-Modified`, `Cache-Control`, `X-Robots-Tag` and `X-AEO-Version`, which is what a cache updates
its stored copy from, and nothing that describes a body. Only a request that would have been
answered with markdown can get a 304: a browser's conditional request for the HTML page is the
site's to answer.

### On an HTML response

| Header | Value | Required |
|---|---|---|
| `Vary` | includes `Accept` | yes |
| `X-AEO-Version` | `opengso/1.0` | yes |
| `Link` | `</resume.md>; rel="alternate"; type="text/markdown"` | recommended, when a twin exists |

`Link` is omitted for routes with no generated twin, rather than advertising a URL that 404s.

### `Vary: Accept` goes on every response

Not only on markdown ones. A shared cache that stores the HTML variant without `Vary: Accept` will
serve that HTML to the next agent that asks for markdown, and the reverse. The header is what tells
the cache that these are two representations of one resource.

`Vary` is a comma-separated list of field names, so it must be read as whole tokens.
`Vary: Accept-Encoding` is on almost every compressed response and says nothing about content
negotiation. `Vary: *` counts.

### `Cache-Control: private` when the User-Agent chose the format

`Vary: Accept` describes markdown chosen by the Accept header, and the twin URL is markdown whatever
is asked. Markdown sent because a crawler's User-Agent is on the routing list is the one case it
does not describe: that crawler usually sends `Accept: */*`, the same as curl, so a shared cache
keyed on Accept would hand its markdown to the next plain client. Those responses, and only those,
carry `Cache-Control: private`. Adding `User-Agent` to `Vary` instead would split a cache into one
entry per browser build for every visitor, to fix a problem only crawlers have.

**Known limitation.** The Next.js App Router appends its own values to `Vary` on HTML responses and
offers no supported way to stop it. OpenGSO scores this as a partial (check B7 earns 2 of its 4)
rather than special-casing it, and the markdown responses carry a clean `Vary: Accept`. Behaviour behind a
cross-host CDN is documented as untested, not claimed.

## 406 Not Acceptable

When the Accept header excludes both HTML and markdown on a route that has a twin:

```
HTTP/1.1 406 Not Acceptable
Content-Type: text/plain; charset=utf-8
Vary: Accept
X-AEO-Version: opengso/1.0

406 Not Acceptable

This URL can be served as text/html or text/markdown.
Your Accept header asked for neither.
```

A 200 carrying the wrong content type is worse than a 406, because the client has no way to tell it
went wrong.

The 406 applies only to routes with a twin, because those are the only URLs where the two formats
are known to be the whole story. Every other request passes through to the application untouched,
whatever it asks for: `GET /api/users` with `Accept: application/json`, an event stream with
`Accept: text/event-stream` and a feed with `Accept: application/rss+xml` are the application's to
answer, not the middleware's.

## The two bot levers are separate

This is the part implementations most often get wrong, so it is spelled out.

**Lever 1, `bots.markdownRouting`, chooses a format.** An agent on this list gets markdown. An agent
not on it gets the normal HTML page, exactly like a human. This lever **never** blocks anybody, and
an agent OpenGSO has never heard of is never blocked by it. Unknown means unknown, not hostile.

**Lever 2, `bots.blocked`, requests no access.** It is opt-in, empty by default, and expressed only
through the `robots.txt` that `opengso generate` writes. It is advisory, as robots.txt always is.
A name whose robots token is not a plain token (letters, digits, `_`, `-` and `.`) is left out and
named in a comment in the file, so no entry can add directives of its own.

`opengso-prod` has **no blocking code path at all**. It cannot block a bot, because there is nothing
in it that could. Blocking lives in a static file that a crawler chooses to honour, which is where
it belongs and where a site owner can read it. A runtime that silently 403s on a User-Agent match is
a different product with different failure modes.

`opengso prod test` reports the two levers in separate sections and calls out disagreements between
them, for example a bot you route markdown to that your own robots.txt also disallows.

### `bots.custom` is not a third lever

A site can name agents OpenGSO does not ship with, under `bots.custom`. Each entry needs a `name`;
`vendor`, `uaPatterns`, `robotsToken` and `kind` are filled in from it when absent.

```jsonc
{ "name": "AcmeBot", "vendor": "Acme Inc", "uaPatterns": ["acme-crawler"], "kind": "assistant" }
```

These widen the catalogue that User-Agents are matched against, and nothing else. An entry here is
routed to only if its name also appears in `markdownRouting`, and disallowed only if it also appears
in `blocked`. An entry reusing the name of a built-in crawler is dropped rather than merged, so a
typo cannot silently shadow `GPTBot`. The resolved catalogue is built once at boot, like everything
else the runtime reads.

## Generated files

`opengso generate` writes four things from one crawl:

| File | Purpose |
|---|---|
| `public/md/<route>.md` | the twin, with YAML frontmatter |
| `public/robots.txt` | crawl permissions, including lever 2 |
| `public/llms.txt` | the table of contents an agent reads first |
| `public/sitemap.xml` | a real `<urlset>` |

It never overwrites a file it did not write. A `robots.txt` that exists without OpenGSO's
generated-by marker is left exactly as it is, and the proposed version is written beside it as
`robots.txt.opengso-proposed` with a warning. `--force` overrides this.

### Frontmatter

```yaml
---
title: "Engagement record"
url: "https://example.com/resume"
last_updated: "2026-10-21T06:44:50.371Z"
tokens: 432
source_hash: "9e7819e716242848"
generated_by: "opengso-free"
description: "A dated record of engagements, budgets, and outcomes."
---
```

`opengso-prod` strips the frontmatter before serving the body, and moves the same facts into
response headers. The frontmatter is for the file on disk; the headers are for the wire.

`generated_by` records which tier produced the file: `opengso-free` for the algorithmic extraction,
`opengso-ai` for the AI-assisted one. Setting it to `manual` by hand marks the file as yours, and
`opengso generate` will leave it alone from then on unless you pass `--force`.

`source_hash` is taken over the **extracted markdown**, not the raw HTML. Hashing raw HTML would
change on every framework rebuild and every hydration marker, and a staleness check that fires
constantly is a staleness check nobody reads.

## Bookkeeping that is not part of the spec

`.opengso/manifest.json` records route, file, token count, hash and timestamp for every generated
page. It lives outside the web root so it is never served, and it is what lets the runtime satisfy
"pure lookup, no parsing at request time": it is read once at startup, and every request after that
is a map lookup.

It is an implementation detail of this toolchain. An agent never sees it, and a different
implementation of this spec does not need one.

## Implementing this without OpenGSO

Nothing here requires OpenGSO. The spec is four ideas:

1. Serve the same content as markdown when asked, at the same URL.
2. Say so with `Vary: Accept` and a `Link: rel="alternate"`.
3. Do not index the twin.
4. Return 406 instead of guessing.

`opengso test` will audit any implementation of them, including one you wrote yourself. It probes
over HTTP and has no idea what is on the other end.
