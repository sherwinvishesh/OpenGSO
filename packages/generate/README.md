# opengeo-generate

Turns a live site into the files AI agents actually want: a clean Markdown twin of every page, plus
`robots.txt`, `llms.txt` and `sitemap.xml`, all from a single crawl.

- **The free tier needs no API key** and is the default. It is algorithmic, deterministic, and
  produces the markdown that everything else is measured against.
- **The AI tier is bring-your-own-key** and is fidelity-checked: if the model drops or alters a
  single number, date or price, the output is thrown away and the algorithmic version is used
  instead.
- Never overwrites a file it did not write.

Part of [OpenGEO](https://github.com/sherwinvishesh/OpenGEO). This is the *authoring* half; the
files it writes are served by
[`opengeo-prod`](https://github.com/sherwinvishesh/OpenGEO/blob/main/packages/prod/README.md).

## Install

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
  --force            overwrite hand-written robots/llms/sitemap and manual .md files
  --skip-files       twins only, leave robots.txt / llms.txt / sitemap.xml alone
  --provider <name>  anthropic | openai | gemini (AI tier only)
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
step. `.opengeo/manifest.json` holds the route table, token counts, content hashes and timestamps.
`opengeo-prod` loads it once at startup, which is how a request becomes a map lookup.

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
Depth and page caps come from your config (`crawl.maxDepth`, `crawl.maxPages`). Assets, anchors and
query-only variants of a page already seen are skipped. `extraRoutes` in the config adds pages that
nothing links to.

It is not a router adapter and never will be. Reading a framework's route manifest means one
integration per framework, forever, and OpenGEO is framework-agnostic on purpose. If a page is
reachable by a link, the crawl finds it; if it is not, list it in `extraRoutes`.

## Never overwriting your files

If `robots.txt`, `llms.txt` or `sitemap.xml` already exists **without** OpenGEO's generated-by
marker, it is left exactly as it is. The proposed version is written beside it:

```
public/robots.txt                     <- yours, untouched
public/robots.txt.opengeo-proposed    <- diff this, merge what you want
```

with a warning naming both paths. `--force` overwrites instead.

A tool that silently rewrites `robots.txt` is a tool that eventually takes a site off the internet.

## Caching

Every page's extracted content is hashed into the manifest. On a re-run, unchanged pages are skipped
and reported as cached.

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
price, currency amount and percentage in the algorithmic extraction must survive into the AI output.
If any one of them does not, the AI result is **discarded**, the algorithmic markdown is written
instead, and you get a warning naming the fact that went missing.

This makes "never alters your facts" a property the code enforces, not a promise the prompt makes.

### The key

Read from `.env` in your project, and nowhere else. Run `opengeo setup` to write it, which also adds
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
