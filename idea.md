# OpenGEO — Product & Technical Specification
 
**One line:** An open-source, framework-agnostic npm toolkit that tests, generates, and serves AI-readable versions of any website — so AI agents (ChatGPT, Claude, Gemini, Perplexity) get clean markdown instead of bloated HTML/CSS/JS, correctly, on every JS framework, not just Next.js.
 
**GitHub repo:** `sherwinvishesh/OpenGEO`
 
---
 
## Table of Contents
 
1. [The Problem](#1-the-problem)
2. [Core Concept](#2-core-concept)
3. [Repo & Package Architecture](#3-repo--package-architecture)
4. [CI/CD Pipeline](#4-cicd-pipeline)
5. [Feature: Test](#5-feature-test)
6. [Feature: Generate](#6-feature-generate)
7. [Feature: Prod](#7-feature-prod)
8. [Product Website](#8-product-website-packagesopengeo)
9. [Showcase Website](#9-showcase-website-website)
10. [CLI Reference](#10-cli-reference)
11. [Security & API Key Handling](#11-security--api-key-handling)
12. [Naming & Branding](#12-naming--branding)
13. [Error Handling Convention](#13-error-handling-convention)
14. [Competitor Landscape](#14-competitor-landscape)
15. [Why OpenGEO](#15-why-opengeo)
16. [Non-Goals (v1)](#16-non-goals-v1)
17. [Open Questions & Known Risks](#17-open-questions--known-risks)
18. [Build Sequence](#18-build-sequence)
19. [Tech Stack](#19-tech-stack)
---
 
## 1. The Problem
 
AI agents and LLM browsing tools strongly prefer clean markdown over full HTML/CSS/JS. It's cheaper to read (fewer tokens), and many agents don't execute JavaScript at all — so client-rendered content is often functionally invisible to them.
 
This discipline has a name: **GEO (Generative Engine Optimization)** / **AEO (Answer Engine Optimization)** — the AI-era counterpart to SEO. Instead of optimizing to rank on a search results page, the goal is to be read, cited, and recommended inside an AI-generated answer.
 
Existing tools solve *pieces* of this — testing-only, generating-only, or serving-only — and are almost always locked to one framework (usually Next.js) or one CMS (WordPress, Magento). **No open-source tool combines testing, generating, and serving in one toolchain that works across every JS framework** (React, Vue, Svelte, Remix, plain Vite, vanilla JS).
 
Target audience for v1: **blog writers, portfolios, and marketing sites** — public, content-first sites, not auth-gated apps.
 
---
 
## 2. Core Concept
 
Three pillars, one shared engine:
 
| Pillar | Command | What it does |
|---|---|---|
| **Test** | `opengeo test` | Scores a live site's AI-readiness, 0–100, and can generate a ready-to-paste fix prompt for coding agents |
| **Generate** | `opengeo generate` | Produces a clean `.md` twin of every page, plus `robots.txt`, `llms.txt`, `sitemap.xml` |
| **Prod** | `opengeo-prod` (runtime) | Detects the visitor (human / allowed AI / unknown) and serves the right format — no live computation |
 
Two separate websites exist in this project — this is a deliberate structural decision, not two versions of the same thing:
- The **product website** — the local dashboard a real user opens after installing the package.
- The **showcase website** — a public marketing site proving the tool works, hosted separately, not shipped in any npm package.
---
 
## 3. Repo & Package Architecture
 
### Naming
- GitHub repo: `sherwinvishesh/OpenGEO` (capitalization is fine — GitHub doesn't care).
- npm packages: always lowercase — **this isn't a style choice, npm rejects publishes with capital letters.** Every published package name starts with `opengeo`.
### Folder structure
 
```
sherwinvishesh/OpenGEO/
├── packages/
│   ├── core/          (all shared logic — never published, marked private)
│   ├── testing/        → published as opengeo-testing
│   ├── generate/        → published as opengeo-generate
│   ├── prod/             → published as opengeo-prod
│   ├── cli/               → published as opengeo-cli
│   └── opengeo/         → published as opengeo (includes the product website)
├── website/              (the showcase site — plain HTML/CSS/JS, never published)
└── .github/workflows/  (test → build → publish pipeline)
```
 
`packages/` is the correct top-level folder name (not `src/` or `library/`) — it's what npm workspaces and build tooling expect by default, so any tool (including a coding agent) recognizes the structure immediately without extra configuration.
 
### Published packages — exactly 5
 
| Package | Includes | Website | CLI |
|---|---|---|---|
| `opengeo` | Test + Generate + Prod + Website | ✅ | ✅ everything |
| `opengeo-cli` | Test + Generate + Prod | ❌ | ✅ everything |
| `opengeo-testing` | Test only | ❌ | ✅ `opengeo test` |
| `opengeo-generate` | Generate only | ❌ | ✅ `opengeo generate` |
| `opengeo-prod` | Prod middleware only | ❌ | runtime lib + `opengeo prod test` |
 
`opengeo` and `opengeo-cli` deliberately overlap with the three solo packages — some users want one install, some want just the piece they need. Docs promote `opengeo` and `opengeo-cli` as the main entry points; the three solo packages are mentioned as "install just what you need," further down, so a first-time visitor isn't asked to choose between five options before trying anything.
 
### How the 5 packages stay independent with zero duplicated code
 
`packages/core` holds every piece of shared logic (bot list, extraction logic, shared error text, checklist definitions). It is **never published** and marked `"private": true`. Instead:
 
- Each of the 5 packages **bundles core directly into itself** at build time, using **tsup**. After building, every package is fully self-contained — nobody who installs `opengeo-testing` needs to separately install anything else.
- This is a deliberate choice to keep the count at exactly 5 published packages. The alternative (publishing `core` as its own real 6th package) is technically simpler, but was rejected specifically to keep the package count at 5.
**Why this doesn't cause overwriting or drift:**
- Every package builds into its **own** `dist` folder — never a shared one. Two separate output folders can't collide.
- `core` is never hand-copied by a person. Only the build tool touches it, fresh, every time, from the one real copy in `packages/core`.
- `core` only contains static data and pure functions (bot lists, parsing logic, error strings) — nothing that changes while a program is running. Two bundled copies of the same static list are always identical; there's no state to drift apart.
**Known, accepted tradeoff:** if a user installs two of the five packages side by side (uncommon — most people install one), they'll have two small bundled copies of `core`'s code on disk. This costs kilobytes, not megabytes, and isn't worth engineering around.
 
**Naming convention:** the internal folder is referred to as `@opengeo/core` in code (scoped-package style) even though it's never published — a standard signal to anyone reading the repo that it belongs to the OpenGEO family and isn't meant to be installed on its own.
 
---
 
## 4. CI/CD Pipeline
 
Three gated stages, every time, on every push to `main`. Nothing gets published by hand.
 
1. **Test** — the full test suite runs against source code first. Detailed, thorough coverage, especially for `packages/core`, since a bug there silently affects every published package at once. Nothing proceeds if tests fail.
2. **Build** — only if tests passed. Each of the 5 packages compiles/bundles itself (pulling in whatever it needs from `core`) into its own self-contained output, via tsup.
3. **Publish** — via **Changesets**. A contributor writes a short change-note describing what changed; Changesets automatically figures out which published packages actually depend on the changed code (e.g., a change to testing logic in `core` correctly bumps `opengeo-testing`, `opengeo-cli`, and `opengeo` — but not `opengeo-generate` or `opengeo-prod`, since those don't include testing at all). It opens a "Version Packages" pull request with version bumps and changelogs; merging that PR triggers the actual `npm publish` for whichever packages changed. No manual version bumping, no manual publish command.
### Release workflow (`.github/workflows/release.yml`)
 
```yaml
name: Release
 
on:
  push:
    branches:
      - main
 
concurrency: ${{ github.workflow }}-${{ github.ref }}
 
jobs:
  release:
    name: Release
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v4
 
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
 
      - name: Install Dependencies
        run: npm install
 
      - name: Run tests
        run: npm test
 
      - name: Build packages
        run: npm run build
 
      - name: Create Release PR or Publish to npm
        uses: changesets/action@v1
        with:
          publish: npm run release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```
 
### PR-check workflow (`.github/workflows/checks.yml`)
 
Runs on every pull request, before merge — catches problems before they reach `main`, not just after:
 
```yaml
name: Checks
 
on:
  pull_request:
 
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm test
      - run: npm run build
```
 
**Publishing auth:** start with an `NPM_TOKEN` saved as a GitHub secret (simplest to set up). A more secure option to move to later is **npm trusted publishing** (OIDC) — GitHub proves its identity to npm fresh on every run, so no long-lived token sits in secrets at all. Not required for v1, worth adopting once the pipeline is trusted and stable.
 
---
 
## 5. Feature: Test
 
**Command:** `opengeo test <url>`
 
### Input
Always a **URL** — `localhost:3000` during development, or the live deployed URL after launch. Never a source-code path. Testing needs to see what's actually served over HTTP — headers, real response, real rendering result — there's nothing meaningful to test by reading source files directly.
 
### Two check categories
 
**A. General AI-discoverability** — is the site set up to be found and understood by AI at all:
- `robots.txt` — are known AI bots (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, etc.) allowed
- `llms.txt` — present and valid
- `sitemap.xml` — present and valid
- Schema.org / JSON-LD coverage (Organization, Article, FAQ, LocalBusiness, etc.)
- SSR vs. CSR extractability — is real content present in the raw HTML response, or only after JS executes
- TTFB (time to first byte)
- `noai` / `noimageai` meta tag detection (silent AI blockers site owners forget they set)
- HTTPS / HSTS
**B. Implementation correctness** — for a site that already has a markdown twin (via `opengeo-prod` or otherwise), is the serving mechanism actually working correctly. This category is modeled on the header-level rigor of Dualmark's own AEO spec, adapted for OpenGEO:
- Markdown twin URL is reachable and returns 2xx
- `Content-Type` on the markdown response is exactly `text/markdown; charset=utf-8`
- Response body is non-empty markdown
- `X-Markdown-Tokens` header present, positive integer (lets an agent gauge size before fetching)
- `X-Content-Type-Options: nosniff` present
- `X-Robots-Tag` on the markdown twin includes `noindex` (so search engines don't index it as duplicate content)
- `Vary` header includes `Accept` (critical for CDN correctness — see §7)
- HTML response advertises the markdown twin via a `Link rel="alternate"` header
- A request with `Accept: text/markdown` actually receives a markdown response, not HTML
- A known AI bot User-Agent (e.g. GPTBot) receives the markdown response, even without an explicit `Accept` header
- An `Accept` header that excludes both HTML and markdown correctly returns `406 Not Acceptable`
- `X-AEO-Version` header advertises the spec version being followed
- The original HTML URL remains reachable and unaffected
This checklist doubles as the response-header spec that `opengeo-prod` itself must implement — see §7.
 
### Scoring
Single score, **0–100, no letter grade and no tier label** — this stays consistent with the project's scoring decision even though the checks above are organized in two categories internally. Required checks (category A + the core mechanics of category B) weigh more heavily than recommended/nice-to-have checks; exact per-check weighting is an implementation detail, not fixed here.
 
Test also detects the underlying framework where possible (e.g. "Detected: Next.js") to make its output — and the generated fix prompt below — more specific.
 
### The differentiator nobody else can build
Because OpenGEO owns both `generate` and `test`, test can check whether the currently-served `.md` file **actually matches** the live page content right now — i.e., detect drift or staleness between what's live and what AI agents are being served. No standalone competitor can build this check, since none of them own both halves of the pipeline.
 
### Claude Code fix-prompt generation
`opengeo test <url> --prompt` outputs a ready-to-paste prompt for coding agents with real file access to the repo (Claude Code, Cursor, and similar — not a plain web chat with no file access, since the ask requires editing real files). The prompt includes:
- Current score, site URL, expected markdown-twin URL, detected framework
- Every failed check: check ID, points lost, human-readable description, actual failure reason
- Explicit numbered asks: (1) walk through the exact code changes needed, (2) show a diff against the current setup, (3) explain how each change maps back to a specific failed check ID, (4) verify the suggestions against OpenGEO's own published spec/docs
All references inside this generated prompt point to **`opengeo-prod`** and **OpenGEO's own documentation** — not any third-party package or third-party docs.
 
### AI-powered markdown-quality check (optional layer)
`opengeo test <url> --quality` — a separate, optional pass judging keyword coverage/relevance, whether length is appropriate (too long/short), and specific improvement suggestions.
 
- **Kept as its own separate output, never blended into the 0–100 structural score.** The structural checks above are deterministic — pass or fail, no ambiguity. AI-judged quality is inherently a softer, fuzzier signal, and mixing a hard score with a soft one would make the number harder to interpret.
- **Requires an API key** — the one exception to "test never needs a key." Core structural checks (category A and B above) never need a key, ever. This optional quality layer does, the same as generate's AI tier.
- **Local-machine-only, no CI** — same restriction as generate, and for the same underlying reason: keep a human in the loop around anything AI-touched, even though this feature only scores and suggests rather than shipping anything automatically. Chosen for consistency across every AI-touching feature in the project, so there's one rule to remember, not several.
---
 
## 6. Feature: Generate
 
**Commands:** `opengeo generate <url>` (whole site) or `opengeo generate <url>/<page>` (single page)
 
### Input
Same rule as `test` — always a URL, local or live. For CSR/SPA pages, content doesn't exist until JavaScript actually runs, so hitting the real URL is the only framework-agnostic way to get real content, without writing a separate adapter for every framework's build-output format.
 
### Two conversion tiers
 
**1. Free / algorithmic (no key)** — extracts structure directly from the rendered page (headings, tables, lists, etc.). For client-rendered pages, uses **jsdom** (a lightweight, pure-JS DOM implementation that can execute a page's JS inside Node) rather than a full headless browser like Playwright — keeps the tool light, avoids bundling a Chromium binary.
> Known limitation, stated honestly: jsdom has no real layout engine and can be flaky on complex async data-fetching or React Suspense. Needs real-world validation, not assumed to fully solve every CSR page.
 
**2. AI-enhanced (BYOK)** — user supplies their own Gemini/Claude/OpenAI key. The prompt is engineered for **fidelity, not rewriting**: reproduce the page's actual structure and text faithfully in markdown; never summarize, paraphrase, or alter facts (names, dates, prices, numbers). A subtly reworded fact is worse than a rough-but-correct algorithmic extraction — this matters most on pages like resumes and pricing pages.
 
### Also generates
- `robots.txt`
- `llms.txt`
- `sitemap.xml`
`generate` is the **sole owner** of writing all three files — `prod` never writes them, only reads and reports on them (see §7). The same route-discovery crawl already needed for the `.md` files supplies the page list for `llms.txt` and `sitemap.xml` — one crawl, three outputs.
 
### Timing — local machine only, never CI, never per-request
`generate` runs **only when a human explicitly runs the command on their own machine.** Two separate rules stack here, both deliberate:
- **Build-time only, never per visitor request** — output is saved to disk as static files; a real visitor (human or AI) only ever receives a file that already exists. No AI call, no parsing, no computation happens while anyone is waiting.
- **No CI, no automatic regeneration on deploy** — specifically to keep a human reviewing anything AI-touched before it ships, rather than letting it silently regenerate unattended. This means the `last_updated` staleness check in `test` (below) is the real safety net if someone edits a page and forgets to rerun `generate` — worth keeping that warning prominent in the product UI, not a quiet footnote, since more now rides on it.
### Caching & freshness
- Each page's source content is hashed; unchanged pages are skipped on rerun — keeps the AI tier affordable and repeat runs fast.
- Every generated `.md` file's frontmatter is stamped with `last_updated`, so staleness is visible to `test`, to the user, and optionally to the AI agent reading it.
### Route discovery
Crawl starting from `/`, following real `<a href>` links — works out of the box for Next.js `Link`, React Router `Link`, and most standard nav patterns, since they render real anchor tags by default.
- Auth-gated or unlinked pages are **intentionally out of scope** (see §16).
- An optional config file lets a user manually declare extra routes the crawler can't discover.
- **Explicitly not building:** per-router-library adapters (React Router / Vue Router / TanStack Router config parsers). Deliberate — this would turn "framework-agnostic" into "we maintain a parser per router library forever."
### Manual editing
Users can hand-edit any generated `.md` file afterward. `opengeo-prod` doesn't know or care whether a file was AI-generated, algorithmically generated, or hand-edited — it just serves whatever file is on disk. This preserves a "human can improve the output" workflow without needing generate logic present at runtime.
 
### CLI convention
Fixed binary command (`opengeo generate ...`) — never tied to the user's own project name, so docs and muscle memory stay consistent across every project that installs it.
 
---
 
## 7. Feature: Prod
 
**Package:** `opengeo-prod` — a runtime middleware installed into the user's own deployed app.
 
### Requirements
Needs a host with a server/edge compute layer (Vercel, Netlify, Cloudflare Workers, or similar). **Will not work on a purely static host with zero server component** (e.g. plain GitHub Pages with no functions).
 
### Visitor classification (on every request)
 
| Visitor type | Behavior |
|---|---|
| Human | Serve the real site, unchanged |
| Selected/allowed AI (from user's configured list) | Serve the matching pre-generated `.md` file |
| Unknown / unrecognized bot | **Default: treat as a normal visitor.** Never blocked by default. |
 
New AI products launch constantly and won't be on any maintained list immediately. Blocking unknowns by default would silently wall a site off from every future AI product until the list catches up. Blocking is opt-in, per bot, never the default.
 
### Detection signal
Primarily **User-Agent matching** against a maintained, community-updated AI-bot list (open source — the list improves via contributions over time). `Accept: text/markdown` header negotiation is a secondary signal for bots sophisticated enough to send it.
 
### Serving mechanism — rewrite, not redirect
The URL stays the same (e.g. `/resume`); the middleware swaps in the markdown body instead of the HTML body. Same URL, same substantive content, only the format differs. This distinction matters: serving genuinely *different content* to bots vs. humans to manipulate rankings is cloaking, and is penalized by search engines. Serving the *same* content in a different format, at the same URL, is the accepted, established pattern.
 
### Required response behavior (implements the checklist from §5B)
- `Content-Type: text/markdown; charset=utf-8` on markdown responses
- `X-Markdown-Tokens` — positive integer token count
- `X-Content-Type-Options: nosniff`
- `X-Robots-Tag: noindex` on markdown responses
- `Vary: Accept` on every response, so CDNs cache the HTML and markdown variants separately and never serve the wrong one to the wrong visitor
- `Link: rel="alternate"` on HTML responses, pointing to the markdown twin
- `406 Not Acceptable` when a request's `Accept` header excludes both HTML and markdown
- `X-AEO-Version` advertising the spec version implemented
### No live computation, no API key, ever
Pure lookup against the static files `generate` already produced — no AI calls, no parsing, at request time, full stop. By the time `opengeo-prod` is running in production, every `.md` file already exists as a static file, so it never needs an API key. This is also why `opengeo-prod` is the one package safe to actually push to a live repo or hosting platform — see §11.
 
### Bot settings — two separate levers
1. **Markdown routing list** — which AI agents get the `.md` version. Never blocks anyone; worst case, an unlisted bot just sees the normal site.
2. **Access blocking list** — a fully separate, opt-in list for owners who want to block specific bots entirely (e.g. bulk training crawlers), implemented via the `robots.txt` rules `generate` wrote.
> `robots.txt` is a voluntary convention respected by well-behaved bulk crawlers (like GPTBot doing a training scrape). It does **not** govern a live agent fetching a single page mid-conversation on a human's behalf — that's a normal one-off HTTP request, not a crawl, and typically isn't checked against `robots.txt` at all. These are two different problems needing two different controls.
 
### robots.txt / llms.txt / sitemap.xml — read-only in prod
`prod` never writes these files — `generate` owns them exclusively. What `prod` does:
- On **startup/deploy only** (never per-request, to avoid log spam), checks whether each file exists and logs its status — found or not found, and for `robots.txt`, what it's currently allowing or blocking.
- If a file isn't found, the log message tells the user to either hand-write one or install `opengeo-generate`.
- This status is visible in the platform's own deploy logs (Vercel, Netlify, etc.), so a user can confirm the setup without extra tooling.
### Verification command
`opengeo prod test <url>` — confirms the live middleware is actually working: does a request flagged as an allowed AI actually receive markdown, does a normal request get the real site.
 
---
 
## 8. Product Website (`packages/opengeo`)
 
Launched via `opengeo start -p <port>` — a **local-only** web server and UI on the user's own machine. Never hosted by OpenGEO; nothing leaves localhost.
 
### Design direction
Modern SaaS-style. Both **dark mode and light mode**. Visually distinctive and polished, but restrained — professional rather than flashy, no heavy animation, lightweight and fast. The bar to match: the level of detail and clarity shown in a working AEO test report — a clear score visualization, organized failure categories, per-check detail with plain-language reasons.
 
### Layout
- **Left side:** navigation — Test, Generate, Prod, Bot Settings, general Settings.
- **Right side:** detailed view for whatever's selected — for Test, this means a full results view: a score indicator (0–100, no label), grouped sections (Failed – Required, Failed – Recommended, Passed), and per-check rows showing the check ID, what it verifies, and the specific reason it failed or passed.
### Onboarding
First-run flow: select/confirm project → enter AI provider + API key → configure initial bot allow-list. Should be quick enough that a new user reaches a first real test result within a minute or two of installing.
 
### Hard requirement
No telemetry, analytics call, or "sync to cloud" feature may ever transmit the stored API key anywhere. The only network call involving the key is the direct call to the user's chosen AI provider. The README documents exactly where the key is stored on disk, so this is auditable by anyone reading the code.
 
This UI is a wrapper over the same shared core the CLI commands call — not a separate implementation.
 
---
 
## 9. Showcase Website (`website/`)
 
A separate, top-level folder — plain HTML/CSS/JS, **never published to any npm package**, deployed on its own as a public marketing/demo site.
 
Should eat its own dog food: run `opengeo test` on itself and display the real score, and/or ship its own `/llms.txt` — turning the marketing site into live proof the tool works, not just a description of it.
 
---
 
## 10. CLI Reference
 
| Command | Package(s) | What it does |
|---|---|---|
| `opengeo setup` | `opengeo`, `opengeo-cli` | Terminal-based onboarding: pick project, enter key, configure bots |
| `opengeo start -p <port>` | `opengeo` only | Launches the local product website |
| `opengeo test <url>` | `opengeo`, `opengeo-cli`, `opengeo-testing` | Runs the 0–100 AI-readiness audit |
| `opengeo test <url> --prompt` | same | Outputs a ready-to-paste fix prompt for coding agents |
| `opengeo test <url> --quality` | same | Runs the optional AI markdown-quality pass (needs a key, local-only) |
| `opengeo generate <url>` | `opengeo`, `opengeo-cli`, `opengeo-generate` | Generates `.md` files, `robots.txt`, `llms.txt`, `sitemap.xml` for all discovered routes |
| `opengeo generate <url>/<page>` | same | Regenerates a single page |
| *(import in code)* | `opengeo`, `opengeo-cli`, `opengeo-prod` | The middleware itself, used directly in the user's app code |
| `opengeo prod test <url>` | `opengeo`, `opengeo-cli`, `opengeo-prod` | Verifies the live prod middleware is serving correctly |
 
---
 
## 11. Security & API Key Handling
 
- The key is read from a local `.env` file (or local config, for the website flow) — never hardcoded, never committed.
- On `opengeo setup` (or first install), `.env` is automatically added to `.gitignore` if not already present — this is the actual mechanism that prevents an accidental key leak.
- **Which features need a key:**
| Feature | Needs a key? |
|---|---|
| `test` (structural checks) | Never |
| `test --quality` | Yes — local-only |
| `generate` (free tier) | Never |
| `generate` (AI-enhanced tier) | Yes — local-only |
| `prod` | Never, by construction |
 
- **Recommended deploy pattern:** push only `opengeo-prod` to the live production repo / hosting target — it has zero key dependency, so there's nothing to leak.
- Since `generate` is local-machine-only by design (§6), there's no CI secret-based flow to document for it — that path was deliberately not built.
---
 
## 12. Naming & Branding
 
- Project name: **OpenGEO**. GitHub repo capitalized (`OpenGEO`); all npm packages lowercase (npm requirement).
- Category: **GEO (Generative Engine Optimization)** / **AEO (Answer Engine Optimization)** — the AI-era counterpart to SEO. External-facing language uses this term, not classic "SEO" — Google's own crawler already executes JS fine; the audience here is specifically LLM agents that often don't.
- Locked package names: `opengeo`, `opengeo-cli`, `opengeo-testing`, `opengeo-generate`, `opengeo-prod`.
- Intentional naming mismatch: the CLI command for the testing package is `opengeo test` (no "-ing"), even though the package itself is `opengeo-testing`. Deliberate, not an inconsistency to fix.
---
 
## 13. Error Handling Convention
 
When a limited package's CLI is asked to run a command it doesn't include (e.g. someone installs only `opengeo-testing` and runs `opengeo generate`), it fails with a clear, friendly, **personalized** message naming exactly which package to install instead.
 
All such error copy lives in **one shared internal module**, imported by every package — never duplicated per package, so wording only ever needs to change in one place.
 
---
 
## 14. Competitor Landscape
 
**Testing tools** — most check the same baseline (robots.txt, llms.txt, sitemap, schema.org, SSR/CSR extractability, TTFB, noai tags, HTTPS), usually as a 0–100 score with a letter grade. `aeo-scan` (npm, iSimplifyMe) uses a small dependency-free core with config-file-based custom checks — a good pattern, reflected in OpenGEO's own core/package split.
 
**Generate tools** — `md4AI` (WordPress plugin) auto-generates markdown, allows manual editing, and offers optional AI enhancement — architecturally the closest match to OpenGEO's two-tier generate design, just built for WordPress instead of general JS. `E-GEO` (Python) runs an analyze → rewrite → schema pipeline. `llmstxt` / `llm-docs-builder` (npm) are narrower — they only convert existing docs/sitemaps into `llms.txt`, not full page-by-page converters.
 
**Prod/serving tools — closest direct competitor:** **Dualmark** (`github.com/dodopayments/dualmark`) does the same core thing as `opengeo-prod` — one URL, two formats, chosen via HTTP content negotiation. Open source, Apache 2.0, TypeScript, real traction (88 stars, 27 forks). Supports Next.js, Astro, and Cloudflare Workers, and publishes its own formal AEO spec with header-level conformance checks — the direct inspiration for OpenGEO's category-B test checklist (§5). **Gap it leaves open:** no coverage found for Vite / plain vanilla-JS SPAs — this remains genuinely unsolved, even by the closest competitor.
 
**Broader landscape (adjacent, not direct competition):** GetCito, `ai-visibility` (Python/PyPI), canonry, and various CMS plugins mostly solve a different problem — tracking whether AI answer engines already cite a brand, rather than technically generating and serving AI-readable content.
 
**Market signal:** nearly every serious competitor describes itself as "open source," "self-hostable," "MIT/Apache-licensed," or "every metric auditable in code." In this category, open source functions as close to a trust requirement before someone will hand a tool their API key and let it touch production — OpenGEO's open-source choice matches what this market already expects.
 
---
 
## 15. Why OpenGEO
 
1. **Genuinely framework-agnostic** across the full JS ecosystem (React, Vue, Svelte, Remix, Vite, vanilla JS) — not just Next.js/Astro like the closest existing competitor.
2. **All three pillars in one toolchain** — test, generate, and prod — instead of one narrow tool per pillar, which is what the rest of the market offers today.
3. **The staleness/drift check** (§5) — structurally impossible for a standalone competitor to build, since it requires owning both `generate` and `test`.
4. **Two-tier generate, generalized beyond WordPress** — takes the best existing pattern (`md4AI`'s auto + manual-edit + AI-enhance flow) and makes it available to any JS framework.
5. **Test checks modeled on a real, rigorous spec** — header-level conformance checking, not just a generic checklist, adapted from studying Dualmark's own approach.
6. **Closes the loop from diagnosis to fix** — the Claude Code fix-prompt feature (§5) turns "here's what's wrong" directly into "here's a ready-to-use fix request," which no competitor studied offers.
7. **Modular, shared-core publishing** — five packages, one codebase, so users install only what they need without the project maintaining five separate implementations.
---
 
## 16. Non-Goals (v1)
 
Explicitly out of scope, to avoid scope creep during the build:
 
- Auth-gated / login-walled pages (target audience is public content: blogs, portfolios, marketing sites)
- Full headless-browser rendering (Playwright/Puppeteer) as a default path — jsdom only, for v1
- Per-JS-framework router config parsers (React Router / Vue Router / etc. adapters)
- Blocking unknown/unrecognized bots by default — always opt-in
- Serving *substantively different* content to bots vs. humans — markdown and HTML must always represent the same underlying content, only the format differs
- Running `generate` or the AI-quality check from CI/CD — both are restricted to the user's local machine by design, so nothing AI-touched ships without a human reviewing it first
- A combined/blended score mixing deterministic structural checks with AI-judged quality — these stay as two separate outputs
---
 
## 17. Open Questions & Known Risks
 
Honest, not yet fully resolved — worth deciding before or during the build, not silently assumed:
 
- **Existing robots.txt / llms.txt / sitemap.xml conflict:** if a site already has a hand-written version of one of these files before `generate` runs for the first time, should it be overwritten or should the user be warned first? Not yet decided — a hand-written `robots.txt` in particular may carry intentional rules a blind overwrite would erase.
- **CSR/SPA extraction ceiling:** jsdom can fail or behave inconsistently on complex async-data or Suspense-heavy client-rendered pages. Needs real-world validation before claiming full SPA support.
- **No headless-render fallback in v1:** a real, industry-wide limitation — even Dualmark, the closest competitor, doesn't appear to solve pure client-side SPA support either.
- **Route discovery ceiling:** crawling from `/` via real `<a href>` links misses anything gated behind auth, unlinked, or navigated purely through JS with no real anchor tags. Accepted per §16, not silently assumed to be full coverage.
- **Bot list maintenance:** the AI-bot User-Agent list needs continuous upkeep as new AI products launch — open-source, community-updated, but an ongoing cost, not a one-time build.
- **CDN/caching correctness:** `Vary: Accept` needs real end-to-end testing across hosting targets (Vercel, Netlify, Cloudflare) to confirm markdown and HTML variants never leak into each other's cache.
---
 
## 18. Build Sequence
 
1. **Generate, MDX/file-based-routing frameworks first** (Next.js, Astro) — content is already markdown-sourced or present in server-rendered HTML, so the free tier can be near-perfect here at zero cost. Validates the core pipeline fastest.
2. **Add the BYOK AI-enhanced tier**, with the fidelity-locked prompt (§6).
3. **Test feature** — largely parallel to the above, except the staleness-check differentiator, which needs `generate` to exist first.
4. **robots.txt / llms.txt / sitemap.xml generation** — cheap to add once route discovery already works for the `.md` pipeline.
5. **SSR HTML extraction** for non-MDX SSR frameworks (Nuxt, plain SSR setups).
6. **Prod middleware** — once `generate` reliably produces trustworthy `.md` output to serve, including the full required-header set from §7.
7. **Claude Code fix-prompt + AI quality check** — layer on top of a working `test`.
8. **CSR/SPA support via jsdom** — last, and only once there's real signal people want the tool at all. This is the hardest, least-differentiated case (even the closest competitor hasn't solved it), so it shouldn't gate the rest of the launch.
---
 
## 19. Tech Stack
 
- **Monorepo:** npm workspaces, with `packages/*` as the workspace root.
- **Bundling:** tsup — bundles each of the 5 packages, pulling in `packages/core`, into a self-contained output.
- **Release automation:** Changesets, wired into GitHub Actions (`changesets/action`), gated behind passing tests and a successful build.
- **Publish auth:** `NPM_TOKEN` secret for v1; npm trusted publishing (OIDC) as a later, more secure upgrade.
- **CSR extraction (v1):** jsdom. Full headless-browser rendering (Playwright) explicitly deferred — worth revisiting later as an optional, heavier opt-in mode, not the default.
- **Prod middleware targets:** Vercel / Netlify / Cloudflare Workers-style edge functions — will likely need one thin adapter per hosting target, similar in spirit to how Dualmark structures its own adapters.
- **License:** open source (MIT or Apache 2.0) — matches the near-universal norm in this competitive category, and functions as a real trust requirement for a tool that touches a user's API key and production site.
---
 
*This document reflects final decisions only. Treat §17 as a living section — resolve and update it as real build constraints are discovered.*
 