---
"opengso-testing": patch
"opengso-generate": patch
"opengso-prod": patch
"opengso-cli": patch
"opengso": patch
---

Pages are decoded in the charset they declare. Every body was read as UTF-8, so a site served as `iso-8859-1` or `windows-1252` had each accented letter replaced by U+FFFD in its twin and in the test report. The Content-Type charset is used first, then a `<meta charset>` in the first two kilobytes, then UTF-8; a label Node does not know falls back to UTF-8.
