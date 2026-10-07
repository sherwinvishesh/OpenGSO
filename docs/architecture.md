# Architecture

A contributor's map of the repository: where code lives, how it reaches the published packages,
and the rules the build enforces. For the dev loop, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## One core, five thin packages

```
packages/core       @opengeo/core. Private, never published. All logic lives here.
packages/testing    opengeo-testing
packages/generate   opengeo-generate
packages/prod       opengeo-prod
packages/cli        opengeo-cli
packages/opengeo    opengeo, plus web/ (the dashboard)
```

The code is plain JavaScript with JSDoc types, checked by `tsc` in strict mode. Each published
package is a set of small entry files in its `src/` that import from `@opengeo/core/...`. tsup
bundles core into each one (`noExternal`), so core is never an install-time dependency and each
tarball carries only the code its entries reach.

Adding a core export means touching three places, and `packages/core/tests/wiring.test.js` checks
that they agree:

1. `packages/core/package.json` `exports`, which point at source files;
2. `tsconfig.base.json` `paths`, which lets `tsc` resolve `@opengeo/core/...`;
3. the entry file of every package that ships it.

Which package ships which command is the `COMMAND_PACKAGES` table in
`packages/core/src/shared/errors.js`. The same test checks it against the `commands` each package's
`cli.js` actually wires up.

## Inside core

| Directory | What it holds |
| --- | --- |
| `shared/` | Everything more than one pillar needs: config loading, the bot catalogue, routes and twin paths, HTTP fetching, the provider catalogue, `.env` handling, the spec version and header names, and every user-facing error string (`errors.js`). |
| `test/` | The test pillar: discovery, the 22 checks, scoring, the report, run history, and the AI content pass, which is reported separately and never touches the score. |
| `generate/` | The generate pillar: crawl, extract (jsdom as a parser only, never running scripts), the optional AI rewrite and its fidelity check, and the writers for twins, `robots.txt`, `llms.txt`, `sitemap.xml` and the manifest. |
| `prod/` | The runtime middleware and `prod test`. The library half has no dependencies; `adapters/next.js` is the Next.js wrapper; `edge.js` is the subset with no `node:` imports. |
| `server/` | The dashboard's local HTTP server and JSON API, started by `opengeo start`. |
| `cli/` | Argument parsing, every command (`cli/commands/`), the onboarding flow, and the full-screen home screen. `cli/tui/` is the zero-dependency terminal toolkit it is drawn with. |

## How the pillars connect

1. **generate** crawls the running site, writes one markdown twin per page to
   `<publicDir>/md/<route>.md`, writes `robots.txt`, `llms.txt` and `sitemap.xml` beside them, and
   records every page in `<internalDir>/manifest.json`. It never overwrites a file it did not
   write: it saves `<name>.opengeo-proposed` instead, unless `--force` is given.
2. **prod** loads the manifest and twins once at startup into a store. On each request it decides,
   from the User-Agent and the `Accept` header, whether to serve the twin at the same URL (a
   rewrite, never a redirect), answer 406, or pass through with discovery headers added. It never
   blocks a crawler. Blocking is opt-in and exists only as the `robots.txt` generate writes.
3. **test** fetches a live URL, parses it (jsdom again, scripts never run), runs the 22 structural
   checks, and scores them 0 to 100. Each scored run is appended to `<internalDir>/history.json`,
   which keeps the newest 20 runs of each URL, is never web-served, and is never read by prod.

`opengeo.config.json` is the one file all three read. Its fields are in [config.md](config.md).

## The dashboard

`opengeo start` runs `server/server.js` and serves `packages/opengeo/web/`, which is plain HTML, CSS
and JavaScript with no build step. The web code calls the JSON API in `server/api.js`, which runs
the same core functions the CLI does. The server's security model is in
[SECURITY.md](../SECURITY.md).

## What the build enforces

- `npm run check:bundles` reads `dist/`: the prod libraries carry no jsdom, no AI code and no
  network call, the edge entries import no `node:` module, every bundle imports only Node builtins
  and its declared dependencies, and `opengeo-prod` declares none.
- `npm run check:packages` runs each bin, imports each export by package name, and checks what
  `npm pack` would ship.
- `packages/core/tests/docs.test.js` checks the facts the docs and READMEs state (weights, headers,
  config fields, export names) against the code.
