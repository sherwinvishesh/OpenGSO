# Troubleshooting

The problems people hit first, by what you see. Quoted text is the start of the real message.

## `opengeo test`

**The score is 100 but the report still lists suggestions.** Expected. Seven checks make the
score; the other fifteen (`llms.txt`, JSON-LD, the markdown twin and its headers) are suggestions,
counted as "N of 15 adopted". The best-read sites have not adopted them either, so they never move
the number. They are what would set your site apart, and `opengeo generate` plus `opengeo-prod`
adopts most of them at once.

**B1 is a suggestion and B2 to B14 show as locked.** The site serves no markdown twin, so the
checks that inspect one cannot run. They are reported as a single locked block, "12 more
suggestions apply once B1 passes", rather than as thirteen findings about one missing file. Run
`opengeo generate <url>`, then add `opengeo-prod` to the server (see its README), restart it, and
test again.

**CI passed although a suggestion failed.** Only a scored check that fails sets exit code 1. Pass
`--strict` to fail the build on any failing check, which is what you want once the markdown layer
is live and should stay that way.

**B7 scores 2 of 4 on a Next.js site.** Expected. Next's App Router will not let middleware add
`Vary` to a response it did not create, so the markdown side has it and the HTML side does not. It
is a partial suggestion, not a failure, and does not change the exit code, even with `--strict`.

**A8 says n/a.** HTTPS and HSTS mean nothing on `localhost`, so the check is left out of the score
there. Test the deployed URL to measure it.

**"Couldn't reach ..."** Nothing answered at that URL. For a local site, check the dev server is
running and on the port you gave.

**The content pass is skipped, or refuses to run.** It needs an AI provider and key; run
`opengeo settings`. `--quality` (`-q`) turns a missing key into a failure. It never runs in CI, by
design: the content pass and generate's AI tier refuse with "... is a local-machine-only feature
and won't run in CI."

## `opengeo generate`

**"... already exists and wasn't written by OpenGEO - leaving it alone."** Your own `robots.txt`,
`llms.txt`, `sitemap.xml` or twin was kept. OpenGEO's version is beside it as
`<name>.opengeo-proposed`; merge what you want. `--force` overwrites. For a twin, add
`generated_by: manual` to its frontmatter to serve your own.

**"Only N words of content (the warning starts below 40)."** The page probably renders its content
with JavaScript in the browser. OpenGEO reads the server's HTML and has no headless browser, so it cannot see that
content. Server-render the page, or lower `generate.minWords` if the page really is that short.

**"... point at http://localhost:3000, which only this machine can reach."** Set `publicOrigin` in
`opengeo.config.json` to the deployed origin and generate again, so the sitemap, `robots.txt`,
`llms.txt` and twins link to the real site.

**"Stopped at the 200-page cap ..."** Raise `crawl.maxPages`. Every request counts, failed ones
included.

**A page is missing.** The crawl follows links from the start URL, up to `crawl.maxDepth` deep. Add a
page nothing links to under `extraRoutes`, and check `crawl.exclude` is not skipping it.

**Twins remain for pages that are gone.** Generate lists them as orphans and stops serving and
listing them, but leaves the files. `--prune` deletes them.

**"... needs an AI provider, and none is configured."** The AI tier and the content pass are
bring-your-own-key. Run `opengeo settings`, or set `OPENGEO_PROVIDER` and `OPENGEO_API_KEY` in
`.env`. See [providers.md](providers.md).

## `opengeo-prod`

**Agents still get HTML.** In order:

1. Was generate run, and is `.opengeo/manifest.json` there? The startup log lists what prod found.
2. Is the crawler in `bots.markdownRouting`? Search-index crawlers are left off by default, because
   every twin carries `X-Robots-Tag: noindex`. Any client can still ask with
   `Accept: text/markdown`.
3. Was the server restarted? prod reads the config and twins once, when it starts.
4. On Next.js, does the middleware `matcher` cover the page?

`opengeo prod test <url>` probes all five cases and reports each one.

**"[opengeo-prod] markdown is off, and every request passes through ..."** `opengeo.config.json`
has an error, named at the end of the line. The site keeps working; fix the field and restart.

## Config

**"... in opengeo.config.json has to be ..."** The named field has the wrong type or range. Every
field and its allowed values are in [config.md](config.md).

**"... which is not a directory inside the project."** `publicDir` and `internalDir` must be
relative paths to folders inside the project, and not the project root itself.

## The dashboard and the terminal

**"Refused: this dashboard only answers to the address it was started on ..."** Open the exact URL
`opengeo start` printed. A different hostname for the same machine is refused on purpose.

**"Refused: this dashboard is reachable from the network ..."** It was started with `--host` on a
non-loopback address, so it needs the token in the printed URL. The token changes every launch.

**Bare `opengeo` prints flat prompts instead of the full-screen home screen.** The home screen needs
stdin and stdout to both be a terminal, and turns itself off when `CI`, `NO_COLOR` or
`OPENGEO_NO_TUI` is set or `TERM` is `dumb`. The flat prompts do the same things. With no terminal
on stdin at all, as in a pipe or a script, it prints the help page.
