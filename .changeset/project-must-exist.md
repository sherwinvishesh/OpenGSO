---
"opengso-testing": patch
"opengso-generate": patch
"opengso-prod": patch
"opengso-cli": patch
"opengso": patch
---

`--project` must name an existing folder. A path that did not exist was accepted by every command: `test` and `prod test` read a config from nowhere, `generate` and `settings` created the folder, and a path to a file crashed `generate` with an ENOTDIR stack. Each now exits 2 with "--project X does not exist" or "--project X is a file, not a folder" before anything is read or written.
