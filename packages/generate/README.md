# opengeo-generate

> **Pre-release.** Nothing is published to npm yet, and the APIs may change before 1.0.

Turns a live site into the files AI agents actually want: a clean Markdown twin of every page, plus
`robots.txt`, `llms.txt` and `sitemap.xml`, all from a single crawl.

- **The free tier needs no API key** and is the default. It is algorithmic, deterministic, and
  produces the markdown that everything else is measured against.
- **The AI tier is bring-your-own-key** and is fidelity-checked: if the model drops, alters or adds
  a single number, date or price, the output is thrown away and the algorithmic version is used
  instead.
- Never overwrites a file it did not write.

Part of [OpenGEO](https://github.com/sherwinvishesh/OpenGEO). This is the *authoring* half; the
files it writes are served by
[`opengeo-prod`](https://github.com/sherwinvishesh/OpenGEO/blob/main/packages/prod/README.md).

## Install

Needs Node.js 22 or later.

```bash
npm install --save-dev opengeo-generate
```

Generation is a local, deliberate act. It is a devDependency because it never runs in production,
and by design it never runs in CI either.

## Use

```bash
npx opengeo generate http://localhost:3000
```

```
Usage: opengeo generate <url> [options]

Options
  --tier <free|ai>   free is algorithmic and needs no key; ai is bring-your-own-key
  --single           only the URL given, leaving every other page in the manifest alone
  --max-pages <n>    override crawl.maxPages
  --depth <n>        override crawl.maxDepth
  --force            overwrite hand-written robots/llms/sitemap and .md files
  --skip-files       twins only, leave robots.txt / llms.txt / sitemap.xml alone
  --prune            delete orphaned twins: ones OpenGEO wrote for pages this crawl no longer
                     found. Without it they are only reported. Never deletes a file OpenGEO
                     did not write, and refuses on a run that hit a crawl cap or reached no page.
  --provider <name>  which AI provider to use. `opengeo help providers` lists them (AI tier only)
  --model <name>     model id for the AI tier
  --json             machine-readable output
  --project <dir>    project directory holding opengeo.config.json (default: cwd)
```

## What it writes

```
public/
  md/
    index.md           <- served at /index.md
    about.md           <- served at /about.md
    resume.md          <- served at /resume.md
  robots.txt
  llms.txt
  sitemap.xml
.opengeo/
  manifest.json        <- bookkeeping, outside the web root, never served
```

Everything an agent reads lives under `public/`, so it deploys with your site and needs no build
step. Set `publicOrigin` in `opengeo.config.json` to the deployed address (`https://example.com`)
and every absolute URL in those files names it rather than the dev server that was crawled. Without
it, a run against `localhost` or `127.0.0.1` warns that the sitemap and twins point at this machine. `.opengeo/manifest.json` holds the route table, token counts, content hashes and timestamps.
`opengeo-prod` loads it once at startup, which is how a request becomes a map lookup.

A page that fails to fetch keeps the entry it had, so a 503 during a run never stops a twin being
served. If no page can be fetched at all, say because the dev server is not running, the whole
manifest is kept as it was and the run says so. Every file OpenGEO writes is written whole or not
at all, so a run stopped part way never leaves half a manifest behind, and a manifest that cannot
be read is reported rather than quietly treated as a first run.

A page the crawl no longer finds, because it was deleted or unlinked, leaves its manifest entry,
so llms.txt, sitemap.xml and `opengeo-prod` stop listing it. Its twin is not deleted. Generate
reports it under "Orphaned twins" (and as `orphans` in `--json`) on every run until you act, and
the manifest keeps the list so the next run still knows which files are its own. Run generate again
with `--prune` to delete them. Pruning only ever deletes a file the manifest listed and whose
frontmatter still says OpenGEO generated it, so a twin you have marked `generated_by: manual` or
rewritten stays. It is refused on a run that stopped at `crawl.maxPages` or `crawl.maxDepth`, or
reached no page at all, because such a run cannot tell a deleted page from one it did not get to.

### Frontmatter

```yaml
---
title: "Engagement record"
url: "https://example.com/resume"
last_updated: "2026-09-05T02:01:33.445Z"
tokens: 314
source_hash: "0cdc3ec67ce75fa0"
generated_by: "opengeo-free"
description: "A dated record of engagements, budgets, and outcomes."
---
```

`opengeo-prod` strips this before serving and moves the same facts into response headers.

Set `generated_by: manual` by hand to claim a file as yours. Generate will leave it alone from then
on unless you pass `--force`.

## The crawl

Same-origin breadth-first search over real `<a href>` links, starting from the URL you give it.
Depth and page caps come from your config (`crawl.maxDepth`, `crawl.maxPages`). The page cap counts
every request the crawl makes, a 404 or a redirect off the site included. Assets, anchors and
query-only variants of a page already seen are skipped. `extraRoutes` in the config adds pages that
nothing links to. An entry with a `.` or `..` segment is skipped with a warning, and no twin is ever
written outside `public/md/`. A page that redirects to another origin is skipped rather than written
as your twin, and a start URL that does (apex to `www`, `http` to `https`) is reported with the
address to run against instead. Two routes that would share a twin file, `/` and `/index`, or
`/About` and `/about` (one file on macOS and Windows), get one twin: the first is written and the
other is reported, never written over it.

It is not a router adapter and never will be. Reading a framework's route manifest means one
integration per framework, forever, and OpenGEO is framework-agnostic on purpose. If a page is
reachable by a link, the crawl finds it; if it is not, list it in `extraRoutes`.

## Never overwriting your files

If `robots.txt`, `llms.txt` or `sitemap.xml` already exists **without** OpenGEO's generated-by
marker, it is left exactly as it is. The marker counts only as the comment line OpenGEO writes
(`# Generated by OpenGEO (...)`, or `<!-- Generated by OpenGEO (...)` in the other two), so a file
that merely mentions the phrase is still yours. The proposed version is written beside it:

```
public/robots.txt                     <- yours, untouched
public/robots.txt.opengeo-proposed    <- diff this, merge what you want
```

with a warning naming both paths. `--force` overwrites instead.

Twins follow the same rule. A file in `public/md/` is OpenGEO's only when its frontmatter says
`generated_by: opengeo-free` or `opengeo-ai`. One with no frontmatter, or another tool's, is left
alone, the new twin goes to `<name>.md.opengeo-proposed`, and the page stays out of the manifest so
prod never serves a file OpenGEO cannot vouch for. Mark it `generated_by: manual` to have yours
served, or pass `--force` to replace it.

A tool that silently rewrites `robots.txt` is a tool that eventually takes a site off the internet.

## Caching

Every page's extracted content is hashed into the manifest. On a re-run, a page is skipped and
reported as cached only when that hash and its title, meta description and URL are all unchanged,
since those three go into the twin's frontmatter and `llms.txt` but not into the hash.

The hash is taken over the **extracted markdown**, not the raw HTML. Raw HTML changes on every
framework rebuild, every hydration marker, every build id, so hashing it would mean nothing is ever
cached and the staleness check would cry wolf until people stopped reading it. Hashing the
extraction means the hash changes exactly when the page's content changes.

## The AI tier

```bash
opengeo generate https://example.com --tier ai
```

The prompt is fidelity-locked: reproduce the structure and text faithfully, never summarise, never
paraphrase, never alter names, dates, prices or numbers.

Prompts are not a guarantee, so the output is verified rather than trusted. Every number, date,
price, currency amount and percentage in the algorithmic extraction must survive into the AI output,
with its sign and scale (`-4%` is not `4%`, `$1.2 million` is not `$1.2 billion`), and the AI output
may not state one the extraction does not. If either check fails, or the output is much shorter than
the page, the AI result is **discarded**, the algorithmic markdown is written instead, and you get a
warning naming the fact that went missing or appeared.

This makes "never alters your numbers" a property the code enforces, not a promise the prompt
makes. It is narrower than "never alters your facts": names and other words are not checked, a
model that swaps two figures the page states gets past it, and so does added prose with no numbers
in it. For those, the prompt is all there is, so read an AI twin before you ship it.

A call you pay for is not repeated for nothing. A rewrite that stopped at the model's output cap is
refused rather than accepted. A page too long to fit in that cap is never sent at all. And a page
whose rewrite was refused for either reason, or by the fidelity check, is remembered in the
manifest: the next run leaves it as it is until its content changes or you pass `--force`. A
provider error (a timeout, a 429) is not remembered, so that page is tried again next time.

### Which model

Any of twenty-five providers, including Anthropic, OpenAI, Gemini, xAI Grok, Alibaba Qwen, DeepSeek,
Kimi, GLM, Mistral, Perplexity, Groq, Cerebras, OpenRouter, Hugging Face, Ollama and LM Studio on
your own machine, and any endpoint you can name:

```bash
opengeo help providers                                        # the whole catalogue
opengeo generate https://example.com --tier ai --provider xai
opengeo generate https://example.com --tier ai --provider ollama   # local, no key, no network
```

Adding one OpenGEO does not ship with is three lines of config:
[docs/providers.md](https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/providers.md).

The fidelity check runs on all of them. A cheaper model is a safe experiment here precisely because
a model that mangles or invents a price gets its output thrown away rather than written to disk.

### The key

Read from `.env` in your project, and nowhere else. Run `opengeo settings` to write it, which also
adds
`.env` to `.gitignore` **before** it asks for the key.

It is sent to the provider you chose and to nobody else. There is no telemetry, no analytics and no
cloud sync in OpenGEO, so there is nothing else that could transmit it.

The AI tier refuses to run when it detects CI. Anything AI-touched is local-machine-only, on purpose:
regenerating on every push is how a site quietly diverges from what it says it is.

## Staleness

A markdown twin is a cache, and OpenGEO deliberately does not regenerate on a schedule or in CI. The
safety net is `last_updated` plus `opengeo test`'s B14 check, which re-extracts the live page and
compares it against what is being served. Run `opengeo test` after you deploy content changes, and
re-run generate when it tells you to.

## Reference

- [The wire spec](https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/spec.md)
- [The check catalogue](https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/checks.md)
- [AI providers, and adding your own](https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/providers.md)
