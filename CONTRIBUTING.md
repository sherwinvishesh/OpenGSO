# Contributing to OpenGSO

## Layout

```
packages/core        @opengso/core, private, never published. Every pillar lives here.
packages/testing     opengso-testing    test
packages/generate    opengso-generate   generate
packages/prod        opengso-prod       middleware + prod test + prod data
packages/cli         opengso-cli        test + generate + prod test + prod data + settings
packages/opengso     opengso            all of the above + the dashboard
examples/nextjs-demo the app the whole pipeline is exercised against
docs/                the user and contributor docs, listed in the README
```

**A note on `§` references.** Comments and docs across this repo cite section numbers, like
`§7` or `§16`. They point into the original product spec, which is not distributed with the repo.
You do not need it: the decisions those sections drove are all described where they are cited, and
the documents in `docs/` cover the parts a contributor actually has to match.
[docs/architecture.md](docs/architecture.md) is the map of how the code fits together.

`@opengso/core` is private and its `exports` map points at its source files. Each published package
bundles core with tsup (`noExternal: [/@opengso\/core/]`), so core is never an install-time
dependency of anything. Write the code once, in core. A published package should be a thin
entry point and nothing else.

**Plain JavaScript, typed with JSDoc.** Every package's source, tests and config is JavaScript that
Node runs exactly as written, so there is no compile step between editing a file and running it.
The dashboard in `packages/opengso/web` is the same: plain HTML, CSS and JavaScript that the browser
loads as it is, and the files in the repo are the files that ship. Types are
JSDoc comments (`@param`, `@returns`, `@typedef`, `@import`), and `npm run typecheck` checks them
with `tsc` under `strict` and `checkJs`. TypeScript is a dev dependency and a checker, nothing more.
`packages/core/tests/plain-js.test.js` fails if a `.ts` file comes back, and runs every CLI entry
with plain `node` to prove the source works unbundled. `examples/nextjs-demo` stays TypeScript on
purpose: it shows a TypeScript user what wiring OpenGSO in looks like.

Adding an export to core takes three places: `packages/core/package.json` `exports`, the matching
`paths` entry in `tsconfig.base.json`, and the consuming package's entry file. `tsc` resolves core
through the workspace without `paths`, but tsup's declaration build does not: without it,
`opengso-prod`'s types would point at `@opengso/core`, which is never published.

## The loop

```bash
npm install
npm run typecheck
npm test
npm run build
npm run check:bundles
npm run check:packages
```

`npm run build` is packaging only. Nothing needs it to run, test or change the code: after
`npm install`, `npm run opengso -- <command>` runs the CLI straight from `src/`, and
`npm run example:dev` builds the one thing the demo needs (`opengso-prod`) before starting it.
`opengso start` serves the dashboard straight from `packages/opengso/web`, so a change there shows
on the next reload.

`npm run typecheck` checks two projects: the Node code, and the dashboard against the browser's
types. The root `tsconfig.json` does not cover the dashboard, which is why the script names both.
Dashboard modules import only from inside `web/`, because nothing bundles them: a test fails on
an import that reaches into core.

`check:bundles` reads what the build produced and asserts the structural promises from §3. The
runtime library (`opengso-prod`, and the copy `opengso` ships as `opengso/prod`) carries no jsdom,
no AI provider code and no network call. The edge entries import no `node:` module. Every bundle,
CLIs included, imports only Node builtins and dependencies its package declares, and jsdom is the
only dependency any package may declare. No declaration file in `dist/` names `@opengso/core`: when
rollup-plugin-dts loses the `paths` map, typecheck and build stay green and `index.d.ts` becomes a
re-export of a package nobody can install. It follows the import graph through the metafile each
build writes to `packages/*/.bundle-meta/`, and scans the `dist/` text too. Run it after `build`,
never instead of it.

`check:packages` checks what a user installs: every package's bin answers `--version`, every entry
in its `exports` imports by name and also resolves for a resolver that does not ask for `import`
(which is what each subpath's `default` condition is for; there is no CommonJS build), and `npm pack --dry-run` lists every file the manifest points at
(and the dashboard, for `opengso`) and nothing from `src/` or `tests/`. CI also builds the
Next.js example, which is the integration test for `opengso-prod/next`.

Two more checks run in CI and take a second each locally. `npm run check:links` follows every link
in every tracked Markdown file, including the ones into this repository on GitHub and the ones to
the project site, and fails on one that lands on no file or no heading. `npm run check:actions`
fails on a workflow step that uses an action by tag rather than by commit. Both use Node builtins
only, so neither needs `npm install` first.

`npm install` also points git at `.githooks/`, so every commit first runs `typecheck`, the link
check and the website test (the twins in `website/` must match its pages). It takes a few seconds.
`git commit --no-verify` skips it once, and `git config --unset core.hooksPath` switches it off.

To exercise the whole thing against a real site, put the CLI on your PATH first. This builds
everything, packs `opengso`, and installs that tarball globally, so you are driving the same
artifact a user installs from npm rather than a symlink into the workspace:

```bash
npm run install:global        # rebuild and reinstall; :fast skips the build
opengso --version
```

```bash
npm run example:dev                                   # terminal A, serves localhost:3000
cd examples/nextjs-demo                               # terminal B
opengso generate http://localhost:3000
opengso test http://localhost:3000/resume
opengso prod test http://localhost:3000
opengso start -p 4321                                 # the dashboard
```

The global copy is a snapshot, so re-run `install:global` after changing anything the CLI or the
dashboard ships. `npm uninstall -g opengso` removes it.

## Tests

Vitest, weighted heavily toward `packages/core`, because a bug there hits all five packages at
once. `packages/core/tests/docs.test.js` asserts that every factual table in `docs/` still matches
the code, so a check whose weight changes fails the docs test until the doc is updated too.

Tests import core two ways and both are wanted. Relative imports (`../src/...`) reach internals that
no published package exposes. Entry-point imports (`@opengso/core/shared`, `@opengso/core/generate`,
and so on) go through the `exports` map, so a map that breaks fails the suite here instead of failing
consumers after a release.

## Changesets, and one place they cannot help

Every user-visible change needs a changeset:

```bash
npm run changeset
```

**Known limitation, and how the config absorbs it.** §4 assumes Changesets can work out which
published packages a change to core affects. It cannot: core is private and bundled at build time,
so from Changesets' point of view no published package depends on it. A change to `packages/core`
therefore looks like a change to nothing.

So the five published packages are one `fixed` group in `.changeset/config.json`: they always share
a version, and **any changeset that names any one of them bumps all five.** When you change core,
the changeset still has to name a package, or nothing is released at all, but which one does not
matter. Name the one your change is about, so the changelog entry lands where a reader would look
for it. A release of a package whose bundled code did not change costs nothing, and a published
package silently left on old bundled code is a real bug that is hard to spot.

## Releases

Releasing is a maintainer's job, and it is one button. The Release workflow
(`.github/workflows/release.yml`) runs only when started by hand from the Actions tab. With
changesets pending it opens the "Version Packages" pull request and publishes nothing. With none
pending it runs the whole gate again and publishes every package whose version is not already on
npm, after `scripts/check-release-versions.mjs` has refused any package still at a placeholder
version. The `release` environment is the approval gate: the job names it, so it waits for one of
the environment's reviewers before anything is published.

Every publish carries npm provenance (`NPM_CONFIG_PROVENANCE` in the workflow), so the package page
on npm links each tarball to the commit and the workflow run that built it. That only works from a
public repository, and the workflow is set to fail rather than publish without it.

The workflow reads one secret, `NPM_TOKEN`, and only until trusted publishing is set up for each
package on npm. After that, npm trusts this workflow in this repository and the token can be deleted;
nothing else in the repository needs a secret at all. Checks, CodeQL and the website deploy run with
the token GitHub gives every job.

To version by hand instead, run `npx changeset version`, then bump the five workspace entries in
`package-lock.json` to match and the "Today all five are" line in
[docs/versioning.md](docs/versioning.md), which a test pins to the package versions.

`vite` is a root devDependency on purpose, although nothing imports it. vitest only declares it as
a peer, and npm 11.5 drops the optional platform binaries of a peer-only package on every
`npm install` that finds a lockfile: a fresh clone could not start vitest ("Cannot find native
binding"), and the same install stripped the other platforms' `@rolldown/binding-*` and
`lightningcss-*` entries out of `package-lock.json`, which is what used to fail the macOS and
Windows jobs. Keep it, and before committing a changed lockfile check that it still lists a
`@rolldown/binding-*` entry for every platform, not just yours.

## The bot list

`packages/core/src/shared/bots.js` is the community-contribution surface (§17). Adding a
bot means one entry in `AI_BOTS`: its `name`, `vendor`, `uaPatterns`, `robotsToken`, `kind`, and
`notes` when the bot needs explaining. Nothing else has to change. `ROUTABLE_BOTS` and
`DEFAULT_MARKDOWN_ROUTING` are derived from that array.

Two things about it are deliberate and should not be changed casually:

- The derived list a new bot joins is the routing one, which decides *which format* it gets. There is
  no default block list to join. OpenGSO blocks nobody by default, and unknown bots are never blocked
  at all (§7, §16).
- A bot that only exists as a robots.txt opt-out token, such as `Google-Extended`, has an empty
  `uaPatterns` array. It cannot be routed, because it never appears in a User-Agent.

`AI_BOTS` is for crawlers every OpenGSO user should know about. A crawler only one site cares about,
such as an in-house agent, belongs in that project's `bots.custom` instead: `opengso settings` and
the dashboard's Bot settings tab both write it, and `resolveBots(config.bots.custom)` merges the two
lists wherever a catalogue is needed. Do not send a pull request adding a private agent to
`AI_BOTS`.

## The README recording

`docs/images/demo.svg` is rendered by `scripts/render-recording.mjs` from the three captures in
`docs/images/recording/`, and nothing in it is typed by hand. To re-record it after a change to the
report or to generate's output, run the demo (`npm run example:start`) with its generated files
moved aside, capture the real commands with colour on, restart the demo so the middleware sees the
new twins, capture the last run, and render:

```bash
cd examples/nextjs-demo
FORCE_COLOR=3 opengso test http://localhost:3000/resume > ../../docs/images/recording/01-before.ansi
FORCE_COLOR=3 opengso generate http://localhost:3000 > ../../docs/images/recording/02-generate.ansi
# restart the demo, then
FORCE_COLOR=3 opengso test http://localhost:3000/resume > ../../docs/images/recording/03-after.ansi
cd ../..
node scripts/render-recording.mjs docs/images/recording docs/images/demo.svg
```

The renderer has no dependencies and keeps the terminal's own colours, so the SVG stays a faithful
copy of what the CLI printed. The plain-text blocks in the READMEs come from the same captures
with the escape codes stripped.

## Style

- Comments explain why, not what. A comment restating the line above it is noise.
- Every user-facing error string belongs in `packages/core/src/shared/errors.js` (§13), so the
  wording changes in one place and a limited install can name the package that would help.
- No new runtime dependencies. jsdom is the only one, and `opengso-prod` may not have even that.
- Non-goals in §16 are constraints, not suggestions. No headless browser, no per-framework
  router adapters, no CI-triggered generate, no blocking unknown bots by default.
