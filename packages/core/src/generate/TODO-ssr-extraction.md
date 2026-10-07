# TODO: SSR HTML extraction for non-MDX SSR frameworks

Status: **not built.** This is step 5 of §18, deliberately left for a later pass.

## What works today

`extract.js` is already framework-agnostic in the sense that matters: it reads the raw HTML
response, so any page whose content is server-rendered comes out as usable Markdown without a
per-framework adapter. That is enough for step 1 of §18 (MDX and file-based-routing frameworks,
Next.js and Astro), which is what `examples/nextjs-demo` exercises end to end.

The parts that are genuinely done:

- main-region selection (`main` -> `article` -> `[role=main]` -> `#content` -> `body`), with the
  `body` fallback stripping nav/header/footer chrome and warning that it had to,
- an "essentially empty landmark" guard, so an unhydrated `<main></main>` shell does not win over
  the real content elsewhere on the page,
- comment nodes dropped by construction, since the walker only handles element and text nodes,
  which is why Vue SSR fragment markers (`<!--[-->`) and React Suspense markers (`<!--$-->`) do
  not leak into the twin,
- a word-count floor that warns instead of silently writing a near-empty `.md`.

## What is actually missing

Server-rendered output from non-MDX frameworks is *present* in the HTML but *shaped* differently,
and the extractor does nothing about the shape:

1. **Hydration payloads.** Nuxt writes `window.__NUXT__`, Next writes `self.__next_f.push(...)`,
   SvelteKit writes `__sveltekit_*`, Remix writes `window.__remixContext`. These live in `<script>`
   tags, so `ALWAYS_STRIP` already removes them from the twin. What we do *not* do is read them.
   For a page whose visible HTML is thin but whose payload carries the full record, the payload is
   the better source. Reading it would need a per-framework parser, which is close to the
   per-router-adapter line §16 forbids, so it needs a design decision before any code.

2. **No semantic landmarks.** Vue and Svelte SSR output frequently has no `<main>` at all, just
   nested wrapper divs (`#__nuxt > #__layout > div > div`). Today that falls through to the `body`
   branch, which works but is coarse: it strips nav/header/footer and keeps everything else, so
   cookie bars, skip links and sidebars survive into the twin. A density heuristic (pick the
   subtree with the highest text-to-tag ratio) would beat the current fallback, and unlike the
   payload readers it stays framework-agnostic.

3. **Scoped-style attribute noise.** `data-v-*`, `class="svelte-1x2y3z"` and similar are ignored
   correctly today, but they are also the strongest available signal for "this is framework
   scaffolding, not content", and the density heuristic above could use them.

4. **Streaming and out-of-order chunks.** A framework that streams the shell first and flushes the
   real content later can return a first byte whose body is incomplete. `fetch` here reads the
   whole response, so this mostly resolves itself, but it has not been tested against a real
   streaming SSR deployment and should not be claimed to work.

## Why it is not built

Steps 1 through 4 and 6 of §18 deliver a complete, honest product for the frameworks the free tier
is near-perfect on. Guessing at Nuxt and plain-SSR shapes without a real app of each to test
against would produce untested code that reads like support. The A5 check
(`Real content is in the raw HTML, not only after JS runs`) already tells a user of an unsupported
framework the truth about their page, and the low-content warning fires at generate time, so
nothing here fails silently.

## What "done" would look like

- One example app per target framework in `examples/`, in the shape of `examples/nextjs-demo`,
  each with a page carrying specific facts the fidelity verifier can check.
- The density heuristic in `pickContentRoot`, with tests over captured SSR fixtures rather than
  live sites.
- An explicit, recorded decision on whether reading hydration payloads crosses the
  §16 no-adapters line. If it does, this item ends at the heuristic and goes no further.
