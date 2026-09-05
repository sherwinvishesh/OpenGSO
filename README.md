# Open Generative Engine Optimization (OpenGEO)

An open-source, framework-agnostic npm toolkit that makes any website readable by AI agents.

AI agents like ChatGPT, Claude, Gemini, and Perplexity strongly prefer clean markdown over full HTML/CSS/JS. It's cheaper to read, and many agents don't execute JavaScript at all, so client-rendered content is often invisible to them. OpenGEO fixes that across three pillars in one toolchain:

- **Test**: score a live site's AI-readiness from 0 to 100, and generate a ready-to-paste fix prompt for coding agents.
- **Generate**: produce a clean `.md` twin of every page, plus `robots.txt`, `llms.txt`, and `sitemap.xml`.
- **Prod**: serve the right format at runtime by detecting whether the visitor is a human or an AI agent.

Unlike existing tools, which each solve one piece and are usually locked to a single framework or CMS, OpenGEO works across the whole JS ecosystem, including React, Vue, Svelte, Remix, Vite, and vanilla JS.

## Quickstart

```bash
npm install --save-dev opengeo

npx opengeo setup                                   # site, bot routing, optional API key
npx opengeo test https://your-site.com              # score it as it is today
npx opengeo generate https://your-site.com          # write the twins and the three root files
# wire opengeo-prod into your middleware, deploy
npx opengeo prod test https://your-site.com         # prove the deployment serves them correctly
npx opengeo test https://your-site.com              # score it again
```

Or drive the whole thing from the local dashboard:

```bash
npx opengeo start
```

Nothing here needs an API key. Generate's free tier, every structural test, and all of
`opengeo-prod` run offline. A key only buys generate's AI polish tier and `opengeo test --quality`,
and when you set one it lives in `.env`, on your machine, and is only ever sent to the AI provider
you picked. There is no telemetry and no cloud sync.

## Which package do I install

Install the narrowest one that does what you need. They all expose the same `opengeo` command, and
if you ask one for something it does not ship, it tells you which package to install instead.

| Package | Ships | Install it when |
| --- | --- | --- |
| [`opengeo`](packages/opengeo/README.md) | everything, plus the local dashboard | you want the whole thing, or you want a UI |
| [`opengeo-cli`](packages/cli/README.md) | `test`, `generate`, `prod test`, `setup` | you want the whole toolchain, terminal only |
| [`opengeo-testing`](packages/testing/README.md) | `test` | you only want to score a site |
| [`opengeo-generate`](packages/generate/README.md) | `generate` | you only want the markdown twins and root files |
| [`opengeo-prod`](packages/prod/README.md) | the middleware, plus `prod test` | this is the one that runs on your server |

`opengeo-prod` is the package that ends up in a production dependency, so it has **zero
dependencies**, no jsdom, and no AI provider code at all. It reads files that `generate` already
wrote, and does a map lookup per request. `npm run check:bundles` asserts that on every build.

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
- [CONTRIBUTING.md](CONTRIBUTING.md) - the dev loop, the test layout, and how to add a bot.
- [idea.md](idea.md) - the original product spec. It outranks the code.

## Repo layout

```
packages/core        @opengeo/core, private and never published. Every pillar is implemented here
                     once and bundled into each published package at build time.
packages/testing     opengeo-testing
packages/generate    opengeo-generate
packages/prod        opengeo-prod
packages/cli         opengeo-cli
packages/opengeo     opengeo, including web/ (the React + Vite dashboard)
examples/nextjs-demo the Next.js app the whole pipeline is exercised against
docs/                checks.md and spec.md
scripts/             check-bundles.mjs, which asserts those structural guarantees on every build
```

## Working on it

```bash
npm install
npm run typecheck
npm test
npm run build
npm run check:bundles
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the rest, including the one place Changesets cannot
follow a change and what to do about it.

## Known limitations

- **Client-rendered pages.** HTML is parsed with jsdom and page scripts are never executed, so a page
  that is empty until JavaScript runs extracts as empty. Generate warns instead of writing a hollow
  twin. See [`TODO-csr-jsdom.md`](packages/core/src/generate/TODO-csr-jsdom.md).
- **SSR output without semantic landmarks.** Frameworks that ship no `<main>` or `<article>` fall back
  to the whole body. See [`TODO-ssr-extraction.md`](packages/core/src/generate/TODO-ssr-extraction.md).
- **`Vary: Accept` on Next.js App Router.** Next does not let middleware add `Vary` to a response it
  did not create, so an HTML response from an App Router page can lack it. Check B7 reports this
  honestly rather than papering over it.
- **CDN behaviour is documented, not claimed.** `Vary: Accept` is set on every response; how a given
  CDN honours it across hosts has not been tested.

## License

Licensed under the [Apache License 2.0](LICENSE).
