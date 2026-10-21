---
"opengso-testing": patch
"opengso-generate": patch
"opengso-prod": patch
"opengso-cli": patch
"opengso": patch
---

`createEdgeMiddleware` throws a clear error where it is built when `data` is not the module `opengso prod data` writes: undefined from a named import of the default export, the module namespace, or an object with no manifest, pages table or contents. The message names the import that fixes it, in place of "Cannot read properties of undefined (reading 'manifest')". A page in hand-built data without a route and a file, or whose content is not a string, is reported and skipped rather than crashing the store.
