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
| **A. Discoverability** | 52 | 5 | 57 |
| **B. Implementation** | 52 | 13 | 65 |
| **Total** | 104 | 18 | 122 |

```
score = round(100 x earned / applicable)
```

`applicable` is the sum of the weights of every check that returned pass, partial or fail. A check
that returns **n/a** or **locked** is dropped from the denominator entirely, never scored as a
failure. That is the difference between "your site is missing HSTS" and "you are testing against
`http://localhost:3000`, where HSTS is not a thing". Only the first should cost you points.

### Five verdicts, not two

| Verdict | In the denominator | Earns |
|---|---|---|
| **pass** | yes | the full weight |
| **partial** | yes | part of the weight, named in the row |
| **fail** | yes | nothing |
| **locked** | no | nothing, and not because of anything on this page |
| **n/a** | no | nothing, and there is nothing to fix |

Thirteen checks are graded rather than binary, because the thing they measure has a middle. Serving
`Vary: Accept` on the markdown response and not on the HTML is not the same as serving it nowhere,
and a report that scores those two identically is telling you something false. Every graded check
says below what a partial is worth and why.

A **partial never fails a build.** The exit code of `opengeo test` is nonzero only when a check has
status `fail`, and that rule did not change when partial credit arrived.

### One missing twin costs one check

If the markdown twin URL does not answer, the site has no markdown layer, and twelve of the
category B checks have nothing to look at. You cannot inspect the Content-Type of a document that
does not exist. Those twelve return **locked**, naming B1 as the check that unlocks them, and leave
the denominator. The whole verdict on the markdown layer is carried by B1, the heaviest check in
the table.

This matters more than it sounds. Scored the naive way, one missing file reads as thirteen separate
defects, and every site on the web that has not adopted the convention lands in the thirties. A
twin that exists but is served wrong is a different situation, and is still scored in full detail.

Locked is deliberately not spelled n/a. "Not applicable" is what A8 is on localhost: nothing to fix,
now or ever. A locked check is the opposite of that, so the report prints all twelve as one line
with a price on it rather than as twelve separate shrugs.

```
Locked (12)
-----------
  46 points waiting behind B1
    Serve a markdown twin at the .md URL and every one of these becomes measurable.

  B2 5  B3 5  B4 3  B5 3  B6 3  B12 2  B14 4  B7 4  B8 3  B9 6  B10 6  B11 2
```

### What the numbers are calibrated against

The weights are set so that the score means something to someone reading it:

- **B1 is the only double-digit check.** Serving the twin is the thing this toolkit exists for, so
  it is the largest single line in the scale and the first thing the report tells you to fix.
  Everything else is single digits, which means no individual header detail can sink a site that
  got the important things right.
- **A well-built site scores in the 80s without installing anything.** As of this writing
  `anthropic.com` and `openai.com` both score **80**: robots.txt open to AI crawlers, a real
  sitemap, content server-rendered into the HTML, a fast first byte, no opt-out tag, HTTPS with
  HSTS, and an HTML page that still works for humans. What they are missing is llms.txt, JSON-LD
  and the markdown layer, which is exactly the 20 points they do not have.

Both properties are pinned by tests, so a weight edit that breaks the calibration fails the suite.

## Category A: can an AI agent find and understand this site at all

These checks apply to any site, whether or not it uses OpenGEO. You can pass all of category A
without installing anything.

### A1 - robots.txt exists and does not disallow known AI bots
**Required, weight 9.**

Fetches `/robots.txt` and reads it the way a crawler would: the bot's own `User-agent` group, with
the wildcard group as the fallback, then the longest `Allow` or `Disallow` rule matching the path
under test (an `Allow` wins a tie, and `*` and a trailing `$` work as wildcards). Fails when that
rule disallows a known AI bot from the URL under test, so `Disallow: /docs/` counts when testing
`/docs/page`.

An agent that is disallowed here will usually not fetch your page at all, so this check gates
everything below it. If you deliberately block a crawler, that is a legitimate choice and this check
will report it as a failure anyway, because it cannot tell your intent from a mistake. Read the
reason line: it names the exact rule and the exact bot.

**Partial: 6.** Every assistant and search agent is allowed and only bulk training crawlers are
disallowed. That reads as a deliberate opt-out rather than a mistake, so it costs 3 points instead
of 9, and the reason line says so.

**Fix:** `opengeo generate` writes a `robots.txt` that allows every AI bot except the ones you list
in `bots.blocked`. Or hand-write one. A missing `robots.txt` also fails, because agents cannot tell
"no file" from "no answer", and so does an HTML page answering at `/robots.txt` (a catch-all route),
because a crawler finds no rules in it.

### A2 - llms.txt is present and valid
**Recommended, weight 3.**

Fetches `/llms.txt` and checks that it is a real markdown document with an `# H1` title and at least
one link, not an HTML 404 page served with a 200.

`llms.txt` is the table of contents an agent reads first to decide what else to fetch. Without it,
an agent has to guess your site structure from links.

It is recommended rather than required, and weighted lightly, because it is a young convention with
uneven crawler support: an agent that cannot find your `llms.txt` still has `sitemap.xml` and the
links on the page. Serving the twins matters more, which is why B1 is worth three times as much.

**Partial: 1** when the file is served but is empty or lists no links, **2** when it lists links
but has no `# Title` heading.

**Fix:** `opengeo generate` writes one from the same crawl that produces the twins.

### A3 - sitemap.xml is present and valid
**Required, weight 9.**

Fetches `/sitemap.xml` and parses it as a real `<urlset>` with at least one `<loc>`. A
`<sitemapindex>` is followed: the first 10 sitemaps it lists are fetched at their paths on the site
under test, and the page is looked for in those.

**Partial: 3** when something answers at that URL but has no `<urlset>` root or no `<loc>` entries
(for an index, when none of its sitemaps answers with a `<urlset>`), **6** when it is a valid
sitemap that does not list the page under test. An index listing more than 10 sitemaps, none of the
first 10 listing the page, passes with that limit stated, because the rest were not read.

**Fix:** `opengeo generate` writes one. If your framework already generates a sitemap, keep it:
OpenGEO never overwrites a file it did not write.

### A4 - Schema.org JSON-LD is present and parses
**Recommended, weight 2.**

Looks for `<script type="application/ld+json">` in the HTML and parses it. A block that is present
but does not parse earns only half, because it looks like structured data and delivers none: the
point it keeps is for having put the block there at all.

**Partial: 1** when a block is present but does not parse, or parses and declares no `@type`.

**Fix:** add a JSON-LD block describing the page. OpenGEO does not generate one for you, because the
right schema type depends entirely on what the page is.

### A5 - Real content is in the raw HTML, not only after JS runs
**Required, weight 9.**

Parses the raw HTML response with jsdom, with scripts disabled, and measures how many words of real
content survive. This is the single most important check in category A, because most agents do not
execute JavaScript. If your content only exists after hydration, those agents see an empty page.

**Partial:** ramped on how many words survive, from 15 up to the 60 a page needs to read as
substantive. A heading and a paragraph in the HTML with the rest behind hydration is real, and worth
something, and not the same as an empty mount element.

**Fix:** server-render the content, or pre-render it at build time. There is no header you can set
that makes this one pass. If your site is a client-rendered SPA, OpenGEO's generate step will hit
the same wall and warn you about it.

### A6 - Time to first byte is fast enough for agent fetches
**Required, weight 8.**

Measures TTFB on the HTML request. Agents fetch under a timeout, often a short one, and a slow first
byte is the most common reason a page is silently skipped.

**Partial:** ramped. Full marks at or under **400ms**, nothing at or over **1500ms**, and a straight
line between the two.

**Fix:** the usual server-side latency work. Note that the number is measured from wherever you are
running the CLI, so a cold serverless start or a slow network shows up here.

### A7 - No noai / noimageai tag is silently blocking AI
**Required, weight 8.**

Looks for `noai`, `noimageai` and equivalent directives in `<meta name="robots">` and in the
`X-Robots-Tag` response header.

These are easy to inherit from a template or a CMS default and then forget. A page that carries one
is asking agents to ignore it, which makes everything else you do pointless.

**Fix:** remove the directive, or accept the failure knowingly.

### A8 - Served over HTTPS with HSTS
**Required, weight 9.**

Checks the scheme the page is finally served over and looks for `Strict-Transport-Security`. An
`http://` URL that redirects to `https://` is judged on the HTTPS response it lands on, since that is
what an agent ends up talking to.

**Partial: 6.** Served over HTTPS with no `Strict-Transport-Security` header. The connection is
encrypted; a first visit can still be downgraded.

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
2xx that is not an HTML page. A single-page app or catch-all route that answers every path with its
HTML shell has no twin, so it fails here and locks the rest. Every other B check depends on this one.

**Fix:** run `opengeo generate` to write the twins, then install the middleware so they are served
with the right headers.

### B2 - Content-Type is exactly text/markdown; charset=utf-8
**Required, weight 5.**

An exact match, not a prefix match. Agents dispatch on this header, and the strictness is
deliberate.

**Partial: 3** for `text/markdown` with no charset, **2** for `text/plain`. Both are served and both
are readable; neither is what an agent selecting on the media type will find.

### B3 - Markdown response body is non-empty
**Required, weight 5.**

A twin that is served correctly and contains nothing is worse than no twin at all, because the agent
stops looking.

**Partial:** ramped on the twin's word count against the live page's, from 8% up to 50%. Non-empty is
the letter of the check and complete is the point of it, so a twin holding a title and nothing else
earns close to nothing.

### B4 - X-Markdown-Tokens is present and a positive integer
**Recommended, weight 3.**

Lets an agent budget its context before it downloads the body. OpenGEO computes this at generate
time, so serving it costs no work at request time.

### B5 - X-Content-Type-Options: nosniff is present
**Recommended, weight 3.**

Stops a client from re-interpreting the markdown as something else.

### B6 - X-Robots-Tag on the twin includes noindex
**Required, weight 3.**

The twin is the same content as the HTML page. Without `noindex` you have published a duplicate of
every page on your site and asked search engines to index both.

**Partial: 1** when the header is present but does not include `noindex`.

### B7 - Vary includes Accept, so CDNs cache the two formats separately
**Required, weight 4.**

Parses `Vary` as a comma-separated token list and looks for `Accept` or `*` as a whole token.
`Vary: Accept-Encoding` does **not** count, and neither does any other header that merely contains
the substring.

Without this, a shared cache stores whichever format it saw first and serves it to everyone. A human
gets markdown, or an agent gets HTML. It is the most damaging failure in category B and the easiest
one to not notice, because it only shows up behind a CDN.

**Partial: 2** when `Accept` is in `Vary` on one of the two responses and not the other. Half the
cache is keyed correctly; the reason line names which half is not.

**Known limitation:** the Next.js App Router appends its own values to `Vary` on HTML responses and
there is no supported way to prevent it. `opengeo test` reports this as a real B7 partial on Next
HTML routes rather than pretending it passes. The markdown responses themselves carry a clean
`Vary: Accept`, which is the 2 points it earns.

### B8 - HTML response advertises the twin via Link rel="alternate"
**Recommended, weight 3.**

`Link: </resume.md>; rel="alternate"; type="text/markdown"` on the HTML response. This is how an
agent that fetched the HTML discovers there is a better version available, without guessing at a
URL convention.

**Partial: 1** when a `Link` header is present but carries no `rel="alternate"` entry of type
`text/markdown`, or when the twin it advertises is on another origin or is not `http` or `https`.
OpenGEO never fetches an advertised twin like that. It reports the URL and tests the twin at the
conventional address on the site's own origin instead.

### B9 - Accept: text/markdown receives markdown, not HTML
**Required, weight 6.**

Requests the original URL with `Accept: text/markdown` and OpenGEO's own User-Agent, which is on no
bot list, so a markdown response can only have been caused by the Accept header.

This is content negotiation as HTTP defines it, and it is the mechanism that works for agents
OpenGEO has never heard of.

### B10 - A known AI bot User-Agent receives markdown without an Accept header
**Required, weight 6.**

Requests the original URL with a GPTBot User-Agent and `Accept: */*`, the header most crawlers send,
so a markdown response can only have been caused by the User-Agent. When the project's
`bots.markdownRouting` leaves GPTBot out, the probe is the first crawler on that list instead, so a
crawler you chose not to route is never held against you.

The two probes are deliberately separated. Together they tell you which lever is working; a single
combined probe would tell you only that something is.

### B11 - An Accept header excluding HTML and markdown returns 406
**Recommended, weight 2.**

Sends `Accept: application/pdf`, the same request `opengeo prod test` makes, and expects
`406 Not Acceptable` rather than a cheerful 200 with the wrong type.

### B12 - X-AEO-Version advertises the spec version implemented
**Recommended, weight 2.**

Expects `X-AEO-Version: opengeo/1.0`. This is OpenGEO's own version string, naming OpenGEO's
published behaviour and never a third party's spec. See [the spec](spec.md).

### B13 - The original HTML URL is still reachable and unaffected
**Required, weight 9.**

Requests the page as a browser would and checks that it is still HTML, still 2xx, and still the same
page.

This is the check that catches an over-eager middleware. Serving markdown to humans, or redirecting
them, is a worse outcome than not installing OpenGEO at all.

### B14 - The served markdown still matches the live page
**Required, weight 4.**

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

**Partial: 2** when the hash differs but every number, date and price on the live page still appears
in the twin. A typo fix and a rewritten page both break the hash, and only one of them is serving
agents wrong information.

**Fix:** re-run `opengeo generate`.

## Reading the output

Rows are grouped, worst first:

```
Failed - required        the things that stop agents working
Failed - recommended     the things that make them work better
Partly there             credit earned, with the rest of the points priced
Locked                   waiting on one other fix, collapsed into a single line
Passed                   everything that is already right
Not applicable           nothing to fix here, on this URL
```

Each row carries the check id, what it verifies, and the **specific** reason it reached that
verdict, including the header value actually observed. No generic strings. A partial row also shows
a small meter and the split, `2 of 4`, so the shape of the shortfall is readable without reading the
sentence.

The report ends with **Do this next**: every available fix ranked by the points it recovers, so the
top line is always the most valuable edit you can make to the page.

`--prompt` turns that same list into a fix prompt you can paste into a coding agent, partials and
the one locked-by fix included. It names only `opengeo-prod` and OpenGEO's own documentation.

## The other half of a test run

Everything above is the **structural** pass: deterministic, free, and the only thing that produces
the 0 to 100 number. A test run has a second, optional pass, and the two never mix.

| Command | What runs |
| --- | --- |
| `opengeo test <url>` | The checks, then an AI review of every Markdown document they found. The review is skipped with a note when no key is configured. |
| `opengeo test <url> --structure` | The checks alone. Also spelled `--offline` and `-nq`. |
| `opengeo test <url> --content` | The AI review alone, for the loop where you are editing the Markdown. |
| `opengeo test <url> -q` | The full run, with the review required rather than optional. |

The content review reads the documents your site actually serves and gives them **their own score
out of 100**, weighted across five areas:

| Area | Worth | What it asks |
| --- | --- | --- |
| Answerability | 30 | Could an agent answer a real question from this document alone? |
| Specificity | 25 | Concrete facts, numbers, prices, dates and versions, or adjectives? |
| Definition | 20 | Is it obvious in the first few lines what this is and who it is for? |
| Structure | 15 | Headings that describe their content, sensible order, sensible length? |
| Keywords | 10 | Are the words someone would search for present, and used naturally? |

The weights are an opinion about who the document is for: an agent answering somebody's question
that cannot follow a link to find out more. Answerability and specificity carry more than half the
score between them. Keywords carry the least, because they are the easiest thing to add and the
least useful to a reader already looking at the page.

The score is derived from the five area scores rather than asked for as one number, so it can be
explained line by line: the report prints what each area is costing you out of 100, then a
prioritised list of specific edits, each naming where in the document to make it and what a reader
gains. An area the model did not score leaves the denominator rather than counting as zero, the
same rule `n/a` checks follow above.

It needs an API key, refuses to run under CI, prints as its own section, and is **never** folded
into the structural 0 to 100. Two numbers, two questions: is the Markdown served correctly, and is
it worth reading. The exit code always comes from the structural checks, so a model's opinion
cannot fail a build.

Any of a dozen providers can run it, including one on your own machine. See
[providers.md](providers.md).
