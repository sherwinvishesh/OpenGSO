---
"opengso": patch
"opengso-cli": patch
"opengso-testing": patch
"opengso-generate": patch
"opengso-prod": patch
---

AI/ML API is a built-in provider. `--provider aimlapi` (or `opengso settings`, or the dashboard) sends requests to the OpenAI-compatible endpoint at https://api.aimlapi.com/v1 with a bearer key, and an `AIMLAPI_API_KEY` or `AIML_API_KEY` already exported is picked up as it is. The default model is `google/gemini-3.5-flash-lite`; any model id from https://api.aimlapi.com/v1/models works. The row comes after Novita, so a project with any other key or provider configured runs exactly as before.
