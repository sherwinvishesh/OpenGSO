---
"opengso-generate": patch
"opengso-cli": patch
"opengso": patch
---

A static site's folder pages now resolve their relative links from inside the folder. On a GitHub Pages project site, `docs/index.html` is served at `/repo/docs/`, so its `../privacy/` is `/repo/privacy/`; generate read the page as `/repo/docs` and wrote the link as `/privacy/`, outside the site. The twin's source hash now matches the page as served, and the files phase of the progress line no longer names a robots.txt that a site in a folder never gets.
