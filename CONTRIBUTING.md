# Contributing to OpenGEO

## Layout

```
packages/core        @opengeo/core, private, never published. Every pillar lives here.
packages/testing     opengeo-testing    test
packages/generate    opengeo-generate   generate
packages/prod        opengeo-prod       middleware + prod test
packages/cli         opengeo-cli        test + generate + prod test + setup
packages/opengeo     opengeo            all of the above + the dashboard
examples/nextjs-demo the app the whole pipeline is exercised against
docs/                checks.md (the 22 checks) and spec.md (the wire format)
```

**A note on `§` references.** Comments and docs across this repo cite section numbers, like
`§7` or `§16`. They point into the original product spec, which is not distributed with the repo.
You do not need it: the decisions those sections drove are all described where they are cited, and
the two documents in `docs/` cover the parts a contributor actually has to match.

`@opengeo/core` is private and its `exports` map points at source `.ts`. Each published package
bundles core with tsup (`noExternal: [/@opengeo\/core/]`), so core is never an install-time
dependency of anything. Write the code once, in core. A published package should be a thin
entry point and nothing else.

## The loop

```bash
npm install
npm run typecheck
npm test
npm run build
npm run check:bundles
```

`check:bundles` reads `dist/` and asserts the two structural promises from §3:
`opengeo-prod` ships no jsdom and no AI provider code, and jsdom is the only runtime dependency
any published package may declare. Run it after `build`, never instead of it.

To exercise the whole thing against a real site:

```bash
npm run example:dev                                   # terminal A, serves localhost:3000
node packages/cli/dist/cli.js generate http://localhost:3000
node packages/cli/dist/cli.js test http://localhost:3000/resume
node packages/cli/dist/cli.js prod test http://localhost:3000
node packages/opengeo/dist/cli.js start -p 4321       # the dashboard
```

## Tests

Vitest, weighted heavily toward `packages/core`, because a bug there hits all five packages at
once. `packages/core/tests/docs.test.ts` asserts that every factual table in `docs/` still matches
the code, so a check whose weight changes fails the docs test until the doc is updated too.

Tests import core two ways and both are wanted. Relative imports (`../src/...`) reach internals that
no published package exposes. Entry-point imports (`@opengeo/core/shared`, `@opengeo/core/generate`,
and so on) go through the `exports` map, so a map that breaks fails the suite here instead of failing
consumers after a release.

## Changesets, and one place they cannot help

Every user-visible change needs a changeset:

```bash
npm run changeset
```

**Known limitation, stated rather than worked around.** §4 assumes Changesets can work out
which published packages a change to core affects. It cannot: core is private and bundled at build
time, so from Changesets' point of view no published package depends on it. A change to
`packages/core` therefore looks like a change to nothing.

So when you change core, **name every affected package in the changeset yourself.** If you touched
`core/src/generate`, that is `opengeo-generate`, `opengeo-cli` and `opengeo`. If you touched
`core/src/shared`, it is probably all five. When in doubt, list all five: an unnecessary patch
release costs nothing, and a published package silently left on old bundled code is a real bug that
is hard to spot.

## The bot list

`packages/core/src/shared/bots.ts` is the community-contribution surface (§17). Adding a
bot means one entry in `AI_BOTS`: its `name`, `vendor`, `uaPatterns`, `robotsToken`, `kind`, and
`notes` when the bot needs explaining. Nothing else has to change. `ROUTABLE_BOTS` and
`DEFAULT_MARKDOWN_ROUTING` are derived from that array.

Two things about it are deliberate and should not be changed casually:

- The derived list a new bot joins is the routing one, which decides *which format* it gets. There is
  no default block list to join. OpenGEO blocks nobody by default, and unknown bots are never blocked
  at all (§7, §16).
- A bot that only exists as a robots.txt opt-out token, such as `Google-Extended`, has an empty
  `uaPatterns` array. It cannot be routed, because it never appears in a User-Agent.

## Style

- Comments explain why, not what. A comment restating the line above it is noise.
- Every user-facing error string belongs in `packages/core/src/shared/errors.ts` (§13), so the
  wording changes in one place and a limited install can name the package that would help.
- No new runtime dependencies. jsdom is the only one, and `opengeo-prod` may not have even that.
- Non-goals in §16 are constraints, not suggestions. No headless browser, no per-framework
  router adapters, no CI-triggered generate, no blocking unknown bots by default.
