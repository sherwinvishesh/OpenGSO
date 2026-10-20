# Security

## Reporting a vulnerability

Report it privately through a
[GitHub security advisory](https://github.com/sherwinvishesh/OmniGEO/security/advisories/new) on
this repository. Please do not open a public issue for it.

Say which package and version (or commit) you tested, what an attacker can do, and how to reproduce
it. You will get an answer through the advisory, and the fix is credited to you unless you ask
otherwise.

OmniGEO is pre-release and nothing is on npm yet, so only the `main` branch is supported.

## What OmniGEO runs, and where

| Piece | Runs on | Trusts |
| --- | --- | --- |
| `omnigeo-prod` (the middleware) | your server, on every request | the files `omnigeo generate` wrote |
| `omnigeo test`, `generate`, `prod test` | your machine | nothing it fetches |
| `omnigeo start` (the dashboard) | your machine, on loopback by default | only requests that pass the checks below |

### omnigeo-prod

- Zero dependencies. Its library contains no jsdom, no AI provider code and no network call, and
  `npm run check:bundles` fails the build if one appears.
- It reads `.omnigeo/manifest.json` and the twins it lists once, at boot. A manifest entry that
  resolves outside `publicDir` is refused and reported, never loaded.
- It has no blocking code path, never redirects, and refuses (406) only on a route that has a twin.

### The test and generate pillars

- Every page they fetch is untrusted. HTML is parsed with jsdom and **page scripts are never
  executed**: `runScripts` is not enabled anywhere.
- A response body is capped at 8 MiB and every request has a timeout.
- `test --prompt` quotes anything the site sent (a header, a JSON-LD field) as a single-line code
  span cut at 400 characters, and tells the coding agent those spans are evidence, not
  instructions.
- Generate writes only inside `publicDir` and `internalDir`, both of which must be strictly inside
  the project, and never overwrites a file OmniGEO did not write.

### The dashboard (`omnigeo start`)

The dashboard can write an API key to disk and start runs that cost money, and any web page you
visit can send requests to a port on your machine. So `packages/core/src/server/server.js` checks
every request before it reads the body:

- **Loopback by default.** It binds `127.0.0.1` unless you pass `--host`.
- **Host check.** A request whose `Host` header is not a loopback name or the address the server was
  started on, with the right port, gets a 403. This is what stops DNS rebinding. (Bound to a
  wildcard such as `0.0.0.0`, any name is let through to the token check instead.)
- **Origin check.** A request carrying an `Origin` that does not match its `Host` gets a 403.
- **JSON only.** Every API `POST` must be `Content-Type: application/json` (415 otherwise), which a
  plain HTML form cannot send and a cross-origin script cannot send without a preflight the server
  never grants. Nothing that runs a test or writes a file is reachable by `GET`.
- **Body cap.** A request body over 2 MiB is refused.
- **Token for any other `--host`.** Binding anything other than loopback mints a random token for
  that launch. The printed URL carries it as `?token=`, which is swapped for an `HttpOnly`,
  `SameSite=Strict` cookie; scripts can send `Authorization: Bearer <token>`. Every request without
  it, page or API, gets a 401. The traffic is still plain HTTP, so only do this on a network you
  trust.
- **Headers.** Every response carries a `'self'`-only Content-Security-Policy,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- **Static files** are served only from inside the dashboard's `web/` directory; a path that
  escapes it is refused.
- **Errors** that are not a config problem reach the browser as a generic message; stack traces and
  paths stay in the terminal.

### The API key

- It is read from `.env` in your project and sent to exactly one place: the AI provider you picked.
- It is never written to `omnigeo.config.json`, never logged, and never in an API response.
  `/api/state` reports only that a key exists, which provider it is for and which file it came from.
- `.env` is added to `.gitignore` **before** the key is written, by `omnigeo settings`,
  `omnigeo start` and the dashboard alike.
- Only `/api/key` can change where the key goes, and it takes the key and the endpoint in the same
  request. `/api/config` refuses any change to the `ai` block, so a patch cannot point a saved key at
  another host.
- The AI tiers refuse to run in CI.
- There is no telemetry, analytics or cloud sync, so nothing else could send it anywhere.

## Out of scope

- Anything that needs `--host` set to a non-loopback address on a network you do not trust, beyond
  what the token check promises.
- Whatever your AI provider does with the content you send it. Generate's AI tier and
  `test --content` send page text to the provider you configured; the free tier and the structural
  test send nothing.
- How a CDN in front of your site caches `Vary: Accept` responses. That is documented as untested.
