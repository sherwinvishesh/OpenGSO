---
"opengso-generate": patch
"opengso-cli": patch
"opengso": patch
---

`opengso generate --force` now removes the `.opengso-proposed` file an earlier run left beside a file it would not overwrite. The proposal was for the file that has just been written, so keeping it only left a stale duplicate for the dashboard to preview.
