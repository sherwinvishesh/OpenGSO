# AI providers

OpenGEO is bring-your-own-key, and most of it needs no key at all. The 0 to 100 structural test, the
whole free generate tier, and `opengeo-prod` never call a model. A key buys exactly two things:

- `opengeo generate --tier ai`, the polish pass over the extracted Markdown
- `opengeo test --content`, the review of how well those documents read to an agent

## The list

Every provider below is a row in one table, `packages/core/src/shared/providers.ts`. Adding one is a
row, not a code change, because OpenGEO dispatches on the **API shape** a provider speaks rather
than on the vendor's name. There are three shapes in the whole market and OpenGEO speaks all three.

| Provider | `--provider` | Default model | Keys |
| --- | --- | --- | --- |
| Anthropic Claude | `anthropic` | `claude-sonnet-5` | <https://console.anthropic.com/settings/keys> |
| OpenAI | `openai` | `gpt-4o-mini` | <https://platform.openai.com/api-keys> |
| Google Gemini | `gemini` | `gemini-2.5-flash` | <https://aistudio.google.com/apikey> |
| xAI Grok | `xai` | `grok-4` | <https://console.x.ai> |
| Groq | `groq` | `llama-3.3-70b-versatile` | <https://console.groq.com/keys> |
| Mistral | `mistral` | `mistral-large-latest` | <https://console.mistral.ai/api-keys> |
| DeepSeek | `deepseek` | `deepseek-chat` | <https://platform.deepseek.com/api_keys> |
| OpenRouter | `openrouter` | `anthropic/claude-sonnet-4.5` | <https://openrouter.ai/keys> |
| Together AI | `together` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | <https://api.together.ai/settings/api-keys> |
| Perplexity | `perplexity` | `sonar` | <https://www.perplexity.ai/settings/api> |
| Ollama, on this machine | `ollama` | `llama3.2` | no key |
| Your own endpoint | `custom` | you name it | your own |

`opengeo help providers` prints the same table from the code, so it is never out of date.

## Picking one

Three places, all equivalent:

```bash
opengeo settings                       # interactive, writes .env and .gitignore for you
opengeo test <url> --provider groq     # one run, overriding whatever is configured
opengeo start                          # the dashboard, under Settings
```

The key is written to `.env` in your project, after `.env` is added to `.gitignore`, and never
anywhere else. It is never written to `opengeo.config.json`, never returned by the local API, and
never attached to any request except the direct call to the provider you picked. OpenGEO has no
telemetry.

## Keys you already have

If a provider's own variable is already exported, OpenGEO uses it and you configure nothing:

```
ANTHROPIC_API_KEY   OPENAI_API_KEY   GEMINI_API_KEY / GOOGLE_API_KEY
XAI_API_KEY / GROK_API_KEY           GROQ_API_KEY   MISTRAL_API_KEY
DEEPSEEK_API_KEY    OPENROUTER_API_KEY   TOGETHER_API_KEY   PERPLEXITY_API_KEY
```

OpenGEO's own variables win over those, and `.env` wins over the shell:

```
OPENGEO_PROVIDER=xai
OPENGEO_API_KEY=...
OPENGEO_MODEL=grok-4
OPENGEO_BASE_URL=https://gateway.example.com/v1    # optional
```

## A model on your own machine

Ollama needs no key and no network:

```bash
ollama serve                    # in another terminal
ollama pull llama3.2
opengeo test https://example.com --content --provider ollama
```

Nothing leaves the machine. `opengeo settings` will not ask you for a key when you pick it.

## Add your own AI tool

Anything that speaks the OpenAI, Anthropic or Gemini request format works, including a company
gateway, a proxy, vLLM, LM Studio, llama.cpp's server, or a vendor OpenGEO has never heard of.

**1. Pick the shape it speaks.** Almost everything is `openai`, which means it has a
`POST /chat/completions`. Anthropic's own API is `anthropic` (`POST /messages`) and Google's is
`gemini` (`POST /models/<model>:generateContent`).

**2. Put the address in `opengeo.config.json`.** It is not a secret, so it belongs in the file your
team shares:

```json
{
  "ai": {
    "provider": "custom",
    "model": "llama-3.3-70b",
    "baseUrl": "https://gateway.example.com/v1",
    "api": "openai",
    "auth": "bearer",
    "headers": { "X-Org": "platform-team" }
  }
}
```

| Field | Meaning | Default |
| --- | --- | --- |
| `baseUrl` | Everything up to the endpoint path, no trailing slash | required for `custom` |
| `api` | `openai`, `anthropic` or `gemini` | `openai` |
| `auth` | `bearer`, `x-api-key`, `x-goog-api-key` or `none` | `bearer` |
| `headers` | Extra headers on every call | none |
| `model` | The model id your endpoint expects | required for `custom` |

**3. Put the key in `.env`.**

```
OPENGEO_PROVIDER=custom
OPENGEO_API_KEY=...
```

Set `"auth": "none"` and skip the key entirely if the endpoint does not authenticate.

Then use it like any other provider:

```bash
opengeo test https://example.com --content
opengeo generate https://example.com --tier ai
```

`opengeo settings` walks through the same three answers interactively, and the dashboard has the
same fields under Settings.

### Overriding a built-in

The four fields work for **any** provider, not just `custom`. The usual reason is a gateway that
mirrors a vendor's API at a different host:

```json
{ "ai": { "provider": "anthropic", "model": "claude-sonnet-5", "baseUrl": "https://gateway.example.com/anthropic" } }
```

Changing `provider` clears `baseUrl`, `api`, `auth` and `headers` unless the same edit restates
them, so a new key can never inherit the previous provider's endpoint.

### If it does not work

`opengeo` names the missing field rather than failing at the HTTP layer:

```
Provider "custom" is not fully configured. Missing: ai.baseUrl, ai.model
```

A 404 from your gateway almost always means the wrong `api` shape. A 401 means `auth` is wrong for
that endpoint. Both are one field in `opengeo.config.json`.
