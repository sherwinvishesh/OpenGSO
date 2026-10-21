---
"opengso": patch
"opengso-cli": patch
"opengso-generate": patch
"opengso-prod": patch
"opengso-testing": patch
---

Four corrections to `opengso generate` from running it against VitePress, SvelteKit and the other framework starters.

- `--check` now reports a page whose twin is listed in the manifest but gone from the folder (a rebuild that emptied `dist/`, a stray delete), instead of calling the page up to date because the page itself had not changed.
- An `opengso.config.json` that does not name `publicDir` now gets the folder the framework serves from the site root (`static/` for SvelteKit, `docs/public/` for VitePress), the same as a project with no config file, and the run says so. A file that names `publicDir` is left alone.
- A localhost `--origin` on a project that already has a config is no longer saved as `publicOrigin`, matching what the first run does: it names the links of that run and nothing more.
- A run from a folder no longer prints the note about where the framework serves files; the folder was given on the command line, and the Output line names it.
