# Open Generative Engine Optimization (OpenGEO)

> **Pre-release.** Nothing is published to npm yet, and the APIs may change before 1.0.

An open-source, framework-agnostic npm toolkit that makes any website readable by AI agents.

AI agents like ChatGPT, Claude, Gemini, and Perplexity strongly prefer clean markdown over full HTML/CSS/JS. It's cheaper to read, and many agents don't execute JavaScript at all, so client-rendered content is often invisible to them. OpenGEO fixes that across three pillars in one toolchain:

- **Test**: score a live site's AI-readiness from 0 to 100, generate a ready-to-paste fix prompt for coding agents, and optionally have a model read the markdown you serve and rate how well it answers.
- **Generate**: produce a clean `.md` twin of every page, plus `robots.txt`, `llms.txt`, and `sitemap.xml`.
- **Prod**: serve the right format at runtime by detecting whether the visitor is a human or an AI agent.

Unlike existing tools, which each solve one piece and are usually locked to a single framework or CMS, OpenGEO works across the whole JS ecosystem, including React, Vue, Svelte, Remix, Vite, and vanilla JS.

## Quickstart

Needs Node.js 22 or later.

```bash
npm install --save-dev opengeo

npx opengeo                                         # the terminal app: where you stand, and what to do
npx opengeo start                                   # set the project up, then open the dashboard
npx opengeo test https://your-site.com              # score it as it is today
npx opengeo generate https://your-site.com          # write the twins and the three root files
# wire opengeo-prod into your server: Next, Express, Nuxt, SvelteKit, Astro, a Worker...
npx opengeo prod test https://your-site.com         # prove the deployment serves them correctly
npx opengeo test https://your-site.com              # score it again
```

`opengeo` on its own opens the home screen: your project, its last score, how many twins it has,
and a menu of everything there is to do. It is the one command worth remembering. Piped or run from
a script it prints the help page instead, so nothing that shells out to it changes behaviour.

`opengeo start` asks four questions the first time it runs in a directory: your site URL and web
root, which AI agents get the markdown twin, blocking, and an optional API key. After that it goes
straight to the dashboard. To change any of those answers later, in the terminal:

```bash
npx opengeo settings
```

Nothing here needs an API key. Generate's free tier, every structural test, and all of
`opengeo-prod` run offline. A key only buys generate's AI polish tier and `opengeo test --content`,
and when you set one it lives in `.env`, on your machine, and is only ever sent to the AI provider
you picked. There is no telemetry and no cloud sync.

The key goes in `.env` under the name your provider documents, such as `ANTHROPIC_API_KEY`. If
the line is there under a name of your own, like `claude_api`, OpenGEO does not guess: it names the
line and tells you what to rename it to.

## Testing in two passes

```bash
npx opengeo test https://your-site.com              # the checks, then a review of the markdown
npx opengeo test https://your-site.com --structure  # the checks alone. No key, no cost
npx opengeo test https://your-site.com --content    # the review alone
```

The structural pass is the 0 to 100 score: deterministic, free, reproducible. Seven of its 22
checks make the number (crawler access, sitemap, server-rendered content, speed, no opt-out tag,
HTTPS, a working HTML page), so a well-built site scores 100 without installing anything. The other
fifteen are suggestions, counted as "N of 15 adopted": `llms.txt`, JSON-LD and the markdown layer
OpenGEO builds. They never lower the score, and they are what sets a site apart. `--strict` makes a
failing suggestion fail CI too.

The content pass is a
model reading the markdown documents your site actually serves and rating five things per document,
definition, keywords, specificity, answerability, and structure and length. The two are printed as
separate sections and the second is **never** folded into the number. The exit code always comes
from the checks, so a model's opinion cannot fail your build. Without a key the default run does the
structural half and says in one line what it skipped.

### Hand the fixes to Claude Code

```bash
npx opengeo test https://your-site.com --copy               # the report, then a fix prompt on your clipboard
npx opengeo test https://your-site.com --prompt --only A3   # the prompt for one check, printed
```

The fix prompt names every failing check, what the site actually served, what to change, and the
command that proves each fix, so a coding agent can work through it without guessing. Paste it into
Claude Code. The dashboard has the same prompts behind a copy button on every group and every
failing check (press `c` to copy them all), and the home screen offers to copy one after a test.

## A folder of HTML files? Point it at the folder

If your site is plain HTML files, hand-written, exported by a static site generator or handed to you
by an AI tool, generate reads them straight off disk. No server to run and no crawl.

```bash
npx opengeo generate site --origin https://your-site.com   # every page in site/
npx opengeo generate site/pricing.html                      # one page, after you edit it
npx opengeo generate --check                                # which pages changed since their twins
```

Each twin is written beside its page, so any static host serves it with no middleware:
`pricing.html` gets `pricing.html.md`, `index.html` gets `index.md` and `about/index.html` gets
`about.md`. `--origin` is the address the site is published at, used for every link in the twins,
`sitemap.xml`, `robots.txt` and `llms.txt`, and it is remembered after the first run.

Each twin records the file it was made from and when, so OpenGEO knows when they drift apart. Edit
`pricing.html` after generating and `opengeo generate --check` names it and exits 1, the home screen
says "1 out of date", and the dashboard shows it in a banner. A page with no twin yet and a twin
whose page was deleted are caught the same way. `--check` writes nothing, so it fits a pre-commit
hook.

On GitHub Pages it works for a project site in a folder too: `--origin https://user.github.io/repo`
puts the folder in every URL, and generate writes the `.nojekyll` file that stops Jekyll from
turning the twins into HTML pages. See
[From a folder of HTML files](packages/generate/README.md#from-a-folder-of-html-files).

## Bring any AI provider

Twenty-five of them out of the box, and the twenty-fifth is "something else":

```
anthropic  openai  gemini  xai  mistral  deepseek  qwen  kimi  zai  minimax  cohere
perplexity  openrouter  groq  together  fireworks  cerebras  sambanova  deepinfra
huggingface  nvidia  novita  ollama  lmstudio (both on your machine, no key)  custom
```

Type the name you know and it works it out: `--provider claude`, `kwen` or `grok` asks whether you
meant `anthropic`, `qwen` or `xai`. A key you already exported for another tool is picked up as it
is, and on its default models OpenGEO turns thinking off or as low as it goes, since a rewrite is
not a reasoning job.

```bash
npx opengeo help providers                          # the full catalogue with keys links
npx opengeo test https://your-site.com --provider groq
npx opengeo settings                                # pick one interactively
```

Anything speaking the OpenAI, Anthropic or Gemini request shape works, including a company gateway
or a self-hosted server. Adding one is three lines of config, not a fork:
[docs/providers.md](docs/providers.md).

## Which package do I install

Install the narrowest one that does what you need. They all expose the same `opengeo` command, and
if you ask one for something it does not ship, it tells you which package to install instead.

| Package | Ships | Install it when |
| --- | --- | --- |
| [`opengeo`](packages/opengeo/README.md) | everything, plus the local dashboard | you want the whole thing, or you want a UI |
| [`opengeo-cli`](packages/cli/README.md) | `test`, `generate`, `prod test`, `prod data`, `settings` | you want the whole toolchain, terminal only |
| [`opengeo-testing`](packages/testing/README.md) | `test` | you only want to score a site |
| [`opengeo-generate`](packages/generate/README.md) | `generate` | you only want the markdown twins and root files |
| [`opengeo-prod`](packages/prod/README.md) | the middleware, plus `prod test` and `prod data` | this is the one that runs on your server |

`opengeo-prod` is the package that ends up in a production dependency, so it has **zero
dependencies** and its library, the part your server imports, has no jsdom and no AI provider code.
It reads files that `generate` already wrote, and does a map lookup per request.
`npm run check:bundles` asserts that on every build. The `opengeo prod test` command in the same
tarball carries the provider catalogue so its help can list it, and never calls a provider.

## How the three pillars fit together

```
generate  crawls your live site once and writes
          public/md/<route>.md, robots.txt, llms.txt, sitemap.xml, .opengeo/manifest.json
                     |
prod      reads the manifest at boot, then on each request decides human or agent
          and serves the twin at the same URL, rewritten not redirected
                     |
test      fetches the deployed result and scores what an agent would actually receive,
          including whether the twin still matches the live page
```

Because OpenGEO owns both halves, `test` can catch drift: check B14 re-extracts the live page and
compares it against the markdown you are serving. That is the check nobody who only does one half of
the job can run.

## Docs

- [docs/checks.md](docs/checks.md) - all 22 checks, what each verifies, what it is worth, and why.
- [docs/spec.md](docs/spec.md) - the `opengeo/1.0` wire format: twin URLs, negotiation, headers,
  406 behaviour, frontmatter. Written so you could implement it without OpenGEO.
- [docs/providers.md](docs/providers.md) - every AI provider OpenGEO ships with, the environment
  variables it already understands, and how to add your own AI tool.
- [docs/config.md](docs/config.md) - every field of `opengeo.config.json`, with its default.
- [docs/prod-api.md](docs/prod-api.md) - every export of `opengeo-prod` and its five adapter entries:
  `/next`, `/node`, `/fetch`, `/vite` and `/edge`.
- [docs/troubleshooting.md](docs/troubleshooting.md) - the problems people hit first, and the fix for
  each.
- [docs/versioning.md](docs/versioning.md) - how the `opengeo/1.0` spec version relates to the
  package version.
- [docs/architecture.md](docs/architecture.md) - for contributors: where the code lives, how it
  reaches the five packages, and what the build enforces.
- [CONTRIBUTING.md](CONTRIBUTING.md) - the dev loop, the test layout, and how to add a bot.
- [SECURITY.md](SECURITY.md) - the dashboard's threat model, where the API key goes, and how to
  report a vulnerability privately.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) - the Contributor Covenant 2.1.

## Repo layout

```
packages/core        @opengeo/core, private and never published. Every pillar is implemented here
                     once and bundled into each published package at build time.
packages/testing     opengeo-testing
packages/generate    opengeo-generate
packages/prod        opengeo-prod
packages/cli         opengeo-cli
packages/opengeo     opengeo, including web/ (the dashboard: plain HTML, CSS and JS, no build)
examples/nextjs-demo the Next.js app the whole pipeline is exercised against
docs/                the user and contributor docs listed above
scripts/             check-bundles.mjs and check-packages.mjs, which check what the build produced
```

## Working on it

The source is plain JavaScript with JSDoc types, so there is no compile step: after `npm install`,
`npm run opengeo -- --help` runs the CLI straight from the source tree.

```bash
npm install
npm run typecheck
npm test
npm run build            # packaging only; nothing needs it to run or test the code
npm run check:bundles
npm run check:packages
```

To drive the CLI against the bundled example, install it globally from its own tarball and use it
the way a user would:

```bash
npm run install:global    # then: opengeo --help
npm run example:dev       # serves the demo on localhost:3000
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the rest, including the one place Changesets cannot
follow a change and what to do about it.

## Known limitations

- **Client-rendered pages.** HTML is parsed with jsdom and page scripts are never executed, so a page
  that is empty until JavaScript runs extracts as empty. Generate still writes its twin, and warns
  with the word count so a near-empty one is never mistaken for the page; on a dev server that renders
  in the browser it says to generate from the production build instead. See
  [`TODO-csr-jsdom.md`](packages/core/src/generate/TODO-csr-jsdom.md).
- **SSR output without semantic landmarks.** Frameworks that ship no `<main>` or `<article>` fall back
  to the whole body. See [`TODO-ssr-extraction.md`](packages/core/src/generate/TODO-ssr-extraction.md).
- **`Vary: Accept` on Next.js App Router.** Next does not let middleware add `Vary` to a response it
  did not create, so an HTML response from an App Router page can lack it. Check B7 scores this as
  a partial, 2 of 4, rather than papering over it.
- **CDN behaviour is documented, not claimed.** `Vary: Accept` is set on every response; how a given
  CDN honours it across hosts has not been tested.

## License

Licensed under the [Apache License 2.0](LICENSE).
