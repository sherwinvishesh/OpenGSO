---
"opengso-testing": patch
"opengso-generate": patch
"opengso-prod": patch
"opengso-cli": patch
"opengso": patch
---

The dashboard API's two body errors no longer carry an "Error: " prefix. A body that is not JSON answers "The request body was not valid JSON." and one past the cap "The request body is too large: the dashboard accepts up to 2 MB."
