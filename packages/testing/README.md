# opengeo-testing

Scores any live URL from 0 to 100 on how readable it is to AI agents, and tells you exactly what
failed and why.

- Works on **any** site, whether or not it uses OpenGEO, whether or not you built it.
- No letter grades, no tier labels. A number and a list of specific reasons.
- `--prompt` turns the failures into a fix prompt you can paste into a coding agent.

Part of [OpenGEO](https://github.com/sherwinvishesh/OpenGEO).

## Install

```bash
npx opengeo-testing test https://example.com
```

or `npm install --save-dev opengeo-testing`.

## Use

```
Usage: opengeo test <url> [options]

Options
  --prompt           print a ready-to-paste fix prompt for your coding agent instead of a report
  --quality          add a separate AI content-quality review (needs a key, never runs in CI)
  --verbose, -v      show why each passing check passed, not just the failures
  --json             machine-readable output
  --out <file>       write the output to a file instead of stdout
  --provider <name>  anthropic | openai | gemini (--quality only)
  --model <name>     model id (--quality only)
  --project <dir>    project directory holding opengeo.config.json (default: cwd)
  --timeout <secs>   per-request timeout (default: 15)
```

## What it checks

22 checks in two categories. The
[full catalogue](https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/checks.md) explains every
one of them, including what to change when it fails.

**Category A, discoverability (50 points).** Applies to any site. `robots.txt`, `llms.txt`,
`sitemap.xml`, JSON-LD, whether real content survives with JavaScript disabled, TTFB, `noai` tags,
HTTPS and HSTS.

**Category B, implementation (70 points).** Probes the markdown-twin contract: is the twin
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
Passed                   everything that is already right
```

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

Framework detection covers Next.js, Nuxt, Astro, SvelteKit, Remix, Gatsby, Docusaurus, Vite and
plain HTML, so the prompt tells the agent where the middleware actually goes.

## `--quality`

An optional AI review of the content itself: keyword coverage, relevance, length, and concrete
suggestions.

It is printed as a **clearly separate section** and is never folded into the 0 to 100 number. The
structural score is deterministic and reproducible; a model's opinion is not, and blending the two
would make the number mean nothing.

It needs an API key (`opengeo setup`), and it refuses to run under CI. Without a key it says so and
the structural score is unaffected.

## Honest failures

Some things cannot be fixed, and this tool says so rather than quietly passing them.

The Next.js App Router appends its own values to `Vary` on HTML responses, replacing `Vary: Accept`,
with no supported way to prevent it. On a Next site, **B7 fails**, and the reason line prints the
exact `Vary` string Next produced. Special-casing it would make the tool useless for auditing
anything.

Behaviour behind a cross-host CDN is documented as untested rather than claimed.

## Reference

- [The check catalogue](https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/checks.md)
- [The wire spec](https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/spec.md)
