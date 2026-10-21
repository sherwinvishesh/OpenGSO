---
"opengso": patch
"opengso-cli": patch
"opengso-generate": patch
"opengso-prod": patch
"opengso-testing": patch
---

The READMEs are rebuilt around real output. The root README opens with an animated recording of `opengso test`, `opengso generate` and `opengso test` again on the bundled Next.js demo (65 to 100), rendered by `scripts/render-recording.mjs` from captured terminal output rather than drawn by hand; it adds a table of what one URL answers to each kind of request, every row run with `curl`, a table of the frameworks each `opengso-prod` entry was run on, with versions, and the bytes and tokens of the demo's three pages before and after. Each package README carries the real run for its command: the first test report in `opengso-testing`, the generate run in `opengso-generate`, the five probes in `opengso-prod`, the dashboard screens in `opengso`. The npm descriptions and keywords of all five packages are rewritten to say what each one does and what it works with.

`opengso-prod/node` is now verified on Nest 12.2 as well; SolidStart, Remix, Bun, Deno and the non-Cloudflare edge hosts are still listed by the shape they share rather than as run.
