# The check catalogue

`opengeo test <url>` runs 22 checks against a live URL and turns them into a single number from
0 to 100. This page lists every check: what it looks at, why it matters to an AI agent, and what to
change when it fails.

There is no letter grade and no tier label anywhere in OpenGEO. A score is a percentage of the
points that actually applied to your page, and nothing else.

## How the score is computed

Every check carries a weight. Required checks are worth more than recommended ones, because a site
that fails a required check is not readable by agents at all, while one that fails a recommended
check is merely leaving something on the table.

| | Required | Recommended | Total |
|---|---|---|---|
| **A. Discoverability** | 40 | 10 | 50 |
| **B. Implementation** | 57 | 13 | 70 |
| **Total** | 97 | 23 | 120 |

```
score = round(100 x earned / applicable)
```

`applicable` is the sum of the weights of every check that returned pass or fail. A check that
returns **n/a** is dropped from the denominator entirely, never scored as a failure. That is the
difference between "your site is missing HSTS" and "you are testing against `http://localhost:3000`,
where HSTS is not a thing". Only the first should cost you points.

Partial credit does not exist. A check passes or it does not.

## Category A: can an AI agent find and understand this site at all

These checks apply to any site, whether or not it uses OpenGEO. You can pass all of category A
without installing anything.

### A1 - robots.txt exists and does not disallow known AI bots
**Required, weight 10.**

Fetches `/robots.txt` and reads it the way a crawler would: longest-match on `User-agent`, with the
wildcard group as the fallback. Fails when a rule disallows a known AI bot from the URL under test.

An agent that is disallowed here will usually not fetch your page at all, so this check gates
everything below it. If you deliberately block a crawler, that is a legitimate choice and this check
will report it as a failure anyway, because it cannot tell your intent from a mistake. Read the
reason line: it names the exact rule and the exact bot.

**Fix:** `opengeo generate` writes a `robots.txt` that allows every AI bot except the ones you list
in `bots.blocked`. Or hand-write one. A missing `robots.txt` also fails, because agents cannot tell
"no file" from "no answer".

### A2 - llms.txt is present and valid
**Required, weight 8.**

Fetches `/llms.txt` and checks that it is a real markdown document with an `# H1` title and at least
one link, not an HTML 404 page served with a 200.

`llms.txt` is the table of contents an agent reads first to decide what else to fetch. Without it,
an agent has to guess your site structure from links.

**Fix:** `opengeo generate` writes one from the same crawl that produces the twins.

### A3 - sitemap.xml is present and valid
**Required, weight 6.**

Fetches `/sitemap.xml` and parses it as a real `<urlset>` with at least one `<loc>`.

**Fix:** `opengeo generate` writes one. If your framework already generates a sitemap, keep it:
OpenGEO never overwrites a file it did not write.

### A4 - Schema.org JSON-LD is present and parses
**Recommended, weight 4.**

Looks for `<script type="application/ld+json">` in the HTML and parses it. A block that is present
but syntactically invalid fails, because that is worse than absent: it looks like structured data
and delivers none.

**Fix:** add a JSON-LD block describing the page. OpenGEO does not generate one for you, because the
right schema type depends entirely on what the page is.

### A5 - Real content is in the raw HTML, not only after JS runs
**Required, weight 10.**

Parses the raw HTML response with jsdom, with scripts disabled, and measures how many words of real
content survive. This is the single most important check in category A, because most agents do not
execute JavaScript. If your content only exists after hydration, those agents see an empty page.

**Fix:** server-render the content, or pre-render it at build time. There is no header you can set
that makes this one pass. If your site is a client-rendered SPA, OpenGEO's generate step will hit
the same wall and warn you about it.

### A6 - Time to first byte is fast enough for agent fetches
**Recommended, weight 3.**

Measures TTFB on the HTML request. Agents fetch under a timeout, often a short one, and a slow first
byte is the most common reason a page is silently skipped.

**Fix:** the usual server-side latency work. Note that the number is measured from wherever you are
running the CLI, so a cold serverless start or a slow network shows up here.

### A7 - No noai / noimageai tag is silently blocking AI
**Required, weight 6.**

Looks for `noai`, `noimageai` and equivalent directives in `<meta name="robots">` and in the
`X-Robots-Tag` response header.

These are easy to inherit from a template or a CMS default and then forget. A page that carries one
is asking agents to ignore it, which makes everything else you do pointless.

**Fix:** remove the directive, or accept the failure knowingly.

### A8 - Served over HTTPS with HSTS
**Recommended, weight 3.**

Checks the scheme and looks for `Strict-Transport-Security`.

**n/a on localhost.** Testing against `http://localhost:3000` returns n/a and drops the weight from
the denominator, because there is nothing to fix.

## Category B: is the markdown twin actually served correctly

These checks probe the runtime contract from the OpenGEO spec. They are what `opengeo-prod`
implements, and both sides import the same header constants, so the audit and the implementation
cannot disagree about a header name.

If you have not installed `opengeo-prod` or an equivalent, expect these to fail. That is the honest
answer, not a bug.

### B1 - Markdown twin URL is reachable and returns 2xx
**Required, weight 10.**

Requests `<path>.md` (so `/resume` becomes `/resume.md`, and `/` becomes `/index.md`) and expects a
2xx. Every other B check depends on this one.

**Fix:** run `opengeo generate` to write the twins, then install the middleware so they are served
with the right headers.

### B2 - Content-Type is exactly text/markdown; charset=utf-8
**Required, weight 6.**

An exact match, not a prefix match. `text/plain` fails. `text/markdown` without a charset fails.
Agents dispatch on this header, and the strictness is deliberate.

### B3 - Markdown response body is non-empty
**Required, weight 5.**

A twin that is served correctly and contains nothing is worse than no twin at all, because the agent
stops looking.

### B4 - X-Markdown-Tokens is present and a positive integer
**Recommended, weight 3.**

Lets an agent budget its context before it downloads the body. OpenGEO computes this at generate
time, so serving it costs no work at request time.

### B5 - X-Content-Type-Options: nosniff is present
**Recommended, weight 2.**

Stops a client from re-interpreting the markdown as something else.

### B6 - X-Robots-Tag on the twin includes noindex
**Required, weight 4.**

The twin is the same content as the HTML page. Without `noindex` you have published a duplicate of
every page on your site and asked search engines to index both.

### B7 - Vary includes Accept, so CDNs cache the two formats separately
**Required, weight 6.**

Parses `Vary` as a comma-separated token list and looks for `Accept` or `*` as a whole token.
`Vary: Accept-Encoding` does **not** count, and neither does any other header that merely contains
the substring.

Without this, a shared cache stores whichever format it saw first and serves it to everyone. A human
gets markdown, or an agent gets HTML. It is the most damaging failure in category B and the easiest
one to not notice, because it only shows up behind a CDN.

**Known limitation:** the Next.js App Router appends its own values to `Vary` on HTML responses and
there is no supported way to prevent it. `opengeo test` reports this as a real B7 failure on Next
HTML routes rather than pretending it passes. The markdown responses themselves carry a clean
`Vary: Accept`.

### B8 - HTML response advertises the twin via Link rel="alternate"
**Recommended, weight 4.**

`Link: </resume.md>; rel="alternate"; type="text/markdown"` on the HTML response. This is how an
agent that fetched the HTML discovers there is a better version available, without guessing at a
URL convention.

### B9 - Accept: text/markdown receives markdown, not HTML
**Required, weight 8.**

Requests the original URL with `Accept: text/markdown` and a browser User-Agent, so a markdown
response can only have been caused by the Accept header.

This is content negotiation as HTTP defines it, and it is the mechanism that works for agents
OpenGEO has never heard of.

### B10 - A known AI bot User-Agent receives markdown without an Accept header
**Required, weight 8.**

Requests the original URL with an AI bot User-Agent and a browser-typical Accept header, so a
markdown response can only have been caused by the User-Agent.

The two probes are deliberately separated. Together they tell you which lever is working; a single
combined probe would tell you only that something is.

### B11 - An Accept header excluding HTML and markdown returns 406
**Recommended, weight 2.**

Sends `Accept: application/pdf` and expects `406 Not Acceptable` rather than a cheerful 200 with the
wrong type.

### B12 - X-AEO-Version advertises the spec version implemented
**Recommended, weight 2.**

Expects `X-AEO-Version: opengeo/1.0`. This is OpenGEO's own version string, naming OpenGEO's
published behaviour and never a third party's spec. See [the spec](spec.md).

### B13 - The original HTML URL is still reachable and unaffected
**Required, weight 5.**

Requests the page as a browser would and checks that it is still HTML, still 2xx, and still the same
page.

This is the check that catches an over-eager middleware. Serving markdown to humans, or redirecting
them, is a worse outcome than not installing OpenGEO at all.

### B14 - The served markdown still matches the live page
**Required, weight 5.**

Re-extracts the live HTML, hashes the result, and compares it against the `X-Markdown-Source-Hash`
of the served twin and the `last_updated` in its frontmatter. When the hashes differ, it falls back
to comparing the concrete facts (numbers, dates, prices) that appear in the live page but not in the
twin, and names them.

This is the check no other tool can run, because it requires owning both halves of the pipeline. A
markdown twin is a cache, and every cache goes stale. OpenGEO does not regenerate on a schedule or
in CI by design, so this check plus `last_updated` is the safety net.

The hash is taken over the **extracted markdown**, not the raw HTML. Hashing raw HTML would change
on every framework rebuild, every hydration marker, every build id, and the check would cry wolf
until people stopped reading it.

**Fix:** re-run `opengeo generate`.

## Reading the output

Failures are grouped, required first:

```
Failed - required        the things that stop agents working
Failed - recommended     the things that make them work better
Passed                   everything that is already right
```

Each row carries the check id, what it verifies, and the **specific** reason it reached that
verdict, including the header value actually observed. No generic strings.

`--prompt` turns the failures into a fix prompt you can paste into a coding agent. It names only
`opengeo-prod` and OpenGEO's own documentation.

`--quality` adds an optional, clearly separated AI review of the content itself. It needs an API key,
refuses to run under CI, and is never folded into the 0 to 100 number.
