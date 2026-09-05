# TODO: CSR/SPA support via jsdom script execution

Status: **not built.** This is step 8 of §18, which puts it last on purpose.

## The boundary, stated exactly

`extract.ts` constructs `new JSDOM(html, { url })`. jsdom's default is `runScripts: undefined`,
which means **no script on the page ever executes**. jsdom is used here as a spec-compliant HTML
parser and nothing more. The same is true of `crawl.ts`, which discovers routes from `<a href>` in
the parsed-but-not-executed DOM, and of `test/runner.ts`.

So for a purely client-rendered page, OpenGEO today sees `<div id="root"></div>` and says so:

- `extractPage` warns `Only N words extracted (threshold M). If this page renders its content
  with JavaScript, OpenGEO cannot see it yet` and names this file,
- `pickContentRoot` refuses a landmark with under 40 characters of text, so an empty `<main>`
  shell does not mask the problem,
- the A5 check fails in `opengeo test` with the same explanation.

The tool is honest about the gap. It just does not close it.

## What closing it would mean

Switching to `runScripts: 'dangerously'` plus `resources: 'usable'`, then waiting for the app to
settle before reading the DOM. Each of those three words carries a real problem.

1. **`dangerously` is the actual name of the flag, and it is accurate.** It executes arbitrary
   remote JavaScript inside the user's Node process, with access to whatever that process can
   reach. `opengeo generate` runs on a developer's laptop against their own site, which is the
   mildest possible version of this, but it is still remote code execution by design and needs to
   be an explicit opt-in flag with the risk spelled out, never a silent upgrade.

2. **"Wait for the app to settle" has no correct definition.** There is no load event that means
   "React finished". The options are all bad in different ways: a fixed timeout (slow and still
   wrong), polling the DOM until the text stops changing (heuristic, and a page with a clock never
   settles), or a mutation-observer quiet period (the least bad, and what this should probably
   try first).

3. **jsdom has no layout engine.** This is §17's stated honesty and it is not a detail.
   Anything measuring itself renders wrong or throws: `getBoundingClientRect` returns zeroes,
   `IntersectionObserver` never fires so infinite-scroll and lazy sections never load,
   `ResizeObserver` is absent, `matchMedia` is a stub so responsive branches pick the wrong tree,
   and `scrollIntoView` is a no-op. Charting and virtualised-list libraries fail outright.
   Suspense boundaries that resolve from a fetch may or may not resolve inside jsdom's timing.

4. **Network fan-out.** `resources: 'usable'` makes generate fetch every script, stylesheet and
   image the page references, from a tool whose current promise is that it makes one request per
   page. That changes the tool's network behaviour enough to be a documented, flagged change.

## Why it is last

§18 step 8 says it plainly: this is the hardest and least differentiated case, and even Dualmark,
the closest competitor named in §14, does not appear to solve pure client-side SPA support either.
Shipping a jsdom execution path that works on simple SPAs and fails quietly on real ones would be
worse than the current behaviour, because the current behaviour tells the user the truth.

The stated gate is real signal that people want the tool at all. Until then, a CSR user gets an
accurate score, an accurate warning, and no broken twin.

## What "done" would look like

- `runScripts` behind an explicit flag (`--execute-scripts`, off by default), with the RCE note in
  the CLI help text and not only in docs.
- A settle strategy based on a mutation quiet period, with a hard ceiling, and the ceiling reported
  in the warning when it is hit.
- The fidelity verifier (`fidelity.ts`) pointed at the executed DOM as well, since a half-hydrated
  page losing facts is exactly the failure this pass must catch.
- Real-world validation against several third-party SPAs before any README claims SPA support.
  §17 asks for this by name: "Needs real-world validation, not assumed to fully solve
  every CSR page."
- Full headless-browser rendering stays a non-goal (§16). If jsdom cannot do it, the answer is to
  say so, not to bundle Chromium.
