# opengso-cli

> **Early release.** Until 1.0, a minor release may change a command, a flag, a config field or an export.

All three OpenGSO pillars behind one command: `test`, `generate`, `prod test`, `prod data`, and
`settings`.

This is the package to install if you want the whole toolchain from the terminal and do not need the
local dashboard. If you want the dashboard too, install
[`opengso`](https://github.com/sherwinvishesh/OpenGSO/blob/main/packages/opengso/README.md) instead.

Part of [OpenGSO](https://github.com/sherwinvishesh/OpenGSO).

## Install

Needs Node.js 22 or later.

```bash
npm install --save-dev opengso-cli
```

Or run it without installing:

```bash
npx opengso-cli settings
```

## The loop

```bash
opengso settings                               # site, bot routing, optional API key
opengso test http://localhost:3000/resume      # score it as it is today
opengso generate http://localhost:3000         # write the twins and the three root files
# wire up opengso-prod in your middleware
opengso prod test http://localhost:3000/resume # prove the deployment serves them correctly
opengso test http://localhost:3000/resume      # score it again
```

## Commands

### `opengso test <url>`

Scores a live URL 0 to 100 and says exactly what failed, then has a model read the Markdown those
checks found and rate how well it answers. Three shapes:

```bash
opengso test <url>              # both passes. The review is skipped with a note if you have no key
opengso test <url> --structure  # the checks alone. Also --offline, -nq. No key, no cost
opengso test <url> --content    # the review alone
opengso test <url> --prompt     # a fix prompt for a coding agent instead of a report
opengso test <url> --copy       # the report, then that prompt on your clipboard for Claude Code
opengso test <url> --copy --only A3  # a prompt for one check, or a few: --only B1,B7
```

The exit code always comes from the structural checks. A model's opinion never fails a build. See
[opengso-testing](https://github.com/sherwinvishesh/OpenGSO/blob/main/packages/testing/README.md).

### `opengso generate <url>`

Crawls the site and writes `public/md/**`, `robots.txt`, `llms.txt` and `sitemap.xml` from one pass.
Never overwrites a file it did not write. See
[opengso-generate](https://github.com/sherwinvishesh/OpenGSO/blob/main/packages/generate/README.md).

### `opengso prod test <url>`

Probes a live deployment and reports the two bot levers separately. See
[opengso-prod](https://github.com/sherwinvishesh/OpenGSO/blob/main/packages/prod/README.md).

### `opengso prod data`

Writes the twins, the routing and your custom crawlers into `opengso-edge-data.js` (`.ts` in a
TypeScript project) for an edge function to import, since an edge runtime has no disk to read them
from. Run it after `generate` and before your bundler; `generate` refreshes a module it finds.
`--out <file>` picks the path, `--json` prints the result, and like everything else it never replaces
a file OpenGSO did not write without `--force`. See
[Edge runtimes](https://github.com/sherwinvishesh/OpenGSO/blob/main/packages/prod/README.md#edge-runtimes).

### `opengso settings`

Four questions: your site URL and web root, which AI agents get the markdown twin, the block list,
and an optional API key. Every default is the current value, so pressing Enter through the whole
thing changes nothing. It finishes by printing what actually changed.

The routing question has four answers: every AI agent, assistants only, nobody, or **let me pick,
one by one**. Neither of the first two includes a search-engine crawler such as Bingbot: a markdown
response is marked `noindex`, which at the page's own URL would drop the page from that engine's
results. You can still tick one by hand, and both settings and prod's startup log warn when you
have. The fourth answer lists every crawler with a number and a tick box, and you toggle them by
name or by number:

```
opengso settings

   1) [x] GPTBot           OpenAI · training
   2) [ ] OAI-SearchBot    OpenAI · search
   ...
      +   add              a crawler OpenGSO has never heard of

  18 of 26 selected.

  markdown to (name, number, all, none, add, or Enter to finish) none
  markdown to (name, number, all, none, add, or Enter to finish) gptbot claudebot
```

`add` defines a crawler that is not on the list at all: an in-house agent, or an AI product newer
than your installed version. It asks for a name and guesses the rest, and the answer is stored under
`bots.custom` in your config, which is the same list the runtime resolves. A development server
picks it up on its next request; restart a production build.

The key step adds `.env` to `.gitignore` **before** it asks for the key, every time, and says so on
screen. The prompt is masked. The key is written to `.env` and never to `opengso.config.json`, which
is the file you commit.

`--yes` accepts every default without prompting, and writes no key. `opengso setup` still works, and
runs this.

## Configuration

`opengso.config.json` at your project root. `opengso settings` writes it; you can also edit it by
hand.

Run from a subdirectory, OpenGSO looks for the file in the current directory and then upward, but
never past the project. Inside a git repository the project ends at the repository root, so a
workspace package in a monorepo finds the config at the top. Outside one it ends at the nearest
`package.json`, and with neither only the current directory is checked. Pass `--project <dir>` to
point at a project explicitly.

```jsonc
{
  "site": "http://localhost:3000",
  "publicOrigin": "https://example.com",  // where the site is deployed; optional, see below
  "publicDir": "public",          // where generated files go; a folder below the project root
  "internalDir": ".opengso",      // bookkeeping, never web-served
  "extraRoutes": [],              // pages nothing links to
  "crawl": { "maxPages": 200, "maxDepth": 4, "exclude": [] },
  "generate": { "tier": "free", "minWords": 40 },
  "bots": {
    "markdownRouting": ["ClaudeBot", "GPTBot", "..."],  // who gets markdown
    "blocked": [],                                       // who is asked not to crawl
    "custom": []                                         // crawlers OpenGSO does not ship with
  },
  "ai": { "provider": "anthropic", "model": "claude-sonnet-5-5" }
}
```

Every command checks the file when it loads it and names the field that is wrong rather than failing
later: lists have to be lists, `generate.tier` is `free` or `ai`, `crawl.maxPages` is a whole number
from 1 to 100000, `crawl.maxDepth` from 0 to 100 and `generate.minWords` from 0 to 100000.

`publicOrigin` is where the site lives once deployed, `https://example.com`, or
`https://user.github.io/repo` for a site in a folder of its host when you generate from its build
folder. Generate still crawls the URL you give it, usually a dev server,
but every absolute URL it writes uses `publicOrigin` instead: the sitemap, the `Sitemap:` line in
`robots.txt`, `llms.txt`, each twin's `url` and the links inside it. Leave it out and those URLs
name the origin that was crawled. If that is a loopback address, generate warns, because a sitemap
pointing at `localhost` sends every crawler that reads it nowhere.

The `ai` block takes four more optional fields when you point OpenGSO at a gateway or an endpoint it
does not ship with: `baseUrl`, `api` (`openai`, `anthropic` or `gemini`), `auth` and `headers`. See
[Add your own AI tool](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/providers.md#add-your-own-ai-tool).

`bots.markdownRouting` and `bots.blocked` are **different levers** and neither implies the other.
Routing chooses a format and never blocks. Blocking is opt-in, empty by default, and is expressed
only through the `robots.txt` that generate writes. The runtime has no blocking code path at all.

`bots.custom` is a third, separate thing: a list of crawlers OpenGSO has never heard of, which are
added to the catalogue everything else works from. Only a name is required.

```jsonc
{
  "name": "AcmeBot",
  "vendor": "Acme Inc",              // optional, defaults to "Custom"
  "uaPatterns": ["acme-crawler"],    // optional, defaults to the lowercased name
  "robotsToken": "AcmeBot",          // optional, defaults to the name
  "kind": "assistant"                // assistant | search | training
}
```

Adding one here does not route to it. Put its name in `markdownRouting` too, or tick it in the
picker, which does both.

## AI providers

Twenty-five of them, including Anthropic, OpenAI, Gemini, xAI Grok, Alibaba Qwen, DeepSeek, Kimi,
GLM, Mistral, Perplexity, Groq, Cerebras, OpenRouter, Hugging Face, Ollama and LM Studio on your own
machine, and anything else you can name a URL for.

```bash
opengso help providers                      # the whole catalogue, with keys links
opengso test <url> --provider groq          # override for one run
opengso settings                            # pick one interactively
```

Adding one OpenGSO has never heard of is three lines of config, not a fork:
[docs/providers.md](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/providers.md).

### Where your API key lives

`.env` in your project, under `OPENGSO_API_KEY`, and nowhere else. It is sent to the AI provider you
chose and to nobody else. OpenGSO has no telemetry, no analytics and no cloud sync, so there is
nothing else that could transmit it. `.env` is added to `.gitignore` before the key is written.

Most of OpenGSO needs no key: the whole 0 to 100 structural test, the entire free generate tier, and
all of `opengso-prod`.

## Reference

- [The check catalogue](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/checks.md)
- [The wire spec](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/spec.md)
- [AI providers, and adding your own](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/providers.md)
