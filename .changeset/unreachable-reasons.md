---
"opengso-testing": patch
"opengso-generate": patch
"opengso-prod": patch
"opengso-cli": patch
"opengso": patch
---

A site that cannot be fetched is now described by what went wrong. Undici reports a refused port, a redirect loop, a server that hangs up, a name that does not resolve and a rejected certificate all as "fetch failed", and every report said "nothing is listening on port N" for all of them. `probe` now keeps the cause, and the generate crawl, the setup preview, A5, B1, B13 and the prod probes each say "it redirects in a loop", "it closed the connection before answering", "the name X does not resolve", "its HTTPS certificate has expired" or "nothing is listening on port N", as the case is. A5 no longer says "HTTP unreachable" and B13 no longer says "returned HTTP nothing".
