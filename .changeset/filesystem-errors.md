---
"opengso-testing": patch
"opengso-generate": patch
"opengso-prod": patch
"opengso-cli": patch
"opengso": patch
---

A filesystem failure is reported as a sentence that names the folder in the way. `opengso generate` said "EEXIST: file already exists, mkdir '/abs/path/public/md'" when `public/md` was a file, and "EACCES: permission denied, open '/abs/path/public/.robots.txt.123.tmp'" named the staging file of an atomic write rather than `public/robots.txt`. It now says "public/md is a file, not a folder, so nothing can be written under it" and "no permission to write public/robots.txt", with paths relative to the project. The reset escape that `truncate` appended when a long path was wrapped is only emitted when a colour was open, so it no longer leaks into piped output.
