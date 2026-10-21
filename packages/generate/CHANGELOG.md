# opengso-generate

## 0.1.2

### Patch Changes

- 82d7b32: The dashboard API's two body errors no longer carry an "Error: " prefix. A body that is not JSON answers "The request body was not valid JSON." and one past the cap "The request body is too large: the dashboard accepts up to 2 MB."
- 105e062: Pages are decoded in the charset they declare. Every body was read as UTF-8, so a site served as `iso-8859-1` or `windows-1252` had each accented letter replaced by U+FFFD in its twin and in the test report. The Content-Type charset is used first, then a `<meta charset>` in the first two kilobytes, then UTF-8; a label Node does not know falls back to UTF-8.
- 5fe5576: `createEdgeMiddleware` throws a clear error where it is built when `data` is not the module `opengso prod data` writes: undefined from a named import of the default export, the module namespace, or an object with no manifest, pages table or contents. The message names the import that fixes it, in place of "Cannot read properties of undefined (reading 'manifest')". A page in hand-built data without a route and a file, or whose content is not a string, is reported and skipped rather than crashing the store.
- 67c5aed: A filesystem failure is reported as a sentence that names the folder in the way. `opengso generate` said "EEXIST: file already exists, mkdir '/abs/path/public/md'" when `public/md` was a file, and "EACCES: permission denied, open '/abs/path/public/.robots.txt.123.tmp'" named the staging file of an atomic write rather than `public/robots.txt`. It now says "public/md is a file, not a folder, so nothing can be written under it" and "no permission to write public/robots.txt", with paths relative to the project. The reset escape that `truncate` appended when a long path was wrapped is only emitted when a colour was open, so it no longer leaks into piped output.
- 57931aa: A static site's folder pages now resolve their relative links from inside the folder. On a GitHub Pages project site, `docs/index.html` is served at `/repo/docs/`, so its `../privacy/` is `/repo/privacy/`; generate read the page as `/repo/docs` and wrote the link as `/privacy/`, outside the site. The twin's source hash now matches the page as served, and the files phase of the progress line no longer names a robots.txt that a site in a folder never gets.
- 292bea6: `opengso generate --force` now removes the `.opengso-proposed` file an earlier run left beside a file it would not overwrite. The proposal was for the file that has just been written, so keeping it only left a stale duplicate for the dashboard to preview.
- 7e1d5cb: Framework detection no longer names a framework because a page talks about one. A page that shows what Next.js emits inside a code sample carried `/_next/static/` and `self.__next_f` as escaped text, and the test report said "Detected: Next.js" for a plain HTML site. Every asset signal now has to sit in the `src` or `href` of a real script, link or img tag, every hydration payload at the start of a real inline script, and every element id on a real element, which is where the frameworks put them and where escaped text cannot.
- e54fdc1: Four corrections to `opengso generate` from running it against VitePress, SvelteKit and the other framework starters.
  
  - `--check` now reports a page whose twin is listed in the manifest but gone from the folder (a rebuild that emptied `dist/`, a stray delete), instead of calling the page up to date because the page itself had not changed.
  - An `opengso.config.json` that does not name `publicDir` now gets the folder the framework serves from the site root (`static/` for SvelteKit, `docs/public/` for VitePress), the same as a project with no config file, and the run says so. A file that names `publicDir` is left alone.
  - A localhost `--origin` on a project that already has a config is no longer saved as `publicOrigin`, matching what the first run does: it names the links of that run and nothing more.
  - A run from a folder no longer prints the note about where the framework serves files; the folder was given on the command line, and the Output line names it.
- b174e80: Each package's npm page now leads to the website and the manual. The homepage field points at
  https://sherwinvishesh.github.io/OpenGSO/, every README opens with links to the website, the
  documentation section for that package, GitHub and its changelog, and ends with a Documentation
  section that names the manual's sections and the reference files it needs.
- c36c5cd: `--project` must name an existing folder. A path that did not exist was accepted by every command: `test` and `prod test` read a config from nowhere, `generate` and `settings` created the folder, and a path to a file crashed `generate` with an ENOTDIR stack. Each now exits 2 with "--project X does not exist" or "--project X is a file, not a folder" before anything is read or written.
- 8fc4e6f: The READMEs are rebuilt around real output. The root README opens with an animated recording of `opengso test`, `opengso generate` and `opengso test` again on the bundled Next.js demo (65 to 100), rendered by `scripts/render-recording.mjs` from captured terminal output rather than drawn by hand; it adds a table of what one URL answers to each kind of request, every row run with `curl`, a table of the frameworks each `opengso-prod` entry was run on, with versions, and the bytes and tokens of the demo's three pages before and after. Each package README carries the real run for its command: the first test report in `opengso-testing`, the generate run in `opengso-generate`, the five probes in `opengso-prod`, the dashboard screens in `opengso`. The npm descriptions and keywords of all five packages are rewritten to say what each one does and what it works with.
  
  `opengso-prod/node` is now verified on Nest 12.2 as well; SolidStart, Remix, Bun, Deno and the non-Cloudflare edge hosts are still listed by the shape they share rather than as run.
- 91dc0f3: Two OpenGSO packages installed in one project now share the `opengso` command properly. Every package installs the same bin, and npm links whichever it installed last, so a project with `opengso-cli` as a dev dependency and `opengso-prod` for the server could end up with `npx opengso test` answering "`opengso test` isn't part of opengso-prod" and telling you to install a package you already had. A command the linked package does not ship is now handed to an installed one that does, found in the same `node_modules` tree the running bin came from, with the same arguments, terminal and exit code. The install message only appears when no installed package ships the command.
- 2b47eab: A site that cannot be fetched is now described by what went wrong. Undici reports a refused port, a redirect loop, a server that hangs up, a name that does not resolve and a rejected certificate all as "fetch failed", and every report said "nothing is listening on port N" for all of them. `probe` now keeps the cause, and the generate crawl, the setup preview, A5, B1, B13 and the prod probes each say "it redirects in a loop", "it closed the connection before answering", "the name X does not resolve", "its HTTPS certificate has expired" or "nothing is listening on port N", as the case is. A5 no longer says "HTTP unreachable" and B13 no longer says "returned HTTP nothing".

## 0.1.1

### Patch Changes

- 0cd405e: The README no longer says that nothing is published to npm. It says instead that until 1.0, a minor release may change a command, a flag, a config field or an export.

## 0.1.0

### Minor Changes

- 0098f41: First release on npm, published 2026-10-20: the test, generate and prod pillars, the terminal home screen and the dashboard, behind five packages that share one `opengso` command.
