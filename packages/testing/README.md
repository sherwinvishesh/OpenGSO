# opengso-testing

> **Early release.** Until 1.0, a minor release may change a command, a flag, a config field or an export.

Scores any live URL from 0 to 100 on how readable it is to AI agents, and tells you exactly what
failed and why.

- Works on **any** site, whether or not it uses OpenGSO, whether or not you built it.
- No letter grades, no tier labels. A number and a list of specific reasons.
- `--prompt` turns the failures into a fix prompt you can paste into a coding agent, and `--copy`
  puts it straight on your clipboard, ready for Claude Code.
- An optional second pass has a model read the Markdown your site serves and rate how well it
  actually answers. It never touches the score.

Part of [OpenGSO](https://github.com/sherwinvishesh/OpenGSO).

## Install

Needs Node.js 22 or later.

```bash
npx opengso-testing test https://example.com
```

or `npm install --save-dev opengso-testing`.

## Use

```
Usage: opengso test <url> [options]

Modes
  (default)          the structural checks, then an AI review of the Markdown they find
  --structure        the checks only. Also --offline, -nq. No key, no model, no cost
  --content          the AI review only, for when you are editing the Markdown
  --quality, -q      require the review: a missing key becomes an error, not a note

Options
  --prompt           print a ready-to-paste fix prompt for your coding agent instead of a report
  --copy             put that fix prompt on the clipboard, ready to paste into Claude Code.
                     With --prompt it prints and copies; alone it copies after the report.
  --only <ids>       scope the prompt to some checks: --only A3 or --only B1,B7
  --strict           fail the build on a suggestion that fails too, not only on a scored check
  --verbose, -v      show why each passing check passed, not just the failures
  --json             machine-readable output
  --out <file>       write the output to a file instead of stdout
  --provider <name>  which AI provider to review with. `opengso help providers` lists them
  --model <name>     model id (the review only)
  --max-docs <n>     how many documents the review reads (default: 10)
  --project <dir>    project directory holding opengso.config.json (default: cwd)
  --timeout <secs>   per-request timeout (default: 15)
```

## Two passes, one command

```bash
opengso test https://example.com               # checks, then review if a key is configured
opengso test https://example.com --structure   # checks alone
opengso test https://example.com --content     # review alone
```

The default run does the structural audit first, then reviews every Markdown document that audit
found: the twin of the URL you named, everything `llms.txt` lists, and anything in `sitemap.xml`
that really answers with Markdown. Without a key it prints the structural report and one line
saying what it skipped, because the 0 to 100 score is the product and it has never needed a key.

The exit code always comes from the structural checks. A model's opinion never fails a build.

## What it checks

22 checks in two categories. The
[full catalogue](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/checks.md) explains every
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

Only the seven scored checks are in `applicable`. A suggestion is counted separately, adopted
against open, and a failed suggestion never fails a build unless you pass `--strict`. A check that
**cannot apply** to the target returns n/a and is dropped from the denominator rather than scored
as a failure. Testing against `http://localhost:3000` should not permanently cost you the HSTS
points, so it does not.

### The check nobody else can run

**B14** re-extracts the live page, hashes the result, and compares it against the hash and
`last_updated` of the markdown actually being served. When they differ it falls back to naming the
concrete facts (numbers, dates, prices) that are in the live page and missing from the twin.

This requires owning both halves of the pipeline: the thing that generated the markdown and the
thing that audits it. A markdown twin is a cache, and this is what tells you the cache went stale.

## Output

```
Failed                   scored checks that failed: these are what the 0-100 is missing
Partly there             scored checks half done, with the arithmetic shown
Suggestions              conventions outside the score that this page has not adopted yet
Locked                   suggestions that apply once B1 passes, shown as one block
Passed                   scored checks that are already right
Adopted                  suggestions this page already follows
Not applicable           cannot apply to this target, such as HSTS on localhost
```

Only the groups that have something in them are printed.

Seven checks make the 0-100: AI crawlers allowed in `robots.txt`, a valid `sitemap.xml`, real
content in the raw HTML, a fast first byte, no `noai` tag, HTTPS with HSTS, and the HTML page still
answering. The other fifteen are suggestions, counted on their own as "N of 15 adopted":
`llms.txt`, JSON-LD, the markdown twin and the headers around it. The best-read sites on the web
have not adopted those either, so not having them never moves the number. Adopting them is what
sets a site apart.

Every row carries the check id, what it verifies, and the specific reason for that verdict,
including the header value actually observed. Never a generic string.

A suggestion that fails on a twin the site already serves, a stale twin most often, is marked
`WARN` rather than `TIP` and listed first: the site adopted the convention and agents are being
sent something wrong. It stays outside the score, so `--strict` is what fails a build on it.

`--verbose` shows the reasoning behind the passes too, which is what you want when you do not
believe the number.

## Fix it with Claude Code: `--prompt` and `--copy`

```bash
opengso test https://example.com --copy              # the report, then the prompt on your clipboard
opengso test https://example.com --prompt            # the prompt instead of the report
opengso test https://example.com --prompt --only A3  # one check
opengso test https://example.com --copy --only B1,B7 # a few
```

Builds a fix prompt carrying the score, the URL, the expected twin URL, the detected framework, and
every failed check with its id, the points it cost, the actual observed reason, what to change, and
a "Done when" line naming the command that proves it fixed. Paste it into Claude Code, or any coding
agent with access to the repository. It references only `opengso-prod` and OpenGSO's own
documentation.

`--copy` uses the clipboard your system already has: `pbcopy` on macOS, PowerShell (then `clip`) on
Windows and WSL, `wl-copy`, `xclip` or `xsel` on Linux, and `termux-clipboard-set` on Termux. Over
SSH, with none of those, it falls back to OSC 52 and asks the terminal to set its clipboard, which
most modern terminals honour. When nothing works it says so, and `--prompt --out fix-prompt.md`
saves the prompt to a file instead. A failed copy never changes the exit code.

`--only` scopes the prompt to the checks you name, so a long list can be handed over one job at a
time. The prompt says the scope out loud, and tells the agent to leave every other check alone.

The same prompts are one click away in two other places. The dashboard (`opengso start`) draws a
**Fix it with Claude Code** card above the checks, a copy button on every group and every failing
check, and copies everything when you press `c`. The home screen (bare `opengso`) offers to copy
the prompt when a test run finishes.

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

It needs an API key (`opengso settings`) and refuses to run under CI. Any of twenty-five providers
can run it, including a model on your own machine:

```bash
opengso help providers                                          # the whole list
opengso test https://example.com --content --provider xai       # Grok
opengso test https://example.com --content --provider ollama    # local, no key
```

Bringing your own endpoint takes three lines of config. See
[docs/providers.md](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/providers.md).

## Honest failures

Some things cannot be fixed, and this tool says so rather than quietly passing them.

The Next.js App Router appends its own values to `Vary` on HTML responses, replacing `Vary: Accept`,
with no supported way to prevent it. On a Next site, **B7 is a partial, 2 of 4**: the markdown side
has the header and the HTML side does not, and the reason line prints the exact `Vary` string Next
produced. Special-casing it would make the tool useless for auditing
anything.

Behaviour behind a cross-host CDN is documented as untested rather than claimed.

## Reference

- [The check catalogue](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/checks.md)
- [AI providers, and adding your own](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/providers.md)
- [The wire spec](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/spec.md)
