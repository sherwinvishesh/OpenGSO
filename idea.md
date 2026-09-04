# OpenGEO — Product & Technical Specification

**One line:** An open-source, framework-agnostic npm toolkit that tests, generates, and serves AI-readable versions of any website — so AI agents (ChatGPT, Claude, Gemini, Perplexity) get clean markdown instead of bloated HTML/CSS/JS, and get it correctly, for every JS framework, not just Next.js.

**Repo:** `sherwinvishesh/opengeo` (single monorepo, multiple published packages — see §4)

---

## Table of Contents

1. [The Problem](#1-the-problem)
2. [Core Concept — Three Pillars](#2-core-concept--three-pillars)
3. [Package Architecture](#3-package-architecture)
4. [Feature Spec: Test](#4-feature-spec-test)
5. [Feature Spec: Generate](#5-feature-spec-generate)
6. [Feature Spec: Prod](#6-feature-spec-prod)
7. [Website UI](#7-website-ui-opengeo-package-only)
8. [CLI Reference](#8-cli-reference)
9. [Security & API Key Handling](#9-security--api-key-handling)
10. [Naming & Branding](#10-naming--branding)
11. [Error Handling Convention](#11-error-handling-convention)
12. [Competitor Landscape](#12-competitor-landscape)
13. [Why OpenGEO / Differentiation](#13-why-opengeo--differentiation)
14. [Non-Goals (v1)](#14-non-goals-v1)
15. [Known Technical Risks / Open Questions](#15-known-technical-risks--open-questions)
16. [Suggested Build Sequence](#16-suggested-build-sequence)
17. [Suggested Tech Stack](#17-suggested-tech-stack)

---

## 1. The Problem

- AI agents and LLM browsing tools strongly prefer clean markdown over full HTML/CSS/JS. It's cheaper to read (fewer tokens) and many agents don't execute JavaScript at all — so client-rendered (CSR) content is often functionally invisible to them.
- This discipline now has a name: **GEO (Generative Engine Optimization)** / **AEO (Answer Engine Optimization)** — the AI-era equivalent of SEO. Instead of optimizing to rank on a search results page, you're optimizing to be read, cited, and recommended inside an AI-generated answer.
- Existing tools solve *pieces* of this problem, but each one is narrow: testing-only, generating-only, or serving-only — and most are locked to one framework (usually Next.js) or one CMS (WordPress, Magento).
- **Nobody ships all three pieces together — test, generate, and serve — as one open-source toolchain that works across every JS framework** (React, Vue, Svelte, Remix, plain Vite, vanilla JS).

---

## 2. Core Concept — Three Pillars

| Pillar | What it does |
|---|---|
| **Test** | Scores a live site's AI-readiness (robots.txt, llms.txt, schema, extractability, and more) |
| **Generate** | Produces a clean `.md` twin of every page — free algorithmic mode, or AI-enhanced mode using the user's own API key |
| **Prod** | Detects the visitor at request time (human vs. allowed AI vs. unknown) and serves the right format — without computing anything live |

Target audience for v1: **blog writers, portfolio sites, marketing sites** — content-first sites where pages are meant to be found and read, not auth-gated apps (see §14 Non-Goals).

---

## 3. Package Architecture

Single monorepo. All real logic lives in one shared internal core; every published package is a thin wrapper around that shared core. **No feature is ever implemented twice.** A bug fixed in the shared "testing" logic is fixed simultaneously in every package that includes testing.

Recommended tooling: **npm workspaces** for the monorepo structure, plus **Turborepo** or **Changesets** to keep versioning in sync and publish all packages together. Do not hand-roll this — it's a well-solved problem.

### Published packages (5 total)

| Package | Includes | Website UI | CLI |
|---|---|---|---|
| `opengeo` | Test + Generate + Prod + Website | ✅ | ✅ (everything) |
| `opengeo-cli` | Test + Generate + Prod | ❌ | ✅ (everything) |
| `opengeo-testing` | Test only | ❌ | ✅ `opengeo test` |
| `opengeo-generate` | Generate only | ❌ | ✅ `opengeo generate` |
| `opengeo-prod` | Prod middleware only | ❌ | ✅ `opengeo prod test` + runtime lib |

Notes:
- `opengeo` and `opengeo-cli` intentionally overlap with the three solo packages — this is deliberate, not a mistake. Some users want one install; some want only the piece they need.
- If a user installs a limited package (e.g. `opengeo-testing`) and runs a command it doesn't include (e.g. `opengeo generate`), fail with a clear, friendly, personalized error pointing them to the right package. See §11.
- **Launch docs strategy:** build and publish all 5 packages from day one (cheap, since they share code), but only prominently document/promote `opengeo` (website) and `opengeo-cli` (terminal-only) as the main entry points. Mention the 3 solo packages as "install just the piece you need" further down, so first-time visitors aren't asked to choose between 5 options before they've tried anything.

---

## 4. Feature Spec: Test

**Command:** `opengeo test <url>`

### Input
Always a **URL** — `localhost:3000` during development, or the live deployed URL after launch. Never a path to source code. Testing needs to see what's actually served over HTTP (headers, real response, real rendering result) — there's nothing meaningful to test by reading source files directly.

### Checklist (v1 baseline)
Matches or exceeds the standard checklist used across existing GEO/AEO audit tools:

- `robots.txt` — are known AI bots (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, etc.) allowed
- `llms.txt` — does it exist, is it valid
- Sitemap — present and valid
- Schema.org / JSON-LD coverage (Organization, Article, FAQ, LocalBusiness, etc.)
- SSR vs. CSR extractability — is real content present in the raw HTML response, or only after JS executes
- TTFB (time to first byte) — slow servers can time out AI crawlers
- `noai` / `noimageai` meta tag detection (silent AI blockers people forget they set)
- HTTPS / HSTS

### Output
0–100 score with a letter grade (A–F) and a prioritized fix list — this matches the format users already expect from this category of tool.

### The differentiator nobody else can build
Because OpenGEO owns **both** `generate` and `test`, the test command can check whether the currently-served `.md` file **actually matches** the live page content right now — i.e., detect drift/staleness between what's live and what's being served to AI agents. No standalone competitor can do this check, because none of them own both halves of the pipeline.

### Roadmap (not v1)
Markdown *quality* scoring, in two tiers:
- **Rule-based** (no AI key needed): broken links, leftover code artifacts, heading structure sanity, minimum content length.
- **AI-judged** (optional, needs a key): deeper "does this actually read well and cover the page" pass.

---

## 5. Feature Spec: Generate

**Commands:** `opengeo generate <url>` (whole site) or `opengeo generate <url>/<page>` (single page)

### Input
Same rule as `test` — always a URL, local or live. For CSR/SPA pages, content doesn't exist until JavaScript actually runs, so hitting the real URL is the only framework-agnostic way to get real content, without writing a separate adapter for every framework's build-output format.

### Two conversion tiers

**1. Free / algorithmic (no key required)**
Extracts structure directly from the rendered page — headings, tables, lists, etc. For pages that only render client-side (CSR), use **jsdom** (a lightweight, pure-JS DOM implementation that can execute a page's JS inside Node) rather than a full headless browser like Playwright or Puppeteer. This keeps the tool light and avoids bundling a Chromium binary.
> ⚠️ Known, honest limitation: jsdom has no real layout engine and can be flaky with complex async data-fetching or React Suspense. This is a real v1 limitation — validate against real-world SPAs before assuming full coverage.

**2. AI-enhanced (BYOK — bring your own key)**
User supplies their own Gemini / Claude / OpenAI key. The prompt must be engineered for **fidelity, not rewriting**:
> Reproduce this content's structure and text faithfully in markdown. Do not summarize, paraphrase, or alter facts — names, dates, prices, numbers must be preserved exactly.

A subtly reworded fact is worse than a rough-but-correct algorithmic extraction — this matters most on pages like resumes and pricing pages, where a hallucinated or "cleaned up" fact is actively harmful, not just lower quality.

### Timing — build-time only, never per-request
`generate` runs **once**, when the user (or their CI pipeline) runs the command. Output is saved to disk as static `.md` files. When a real visitor (human or AI) hits the live site afterward, the server only ever hands over a file that already exists. **No AI call, no parsing, no computation ever happens while a visitor is waiting.** This is the single most important architectural rule in the whole system — it's what keeps the prod path fast and cheap.

### Caching
Hash each page's source content. Skip reconversion for pages that haven't changed since the last run — this keeps the AI tier affordable and keeps repeat builds fast.

### Freshness
Stamp a `last_updated` timestamp into every generated `.md` file's frontmatter. This is what lets `test` detect staleness, and lets a human (or an AI agent) see how current the content is.

### Route discovery
Crawl starting from `/`, following real `<a href>` links. This works out of the box for Next.js `Link`, React Router `Link`, and most standard nav patterns, since they render real anchor tags by default.
- Auth-gated or unlinked pages are **intentionally out of scope** — the target audience (blogs, portfolios, marketing sites) doesn't need this, and it isn't meant to be found by AI anyway.
- An optional config file lets a user manually declare extra routes the crawler can't discover on its own.
- **Explicitly not building:** per-router-library adapters (a React Router config parser, a Vue Router config parser, a TanStack Router config parser, etc.). This was a deliberate call — it would turn "framework-agnostic" into "we maintain a parser per router library forever."

### Manual editing
Users can hand-edit any generated `.md` file afterward — e.g., to add what the AI missed. `opengeo-prod` doesn't know or care whether a file was AI-generated, algorithmically generated, or hand-edited; it just serves whatever file is on disk. This preserves a "human can improve the output" workflow without needing generate logic present at runtime.

### CLI convention
Fixed binary command (`opengeo generate ...`) — never tied to the user's own project name. Keeps docs and muscle memory consistent across every project that installs it.

---

## 6. Feature Spec: Prod

**Package:** `opengeo-prod` — a runtime middleware the user installs into their own deployed app.

### Requirements
Needs a host with a server/edge compute layer — **Vercel, Netlify, Cloudflare Workers**, or similar. Will **not** work on a purely static host with zero server component (e.g. plain GitHub Pages with no functions).

### Visitor classification (on every request)

| Visitor type | Behavior |
|---|---|
| Human | Serve the real site, unchanged (HTML/CSS/JS) |
| Selected/allowed AI (from user's configured list) | Serve the matching pre-generated `.md` file |
| Unknown / unrecognized bot | **Default: treat as a normal visitor, serve the real site.** Never block by default. |

New AI products launch constantly and won't be on any maintained list immediately. Blocking unknowns by default would silently wall a site off from every future AI product until maintainers catch up. Blocking is opt-in, per bot, never the default.

### Detection signal
Primarily **User-Agent string matching** against a maintained, community-updated AI-bot list (this is an open-source project — the list improves via contributions over time). `Accept: text/markdown` header negotiation is a secondary signal for the subset of bots sophisticated enough to send it.

### Serving mechanism — rewrite, not redirect
The URL a visitor sees stays the same (e.g. `/resume`). The middleware swaps in the markdown body instead of the HTML body — same URL, same substantive content, just a lighter format. This distinction matters: serving genuinely *different content* to bots vs. humans to manipulate rankings is what's classically called **cloaking**, and is penalized by search engines. Serving the *same* content in a different format, at the same URL, is the established, accepted pattern (used by Cloudflare, Stripe docs, Mintlify, and others).

Must set **`Vary: Accept`** on responses so CDNs cache the HTML and markdown variants separately and never serve the wrong one to the wrong visitor type.

### No live computation, ever
Pure lookup against the static files `generate` already produced. No AI calls, no jsdom parsing, at request time — full stop.

### No API key, ever
By the time `opengeo-prod` is running in production, every `.md` file already exists as a static file. This is also *why* `opengeo-prod` is the one package that's safe to actually push to a live repo or hosting platform — see §9.

### Bot settings — two separate levers, not one
1. **Markdown routing list** — which AI agents get the `.md` version. This feature alone never blocks anyone; worst case, an unlisted bot just sees the normal site.
2. **Access blocking list** — a fully separate, opt-in list for owners who want to block specific bots entirely (e.g. bulk training crawlers), implemented via generated `robots.txt` rules.

> **Important distinction:** `robots.txt` is a voluntary convention respected by well-behaved *bulk crawlers* (like GPTBot doing a training scrape). It does **not** govern a *live agent* fetching a single page mid-conversation on a human's behalf (e.g. Claude or ChatGPT retrieving a URL a user pasted) — that's a normal one-off HTTP request, not a crawl, and typically isn't checked against `robots.txt` at all. These need two different controls, not one.

### Freshness visibility
Surfaces when each page's `.md` was last generated (reads the `last_updated` frontmatter `generate` wrote) and prompts the user to rerun `opengeo generate` when content's gone stale.

### Verification command
`opengeo prod test <url>` — confirms the live middleware is actually working: does a request flagged as an allowed AI actually get served markdown, does a normal request get the real site.

---

## 7. Website UI (`opengeo` package only)

- Launched via `opengeo start -p <port>` — spins up a **local** web server + UI on the user's own machine only. Never hosted by OpenGEO; nothing leaves localhost.
- **First-run onboarding:** select/confirm project → enter AI provider + API key → configure initial bot allow-list.
- **Left nav:** Test, Generate, Prod, Bot Settings, general Settings — mirrors the CLI feature set exactly.
- This is a GUI wrapper over the same shared core library the CLI commands call — not a separate implementation (see §3).
- **Hard requirement:** no telemetry, analytics call, or "sync to cloud" feature may ever transmit the stored API key anywhere. The only network call involving the key is the direct call to the user's chosen AI provider. Document exactly where the key is stored on disk in the README — this should be auditable by anyone reading the code.

---

## 8. CLI Reference

| Command | Package(s) | What it does |
|---|---|---|
| `opengeo setup` | `opengeo`, `opengeo-cli` | Terminal-based onboarding: pick project, enter key, configure bots |
| `opengeo start -p <port>` | `opengeo` only | Launches the local website UI |
| `opengeo test <url>` | `opengeo`, `opengeo-cli`, `opengeo-testing` | Runs the AI-readiness audit, returns score + fix list |
| `opengeo generate <url>` | `opengeo`, `opengeo-cli`, `opengeo-generate` | Generates `.md` files for all discovered routes |
| `opengeo generate <url>/<page>` | same as above | Generates/regenerates a single page |
| *(integrate in code)* | `opengeo`, `opengeo-cli`, `opengeo-prod` | Middleware import used directly in the user's own app code |
| `opengeo prod test <url>` | `opengeo`, `opengeo-cli`, `opengeo-prod` | Verifies the live prod middleware is serving correctly |

---

## 9. Security & API Key Handling

- The key is read from a local `.env` file (or local config, for the website flow) — never hardcoded, never committed.
- On `opengeo setup` (or first install), automatically add `.env` to `.gitignore` if it isn't already there — this is the actual mechanism that prevents an accidental key leak, more than any naming convention.
- **Only `generate`** (and the website UI wrapping it) ever touches the API key. `test` and `prod` never need it — by construction, not by convention.
- **Recommended deploy pattern:** push only `opengeo-prod` to the live production repo / hosting target. It has zero key dependency, so there's nothing to leak.
- **For teams wanting fresh `.md` output on every deploy:** set the AI provider key as a platform secret / environment variable in Vercel or Netlify (not committed to code), and run `opengeo generate` as a build step in the deploy pipeline. This is the standard, safe pattern most dev tools already use for this exact situation.

---

## 10. Naming & Branding

- **Project name:** OpenGEO.
- Earlier working names ("dynamic-markdown" / "dynmd") were considered and dropped — forgettable, typo-prone, and risked sounding like a claim to *be* the `llms.txt` standard rather than a tool that supports it.
- **Category:** GEO (Generative Engine Optimization) / AEO (Answer Engine Optimization) — external-facing language should use this term, not classic "SEO." Google's own crawler already executes JS fine; the audience here is specifically LLM agents that often don't.
- **Locked package names:** `opengeo`, `opengeo-cli`, `opengeo-testing`, `opengeo-generate`, `opengeo-prod`.
- **Intentional naming mismatch:** the CLI command for the testing package is `opengeo test` (no "-ing"), even though the *package* is named `opengeo-testing`. This was a deliberate choice, not an inconsistency to fix.

---

## 11. Error Handling Convention

When a limited package's CLI is asked to run a command it doesn't include (e.g. someone installs only `opengeo-testing` and runs `opengeo generate`), fail with a clear, friendly, **personalized** message naming exactly which package to install instead.

All such error copy lives in **one shared internal module**, imported by every package — never duplicated per package. Wording only ever needs to change in one place.

---

## 12. Competitor Landscape

### Testing tools
Most existing tools check the same baseline: `robots.txt` AI-bot rules, `llms.txt` presence, sitemap validity, Schema.org/JSON-LD coverage, SSR-vs-CSR extractability, TTFB, `noai` tags, HTTPS — usually output as a 0–100 score with a letter grade.
- **`aeo-scan`** (npm, by iSimplifyMe) — small, dependency-free core; site-specific customization lives in a config file rather than the core itself. Good architectural pattern to borrow for `opengeo-testing`.

### Generate tools
- **md4AI** (WordPress plugin) — auto-generates a markdown version of every page, lets the user manually edit it afterward, and has an optional "enhance with AI" button. This is architecturally the closest match to OpenGEO's two-tier generate plan — just built for WordPress instead of general JS frameworks.
- **E-GEO** (Python) — analyze → rank-simulate → rewrite → JSON-LD schema, as one pipeline. Focused on making content read well for AI; less on detect-and-serve.
- **`llmstxt`, `llm-docs-builder`** (npm) — narrower single-purpose tools that convert an existing sitemap or docs tree into `llms.txt`. Index-file generators, not full page-by-page converters.

### Prod / serving tools — closest direct competitor
- **Dualmark** (`github.com/dodopayments/dualmark`, dualmark.dev) — the most direct existing competitor to the `opengeo-prod` feature. Same core idea: one URL, two formats, picked automatically via HTTP content negotiation — humans get HTML, AI bots get markdown. Open source, Apache 2.0, TypeScript, real traction (88 stars, 27 forks at time of research). Already supports **Next.js, Astro, and Cloudflare Workers**.
  - **Gap it leaves open:** no coverage found for Vite / plain vanilla-JS SPAs (client-side-only apps with no server-rendered content). This remains genuinely unsolved, even by the closest competitor — see §15.

### Broader landscape (adjacent, not direct competitors)
A large and fast-growing set of tools — **GetCito**, **ai-visibility** (Python/PyPI), **canonry**, and various WordPress/Laravel/Magento plugins — mostly solve a *different* problem: **tracking and monitoring** whether/how AI answer engines already mention or cite a brand, rather than technically generating and serving AI-readable content. Worth knowing about, not worth treating as head-to-head competition for OpenGEO's core loop.

### Market signal worth noting
Nearly every serious competitor in this space describes itself with some version of "open source," "self-hostable," "MIT/Apache-licensed," or "every metric auditable in code." In this specific category, being open source isn't just a nice-to-have — it's close to a **trust requirement** before someone will hand a tool their API key and let it touch their production site. OpenGEO's open-source choice matches what this market already expects.

---

## 13. Why OpenGEO / Differentiation

1. **Genuinely framework-agnostic**, across the full JS ecosystem (React, Vue, Svelte, Remix, plain Vite, vanilla JS) — not just Next.js/Astro like the closest existing competitor.
2. **All three pillars in one toolchain** (test + generate + prod), instead of one narrow tool per pillar, which is what the rest of the market offers today.
3. **The staleness/drift check** (§4) — structurally impossible for any standalone competitor to build, since it requires owning both `generate` and `test`.
4. **Two-tier generate, generalized beyond WordPress** — takes the best existing pattern (md4AI's auto + manual-edit + AI-enhance flow) and makes it available to any JS framework.
5. **Modular, shared-core publishing** — five packages, one codebase, so users install only the piece they need without the project maintaining five separate implementations.

---

## 14. Non-Goals (v1)

Explicitly out of scope for the first version — call these out clearly to avoid scope creep during the build:

- Auth-gated / login-walled pages (target audience is public content: blogs, portfolios, marketing sites)
- Full headless-browser rendering (Playwright/Puppeteer) as a default path — jsdom only, for v1
- Per-JS-framework router config parsers (React Router / Vue Router / etc. adapters)
- Blocking unknown/unrecognized bots by default — always opt-in
- Serving *substantively different* content to bots vs. humans — the markdown and HTML must always represent the same underlying content, only the format differs

---

## 15. Known Technical Risks / Open Questions

Be honest about these rather than assuming they're solved:

- **CSR/SPA extraction ceiling:** jsdom can fail or behave inconsistently on complex async-data or React-Suspense-heavy client-rendered pages. Needs real-world validation before claiming full SPA support.
- **No headless-render fallback in v1:** this is a real limitation shared industry-wide — even Dualmark, the closest competitor, doesn't appear to solve pure client-side SPA support either.
- **Route discovery ceiling:** crawling from `/` via real `<a href>` links misses anything gated behind auth, unlinked, or navigated purely through JS with no real anchor tags. Accepted as a known limitation (see §14), not something to silently claim full coverage of.
- **Bot list maintenance:** the AI-bot User-Agent list needs continuous upkeep as new AI products launch — an open-source, community-updated list helps, but this is an ongoing cost, not a one-time build.
- **CDN/caching correctness:** `Vary: Accept` needs real end-to-end testing across hosting targets (Vercel, Netlify, Cloudflare) to confirm markdown and HTML variants never leak into each other's cache.

---

## 16. Suggested Build Sequence

Don't build all three pillars, all extraction methods, and all five packages at once. Sequence:

1. **Generate, MDX/file-based-routing frameworks first** (Next.js, Astro) — content is already markdown-sourced or present in server-rendered HTML, so the free tier can be near-perfect here at zero cost. Validates the core pipeline fastest.
2. **Add the BYOK AI-enhanced tier** on top, with the fidelity-locked prompt (§5).
3. **Test feature** — can be built largely in parallel, since it's mostly independent of the generate pipeline (except for the staleness-check differentiator, which needs `generate` to exist first).
4. **SSR HTML extraction** for non-MDX SSR frameworks (Nuxt, plain SSR setups).
5. **Prod middleware** — once `generate` reliably produces trustworthy `.md` output to serve.
6. **CSR/SPA support via jsdom** — last, and only once there's real signal that people want the tool at all. This is the hardest, least-differentiated case (even the closest competitor hasn't solved it), so it shouldn't gate the rest of the launch.

---

## 17. Suggested Tech Stack

- **Monorepo:** npm workspaces + Turborepo (or Changesets) for shared code, synced versioning, and multi-package publishing.
- **CSR extraction (v1):** jsdom. Full headless-browser rendering (Playwright) explicitly deferred — worth revisiting later as an optional, heavier opt-in mode, not the default.
- **Prod middleware targets:** Vercel / Netlify / Cloudflare Workers-style edge functions — will likely need one thin adapter per hosting target, similar in spirit to how Dualmark structures its adapters (worth reading their adapter code directly before designing this).
- **License:** open source (MIT or Apache 2.0) — matches the near-universal norm in this competitive category, and functions as a real trust requirement for a tool that touches a user's API key and production site, not just a philosophical preference.

---

*This document reflects every decision made through iterative planning conversations. Treat §14–15 as living sections — update them as real build constraints are discovered.*
