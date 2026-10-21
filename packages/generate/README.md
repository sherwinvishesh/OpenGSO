# opengso-generate

> **Early release.** Until 1.0, a minor release may change a command, a flag, a config field or an export.

[Website](https://sherwinvishesh.github.io/OpenGSO/) · [Documentation](https://sherwinvishesh.github.io/OpenGSO/docs/#generate) · [GitHub](https://github.com/sherwinvishesh/OpenGSO) · [Changelog](https://github.com/sherwinvishesh/OpenGSO/blob/main/packages/generate/CHANGELOG.md)

Turns a live site into the files AI agents actually want: a clean Markdown twin of every page, plus
`robots.txt`, `llms.txt` and `sitemap.xml`, all from a single crawl.

- **The free tier needs no API key** and is the default. It is algorithmic, deterministic, and
  produces the markdown that everything else is measured against.
- **The AI tier is bring-your-own-key** and is fidelity-checked: if the model drops, alters or adds
  a single number, date or price, the output is thrown away and the algorithmic version is used
  instead.
- Never overwrites a file it did not write.

Part of [OpenGSO](https://github.com/sherwinvishesh/OpenGSO). This is the *authoring* half; the
files it writes are served by
[`opengso-prod`](https://github.com/sherwinvishesh/OpenGSO/blob/main/packages/prod/README.md).

## Install

Needs Node.js 22 or later.

```bash
npm install --save-dev opengso-generate
```

Generation is a local, deliberate act. It is a devDependency because it never runs in production,
and by design it never runs in CI either.

## Use

```bash
npx opengso generate http://localhost:3000
```

```
Usage: opengso generate <url> [options]
       opengso generate <folder> [options]
       opengso generate <folder>/<page>.html [options]

Options
  --tier <free|ai>   free is algorithmic and needs no key; ai is bring-your-own-key
  --origin <url>     where the site is published, e.g. https://example.com. Every link in
                     the twins, llms.txt and sitemap.xml names it. Remembered after the
                     first run from a folder, which may also be a site in a folder of its
                     host, e.g. https://user.github.io/repo.
  --check            only report the twins that are older than their page, and exit 1 if
                     any are. Writes nothing. For a folder of files; a crawled site is
                     checked by `opengso test` instead.
  --single           only the URL given, leaving every other page in the manifest alone
  --max-pages <n>    override crawl.maxPages
  --depth <n>        override crawl.maxDepth (crawling only)
  --timeout <secs>   how long to wait for each page while crawling (default: 20)
  --force            overwrite hand-written robots/llms/sitemap and .md files
  --skip-files       twins only, leave robots.txt / llms.txt / sitemap.xml alone
  --prune            delete orphaned twins: ones OpenGSO wrote for pages this run no longer
                     found. Without it they are only reported. Never deletes a file OpenGSO
                     did not write, and refuses on a run that hit a page cap or reached no page.
  --provider <name>  which AI tool to use. `opengso help providers` lists them all.
  --model <name>     model id for the AI tier
  --json             machine-readable output
  --project <dir>    project directory holding opengso.config.json (default: cwd)
```

### What a run prints

Against OpenGSO's bundled Next.js demo, three pages, nothing generated yet, with the colour
stripped:

```
$ opengso generate http://localhost:3000
OpenGSO generate  http://localhost:3000

  Discovering routes by following links
  [1/1] /
  [2/3] /about
  [3/3] /resume

  Converting pages

  Writing the site files

Pages
--------
  written /                        188 tokens  http://localhost:3000/index.md
  written /about                   205 tokens  http://localhost:3000/about.md
  written /resume                  432 tokens  http://localhost:3000/resume.md

Site files
----------
  written robots.txt               public/robots.txt
  written llms.txt                 public/llms.txt
  written sitemap.xml              public/sitemap.xml

  3 written, 0 unchanged in 126ms
  Output: public

Notes
--------
  warn sitemap.xml, robots.txt, llms.txt and every twin point at
       http://localhost:3000, which only this machine can reach. Deployed like
       this, they send crawlers and agents nowhere. Set "publicOrigin" in
       opengso.config.json to where the site is deployed, e.g.
       "https://example.com", and run generate again.

  Next: agents still get HTML until your server serves these twins. Add
  opengso-prod to it (its README has the few lines for Next.js, Express, Nuxt,
  SvelteKit, Astro, React Router, Angular, Qwik, Vite and edge functions), then
  run `opengso test http://localhost:3000` to check.
```

Every twin is named with its token count, because that is the number an agent pays. What the three
twins replaced, measured with `curl` against the running demo:

| Page | HTML an agent gets today | Twin | Tokens |
| --- | ---: | ---: | ---: |
| `/` | 10,191 bytes | 982 bytes | 188 |
| `/about` | 10,408 bytes | 883 bytes | 205 |
| `/resume` | 13,671 bytes | 1,886 bytes | 432 |

The note at the end is the one a first run on `localhost` always gets: the files name the address
that was crawled, so until `publicOrigin` names the deployed site they point at this machine.
The run as a whole, with the test before and after it, is recorded here:

![opengso test, generate and test again on the bundled Next.js demo: 65 of 100, then three twins and the three root files written in 126 milliseconds, then 100 of 100](https://raw.githubusercontent.com/sherwinvishesh/OpenGSO/main/docs/images/demo.svg)

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
.opengso/
  manifest.json        <- bookkeeping, outside the web root, never served
```

Everything an agent reads lives in the folder your framework serves from the site root, `public/`
for most and `static/` for SvelteKit, Gatsby and Docusaurus (generate says which it chose, and
`publicDir` in the config overrides it), so it deploys with your site and needs no build step. Set `publicOrigin` in `opengso.config.json` to the deployed address (`https://example.com`)
and every absolute URL in those files names it rather than the dev server that was crawled. Without
it, a run against `localhost` or `127.0.0.1` warns that the sitemap and twins point at this machine. `.opengso/manifest.json` holds the route table, token counts, content hashes and timestamps.
`opengso-prod` loads it once at startup, which is how a request becomes a map lookup.

A page that fails to fetch keeps the entry it had, so a 503 during a run never stops a twin being
served. If no page can be fetched at all, say because the dev server is not running, the whole
manifest is kept as it was and the run says so. Every file OpenGSO writes is written whole or not
at all, so a run stopped part way never leaves half a manifest behind, and a manifest that cannot
be read is reported rather than quietly treated as a first run.

A page the crawl no longer finds, because it was deleted or unlinked, leaves its manifest entry,
so llms.txt, sitemap.xml and `opengso-prod` stop listing it. Its twin is not deleted. Generate
reports it under "Orphaned twins" (and as `orphans` in `--json`) on every run until you act, and
the manifest keeps the list so the next run still knows which files are its own. Run generate again
with `--prune` to delete them. Pruning only ever deletes a file the manifest listed and whose
frontmatter still says OpenGSO generated it, so a twin you have marked `generated_by: manual` or
rewritten stays. It is refused on a run that stopped at `crawl.maxPages` or `crawl.maxDepth`, or
reached no page at all, because such a run cannot tell a deleted page from one it did not get to.

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

`opengso-prod` strips this before serving and moves the same facts into response headers.

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
integration per framework, forever, and OpenGSO is framework-agnostic on purpose. If a page is
reachable by a link, the crawl finds it; if it is not, list it in `extraRoutes`.

## From a folder of HTML files

```bash
npx opengso generate dist --origin https://example.com   # every page in dist/
npx opengso generate dist/pricing.html                   # one page, after you edit it
npx opengso generate --check                             # which pages changed since their twins
```

No server and no crawl: generate reads every `.html` file in the folder and writes each twin beside
its page, under the name a static host serves at the page's URL plus `.md`. So the twins need no
middleware at all.

| Page               | Its URL                            | Its twin                                |
| ------------------ | ---------------------------------- | --------------------------------------- |
| `index.html`       | `/`                                | `index.md`                              |
| `pricing.html`     | `/pricing.html`, or `/pricing`     | `pricing.html.md`, or `pricing.md`      |
| `about/index.html` | `/about`                           | `about.md`                              |

A page's URL is the file name unless the site says otherwise: a link to `/pricing`, or a canonical
link naming it, gives `pricing.html` the clean URL, and a page nothing links to follows the rest of
the site. `--origin` is the published address, used for every link in the twins, `sitemap.xml`,
`robots.txt` and `llms.txt`. Without it generate uses `publicOrigin` from the config, then the home
page's canonical link, and warns when it has nothing better than localhost. The first run writes
`opengso.config.json` with `"generate": { "source": "files" }`, so a bare `opengso generate` and the
dashboard read the same folder after that.

Each twin records the file it came from, its hash and its date. `--check` compares them with the
folder as it is now and names every page that changed, every page with no twin and every twin whose
page is gone. It writes nothing and exits 1 when anything is out of date, so it fits a pre-commit
hook.

For a site a tool builds, generate from what the tool writes and publish that folder: `dist` for
Vite and Astro, `docs/.vitepress/dist` for VitePress, `build` for Docusaurus, `out` for a Next.js
static export, `public` for Gatsby and Hugo, and `_site` for Jekyll and Eleventy. A rebuild usually
empties the folder, so run generate again after building and before you deploy; `--check` names
every page whose twin that took. The twin's name follows the page's: a tool that writes `guide.html`
gets `guide.html.md`, and one that writes `guide/index.html` (VitePress with `cleanUrls: true`,
Astro, Hugo) gets `guide.md`.

### A site in a folder of its host

```bash
npx opengso generate dist --origin https://user.github.io/repo
```

A GitHub Pages project site lives at `user.github.io/repo/`, and every URL generate writes then
carries the folder: `https://user.github.io/repo/about` in the sitemap, `.../repo/about.md` in
`llms.txt`. `robots.txt` is not written, because crawlers read it only at the root of the host,
which belongs to somebody else's site or to none; generate says what to add there if you publish
that root too. `opengso test https://user.github.io/repo/` looks for `llms.txt`, `sitemap.xml` and the
home page's twin inside the folder when the root of the host has none.

Generating from a folder is the only way to do this. A crawl's routes are paths on the server it
crawls, so `--origin` with a path is refused on a crawl, with the command to run instead.

### GitHub Pages and Jekyll

GitHub Pages runs a branch through Jekyll unless the folder holds a `.nojekyll` file, and Jekyll
turns every `.md` file with frontmatter, which is every twin, into an HTML page. When the folder is
one Pages publishes (it holds a `CNAME` file, or it is the root or the `docs/` folder of a repository
with a GitHub remote) and its pages are plain HTML, generate writes an empty `.nojekyll` beside them,
once, and says so. Commit it with the twins. A folder that is the source of a Jekyll site
(`_config.yml`, `_layouts/`, or pages that start with frontmatter) needs Jekyll to build it, so
generate writes nothing there and says to build the site and generate from `_site` instead.

## Never overwriting your files

If `robots.txt`, `llms.txt` or `sitemap.xml` already exists **without** OpenGSO's generated-by
marker, it is left exactly as it is. The marker counts only as the comment line OpenGSO writes
(`# Generated by OpenGSO (...)`, or `<!-- Generated by OpenGSO (...)` in the other two), so a file
that merely mentions the phrase is still yours. The proposed version is written beside it:

```
public/robots.txt                     <- yours, untouched
public/robots.txt.opengso-proposed    <- diff this, merge what you want
```

with a warning naming both paths. `--force` overwrites instead.

Twins follow the same rule. A file in `public/md/` is OpenGSO's only when its frontmatter says
`generated_by: opengso-free` or `opengso-ai`. One with no frontmatter, or another tool's, is left
alone, the new twin goes to `<name>.md.opengso-proposed`, and the page stays out of the manifest so
prod never serves a file OpenGSO cannot vouch for. Mark it `generated_by: manual` to have yours
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
opengso generate https://example.com --tier ai
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
opengso help providers                                        # the whole catalogue
opengso generate https://example.com --tier ai --provider xai
opengso generate https://example.com --tier ai --provider ollama   # local, no key, no network
```

Adding one OpenGSO does not ship with is three lines of config:
[docs/providers.md](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/providers.md).

The fidelity check runs on all of them. A cheaper model is a safe experiment here precisely because
a model that mangles or invents a price gets its output thrown away rather than written to disk.

### The key

Read from `.env` in your project, and nowhere else. Run `opengso settings` to write it, which also
adds
`.env` to `.gitignore` **before** it asks for the key.

It is sent to the provider you chose and to nobody else. There is no telemetry, no analytics and no
cloud sync in OpenGSO, so there is nothing else that could transmit it.

The AI tier refuses to run when it detects CI. Anything AI-touched is local-machine-only, on purpose:
regenerating on every push is how a site quietly diverges from what it says it is.

## Staleness

A markdown twin is a cache, and OpenGSO deliberately does not regenerate on a schedule or in CI. The
safety net is `last_updated` plus `opengso test`'s B14 check, which re-extracts the live page and
compares it against what is being served. Run `opengso test` after you deploy content changes, and
re-run generate when it tells you to.

## Documentation

The whole manual is one page on the website: [sherwinvishesh.github.io/OpenGSO/docs](https://sherwinvishesh.github.io/OpenGSO/docs/).
The sections this package needs are [Generate](https://sherwinvishesh.github.io/OpenGSO/docs/#generate), [Static sites](https://sherwinvishesh.github.io/OpenGSO/docs/#static), [Configuration](https://sherwinvishesh.github.io/OpenGSO/docs/#config), [AI providers](https://sherwinvishesh.github.io/OpenGSO/docs/#providers) and [Troubleshooting](https://sherwinvishesh.github.io/OpenGSO/docs/#troubleshooting).

The reference, on GitHub:

- [The wire spec](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/spec.md): `opengso/1.0`: which URL holds the markdown, the headers that say so, content negotiation and the 406.
- [`opengso.config.json`](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/config.md): every field the config takes, and which command writes it.
- [AI providers](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/providers.md): the built-in catalogue, where the key lives, and adding your own endpoint.
- [The check catalogue](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/checks.md): every check, its weight, what it looks at and why an agent cares.
- [Troubleshooting](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/troubleshooting.md): the problems people hit first, by the message you see.
- [Versioning](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/versioning.md): the package version and the spec version, and what each one promises.

The rest of the reference, including the architecture notes for contributors, is in
[`docs/`](https://github.com/sherwinvishesh/OpenGSO/tree/main/docs).
