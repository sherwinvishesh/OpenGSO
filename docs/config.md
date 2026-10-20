# `opengeo.config.json`

Every field the project config file takes. `opengeo settings`, `opengeo start` and the dashboard
write it; you can also edit it by hand. It is meant to be committed: the API key is never in it
(see [providers.md](providers.md) for the `.env` variables).

## Where it is found

OpenGEO looks in the current directory, then upward, but never past the project: the repository
root inside a git repository, otherwise the nearest `package.json`, otherwise only the current
directory. `--project <dir>` points at a project explicitly. With no file at all, every command
uses the defaults below.

## How it is read

- Any subset is fine. A file with one field takes the defaults for the rest, section by section, so
  `{ "crawl": { "maxPages": 50 } }` keeps the default `maxDepth`.
- Every field present is checked on load, and a wrong one is reported by name rather than failing
  later. Fields OpenGEO does not know are left alone, so a config written by a newer version loads.
- `publicDir` and `internalDir` must resolve strictly inside the project root. The root is where
  `.env` lives, so neither may be the root itself or anywhere outside it.
- `opengeo-prod` reads only `publicDir`, `internalDir`, `bots.markdownRouting` and `bots.custom`.
  If the file is broken, the Next adapter logs one line, serves no markdown and passes every request
  through, rather than taking the site down.

## Fields

| Field | Default | What it is |
| --- | --- | --- |
| `site` | `"http://localhost:3000"` | The URL the project is generated and tested against. Also what a bare `opengeo test` scores. |
| `publicOrigin` | unset | Where the site is deployed: an `http(s)` origin with no path, such as `"https://example.com"`. Every absolute URL generate writes (sitemap, `robots.txt`, `llms.txt`, twin frontmatter and links) uses it instead of the crawled origin. Unset, they name the crawled origin, and generate warns when that is a loopback address. |
| `publicDir` | `"public"` | The web root. Twins go in `md/` under it, beside `robots.txt`, `llms.txt` and `sitemap.xml`. |
| `internalDir` | `".opengeo"` | Bookkeeping that must not be web-served: `manifest.json` and the run history. |
| `extraRoutes` | `[]` | Paths the link crawl cannot reach, such as `"/pricing"`. An entry with a `.` or `..` segment is skipped with a warning. |
| `crawl.maxPages` | `200` | The most requests one crawl makes, a 404 or an off-site redirect included. A whole number from 1 to 100000. |
| `crawl.maxDepth` | `4` | How many links deep the crawl follows from the start URL. A whole number from 0 to 100. |
| `crawl.exclude` | `[]` | Path prefixes the crawl skips, on top of assets, anchors and framework internals. |
| `generate.tier` | `"free"` | `"free"` is algorithmic and needs no key. `"ai"` rewrites each page with your AI provider, checks the numbers survived, and runs only on your machine, never in CI. |
| `generate.minWords` | `40` | A page that extracts to fewer words gets a low-content warning, usually a sign it renders with JavaScript. A whole number from 0 to 100000. |
| `bots.markdownRouting` | every routable crawler that does not build a search index | Lever 1: which AI agents receive the markdown twin at the page's own URL. It chooses a format and never blocks. A crawler not on it gets the normal HTML page. |
| `bots.blocked` | `[]` | Lever 2: crawlers asked not to crawl, expressed only as `Disallow` rules in the `robots.txt` generate writes. Opt-in, and never applied to a crawler OpenGEO does not know. |
| `bots.custom` | `[]` | Crawlers OpenGEO does not ship with, in the shape below. Adding one recognises it; naming it in `markdownRouting` is what routes to it. |
| `ai.provider` | `"anthropic"` | Which AI provider generate's AI tier and `opengeo test --content` use. One of the ids in [providers.md](providers.md). |
| `ai.model` | `"claude-sonnet-5-5"` | The model id. An empty string means the provider's own default. `--model` and `OPENGEO_MODEL` in `.env` take precedence over it. |
| `ai.baseUrl` | unset | Overrides the provider's endpoint, for a gateway or a self-hosted server. `custom` has no endpoint of its own, so it needs this and `ai.model`. |
| `ai.api` | the provider's own | The request shape the endpoint speaks: `openai`, `anthropic` or `gemini`. |
| `ai.auth` | the provider's own | How the key is sent: `bearer`, `x-api-key`, `x-goog-api-key`, or `none`. |
| `ai.headers` | unset | Extra request headers the endpoint needs, as an object of names to string values. Never the key. |
| `ai.params` | unset | Extra fields merged into every request body, such as `{ "temperature": 0.2 }`. `null` removes a field OpenGEO would send. It may not set `model`, `messages`, `system`, `contents`, `systemInstruction` or `stream`. See [providers.md](providers.md). |

`ai.model` and the five overrides describe one endpoint, so changing `ai.provider` through
`opengeo settings` or the dashboard clears them unless the same change restates them. The
dashboard's general config form cannot change `ai` at all: the provider, endpoint and key are saved
together, by `opengeo settings` or the dashboard's AI provider card, so a stored key is never
pointed at a host nobody typed it for.

### A `bots.custom` entry

| Field | Default | What it is |
| --- | --- | --- |
| `name` | required | The crawler's name, as you will put it in `markdownRouting` or `blocked`. |
| `vendor` | `"Custom"` | Who runs it. Display only. |
| `uaPatterns` | the lowercased name | Case-insensitive substrings matched against the User-Agent. |
| `robotsToken` | the name | The token used for it in `robots.txt`. |
| `kind` | `"assistant"` | `assistant`, `search` or `training`. |
| `notes` | unset | Free text, shown where the crawler is listed. |

A name already in the shipped list is ignored, so a custom entry cannot redefine a built-in crawler.
The middleware reads the whole file once, when it starts: restart the server after a change.

## Example

```json
{
  "site": "http://localhost:3000",
  "publicOrigin": "https://example.com",
  "publicDir": "public",
  "internalDir": ".opengeo",
  "extraRoutes": ["/pricing"],
  "crawl": { "maxPages": 200, "maxDepth": 4, "exclude": ["/admin"] },
  "generate": { "tier": "free", "minWords": 40 },
  "bots": {
    "markdownRouting": ["ClaudeBot", "GPTBot", "AcmeBot"],
    "blocked": [],
    "custom": [{ "name": "AcmeBot", "uaPatterns": ["acme-crawler"] }]
  },
  "ai": { "provider": "anthropic", "model": "claude-sonnet-5-5" }
}
```
