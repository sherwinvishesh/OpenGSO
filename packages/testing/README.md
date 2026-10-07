# opengeo-testing

> **Pre-release.** Nothing is published to npm yet, and the APIs may change before 1.0.

Scores any live URL from 0 to 100 on how readable it is to AI agents, and tells you exactly what
failed and why.

- Works on **any** site, whether or not it uses OpenGEO, whether or not you built it.
- No letter grades, no tier labels. A number and a list of specific reasons.
- `--prompt` turns the failures into a fix prompt you can paste into a coding agent.
- An optional second pass has a model read the Markdown your site serves and rate how well it
  actually answers. It never touches the score.

Part of [OpenGEO](https://github.com/sherwinvishesh/OpenGEO).

## Install

Needs Node.js 22 or later.

```bash
npx opengeo-testing test https://example.com
```

or `npm install --save-dev opengeo-testing`.

## Use

```
Usage: opengeo test <url> [options]

Modes
  (default)          the structural checks, then an AI review of the Markdown they find
  --structure        the checks only. Also --offline, -nq. No key, no model, no cost
  --content          the AI review only, for when you are editing the Markdown
  --quality, -q      require the review: a missing key becomes an error, not a note

Options
  --prompt           print a ready-to-paste fix prompt for your coding agent instead of a report
  --verbose, -v      show why each passing check passed, not just the failures
  --json             machine-readable output
  --out <file>       write the output to a file instead of stdout
  --provider <name>  which AI provider to review with. `opengeo help providers` lists them
  --model <name>     model id (the review only)
  --max-docs <n>     how many documents the review reads (default: 10)
  --project <dir>    project directory holding opengeo.config.json (default: cwd)
  --timeout <secs>   per-request timeout (default: 15)
```

## Two passes, one command

```bash
opengeo test https://example.com               # checks, then review if a key is configured
opengeo test https://example.com --structure   # checks alone
opengeo test https://example.com --content     # review alone
```

The default run does the structural audit first, then reviews every Markdown document that audit
found: the twin of the URL you named, everything `llms.txt` lists, and anything in `sitemap.xml`
that really answers with Markdown. Without a key it prints the structural report and one line
saying what it skipped, because the 0 to 100 score is the product and it has never needed a key.

The exit code always comes from the structural checks. A model's opinion never fails a build.

## What it checks

22 checks in two categories. The
[full catalogue](https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/checks.md) explains every
one of them, including what to change when it fails.

**Category A, discoverability (weights totalling 57).** Applies to any site. `robots.txt`, `llms.txt`,
`sitemap.xml`, JSON-LD, whether real content survives with JavaScript disabled, TTFB, `noai` tags,
HTTPS and HSTS.

**Category B, implementation (weights totalling 65).** Probes the markdown-twin contract: is the twin
reachable, is the content type exact, does `Accept: text/markdown` actually get markdown, does an AI
User-Agent, does `Vary` include `Accept`, is the twin `noindex`, is the HTML page still untouched,
and has the twin drifted from the live page.

### The score

```
score = round(100 x earned / applicable)
```

Required checks weigh more than recommended ones. A check that **cannot apply** to the target
returns n/a and is dropped from the denominator rather than scored as a failure. Testing against
`http://localhost:3000` should not permanently cost you the HSTS points, so it does not.

### The check nobody else can run

**B14** re-extracts the live page, hashes the result, and compares it against the hash and
`last_updated` of the markdown actually being served. When they differ it falls back to naming the
concrete facts (numbers, dates, prices) that are in the live page and missing from the twin.

This requires owning both halves of the pipeline: the thing that generated the markdown and the
thing that audits it. A markdown twin is a cache, and this is what tells you the cache went stale.

## Output

```
Failed - required        the things that stop agents working
Failed - recommended     the things that make them work better
Partly there             half done: earns part of its weight, with the arithmetic shown
Locked                   could not be measured because B1 failed, priced as one line
Passed                   everything that is already right
Not applicable           cannot apply to this target, such as HSTS on localhost
```

Only the groups that have something in them are printed.

Every row carries the check id, what it verifies, and the specific reason for that verdict,
including the header value actually observed. Never a generic string.

`--verbose` shows the reasoning behind the passes too, which is what you want when you do not
believe the number.

## `--prompt`

```bash
opengeo test https://example.com --prompt
```

Prints a fix prompt carrying the score, the URL, the expected twin URL, the detected framework, and
every failed check with its id, the points it cost, and the actual observed reason. It references
only `opengeo-prod` and OpenGEO's own documentation.

Anything the site sent, such as a header value or a JSON-LD field, is quoted as a single-line code
span and cut at 400 characters, and the prompt tells the agent that those spans are evidence and
not instructions. A server cannot use its own responses to add steps to the prompt.

Framework detection covers Next.js, Nuxt, Astro, SvelteKit, Remix, Gatsby, Docusaurus, Hugo,
Jekyll, WordPress, Vite and plain HTML, so the prompt tells the agent where the middleware actually
goes. It matches only markers a framework emits itself, never a word in the page's text.

## The content review

The structural checks answer "can an agent get your Markdown". They cannot answer "is the Markdown
worth having". The content review is the second question, and it has **its own score out of 100**:

| Area | Worth | What it asks |
| --- | --- | --- |
| Answerability | 30 | Could an agent answer a real question from this document alone? |
| Specificity | 25 | Concrete facts, numbers, prices, dates and versions, or adjectives? |
| Definition | 20 | Is it obvious in the first few lines what this is and who it is for? |
| Structure | 15 | Headings that describe their content, sensible order, sensible length? |
| Keywords | 10 | Are the words someone would search for present, and used naturally? |

The reader being judged for is an agent answering somebody's question that cannot click a link and
will not come back, which is why answerability and specificity carry more than half the score.

Output leads with the score, then where the points went, then what to change:

```
  62/100  ###############.........  content, across 4 documents
      Usable, but vague in places a reader would notice.

  Where the points went (38 lost, costliest first)
      Specificity     ####......   45/100  -14 of 25
      Answerability   ######....   62/100  -11 of 30
      ...

  What to change first

   1  high   Specificity
      Add the price and billing period next to each plan name.
      An agent asked what the team plan costs can answer instead of guessing.
      ## Pricing  https://example.com/pricing.md
```

Each edit names the area it lifts, where in the document to make it, and what the reader gains. An
edit two pages both need appears once, with both URLs on it.

It is printed as a **clearly separate section** and is never folded into the structural 0 to 100.
Two numbers, two questions. The structural score is deterministic and reproducible; a model's
opinion is not, and blending the two would make both meaningless.

It needs an API key (`opengeo settings`) and refuses to run under CI. Any of a dozen providers can
run it, including a model on your own machine:

```bash
opengeo help providers                                          # the whole list
opengeo test https://example.com --content --provider xai       # Grok
opengeo test https://example.com --content --provider ollama    # local, no key
```

Bringing your own endpoint takes three lines of config. See
[docs/providers.md](https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/providers.md).

## Honest failures

Some things cannot be fixed, and this tool says so rather than quietly passing them.

The Next.js App Router appends its own values to `Vary` on HTML responses, replacing `Vary: Accept`,
with no supported way to prevent it. On a Next site, **B7 is a partial, 2 of 4**: the markdown side
has the header and the HTML side does not, and the reason line prints the exact `Vary` string Next
produced. Special-casing it would make the tool useless for auditing
anything.

Behaviour behind a cross-host CDN is documented as untested rather than claimed.

## Reference

- [The check catalogue](https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/checks.md)
- [AI providers, and adding your own](https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/providers.md)
- [The wire spec](https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/spec.md)
