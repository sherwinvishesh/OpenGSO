# AI providers

OpenGSO is bring-your-own-key, and most of it needs no key at all. The 0 to 100 structural test, the
whole free generate tier, and `opengso-prod` never call a model. A key buys exactly two things:

- `opengso generate --tier ai`, the polish pass over the extracted Markdown
- `opengso test --content`, the review of how well those documents read to an agent

## The list

Every provider below is a row in one table, `packages/core/src/shared/providers.js`. Adding one is a
row, not a code change, because OpenGSO dispatches on the **API shape** a provider speaks rather
than on the vendor's name. There are three shapes in the whole market and OpenGSO speaks all three.

| Provider | `--provider` | Default model | Keys |
| --- | --- | --- | --- |
| Anthropic Claude | `anthropic` | `claude-sonnet-5-5` | <https://console.anthropic.com/settings/keys> |
| OpenAI | `openai` | `gpt-6-luna` | <https://platform.openai.com/api-keys> |
| Google Gemini | `gemini` | `gemini-3.5-flash-lite` | <https://aistudio.google.com/apikey> |
| xAI Grok | `xai` | `grok-4.3` | <https://console.x.ai> |
| Mistral | `mistral` | `mistral-large-latest` | <https://console.mistral.ai/api-keys> |
| DeepSeek | `deepseek` | `deepseek-flash` | <https://platform.deepseek.com/api_keys> |
| Alibaba Qwen | `qwen` | `qwen-plus` | <https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key> |
| Moonshot Kimi | `kimi` | `kimi-k2.6` | <https://platform.kimi.ai/console/api-keys> |
| Z.ai GLM | `zai` | `glm-5.3-flash` | <https://z.ai/manage-apikey/apikey-list> |
| MiniMax | `minimax` | `MiniMax-M3` | <https://platform.minimax.io/user-center/basic-information/interface-key> |
| Cohere | `cohere` | `command-a-03-2025` | <https://dashboard.cohere.com/api-keys> |
| Perplexity | `perplexity` | `sonar` | <https://www.perplexity.ai/settings/api> |
| OpenRouter | `openrouter` | `anthropic/claude-sonnet-5.5` | <https://openrouter.ai/keys> |
| Groq | `groq` | `openai/gpt-oss-120b` | <https://console.groq.com/keys> |
| Together AI | `together` | `openai/gpt-oss-120b` | <https://api.together.ai/settings/api-keys> |
| Fireworks AI | `fireworks` | `accounts/fireworks/models/glm-5p3-flash` | <https://app.fireworks.ai/settings/users/api-keys> |
| Cerebras | `cerebras` | `qwen-3.8-27b` | <https://cloud.cerebras.ai> |
| SambaNova | `sambanova` | `Meta-Llama-3.3-70B-Instruct` | <https://cloud.sambanova.ai/apis> |
| DeepInfra | `deepinfra` | `deepseek-ai/DeepSeek-V4.1-Flash` | <https://deepinfra.com/dash/api_keys> |
| Hugging Face | `huggingface` | `openai/gpt-oss-120b` | <https://huggingface.co/settings/tokens> |
| NVIDIA NIM | `nvidia` | `nvidia/nemotron-3-super-120b-a12b` | <https://build.nvidia.com> |
| Novita AI | `novita` | `deepseek/deepseek-v4.1-flash` | <https://novita.ai/settings/key-management> |
| Ollama, on this machine | `ollama` | `llama3.2` | no key |
| LM Studio, on this machine | `lmstudio` | `openai/gpt-oss-20b` | no key |
| Your own endpoint | `custom` | you name it | your own |

`opengso help providers` prints the same table from the code, so it is never out of date.

Each default is a fast, inexpensive model from that vendor, because rewriting a page is
summarising work and a site can have hundreds of them. Any model the provider serves works: set
`ai.model`, pass `--model`, or answer the model question in `opengso settings`.

Names people actually type are understood as suggestions. `--provider claude`, `kwen` or `grok`
stops and asks `Did you mean "anthropic"?` (or `qwen`, or `xai`) rather than guessing, so one config
file can never mean two different things.

## Which one should I pick

- **You already pay for one.** Use it. Every provider here can do the job, and the key you already
  have is the one with the least setup.
- **You want the best rewrite.** `anthropic`, `openai` or `gemini` on their defaults.
- **You want it cheap and fast on a big site.** `groq`, `cerebras`, `deepseek` or `qwen`.
- **Nothing may leave the machine.** `ollama` or `lmstudio`. No key, no account, no network.
- **Your company routes everything through one gateway.** `custom`, or a built-in with `baseUrl`
  pointed at the gateway (see below).
- **You want to try many models with one key.** `openrouter`, `together`, `huggingface` or
  `deepinfra`.

## Picking one

Three places, all equivalent:

```bash
opengso settings                       # interactive, writes .env and .gitignore for you
opengso test <url> --provider groq     # one run, overriding whatever is configured
opengso start                          # the dashboard, under Settings
```

The key is written to `.env` in your project, after `.env` is added to `.gitignore`, and never
anywhere else. It is never written to `opengso.config.json`, never returned by the local API, and
never attached to any request except the direct call to the provider you picked. OpenGSO has no
telemetry.

## Keys you already have

If a provider's own variable is already exported, OpenGSO uses it and you configure nothing:

```
ANTHROPIC_API_KEY      OPENAI_API_KEY       GEMINI_API_KEY / GOOGLE_API_KEY
XAI_API_KEY / GROK_API_KEY                  MISTRAL_API_KEY      DEEPSEEK_API_KEY
DASHSCOPE_API_KEY      MOONSHOT_API_KEY     ZAI_API_KEY / ZHIPUAI_API_KEY
MINIMAX_API_KEY        CO_API_KEY / COHERE_API_KEY               PERPLEXITY_API_KEY / PPLX_API_KEY
OPENROUTER_API_KEY     GROQ_API_KEY         TOGETHER_API_KEY     FIREWORKS_API_KEY
CEREBRAS_API_KEY       SAMBANOVA_API_KEY    DEEPINFRA_API_KEY / DEEPINFRA_TOKEN
HF_TOKEN               NVIDIA_API_KEY       NOVITA_API_KEY
```

When several are set, the provider in `opengso.config.json` is asked first, so an
`OPENAI_API_KEY` exported for some other tool never outranks the Qwen key a project was set up
with. Only when that provider has no key does another one stand in, in the order of the table
above. A project set up for Ollama or LM Studio stays on this machine whatever else is exported.

OpenGSO's own variables win over all of those, and `.env` wins over the shell:

```
OPENGSO_PROVIDER=xai
OPENGSO_API_KEY=...
OPENGSO_MODEL=grok-4.3
OPENGSO_BASE_URL=https://gateway.example.com/v1    # optional
```

`OPENGSO_PROVIDER` has to be one of the ids in the table. If it names something else, the key next
to it is not sent anywhere, and every AI run says what is wrong until it is fixed.

The key goes in `.env` under the name its provider documents, or under `OPENGSO_API_KEY`. If the
line is there under a name of your own, like `claude_api`, OpenGSO does not guess: it names the
line and tells you what to rename it to.

A key is only ever sent to the provider that issued it. `--provider groq` uses `GROQ_API_KEY`, or
`OPENGSO_API_KEY` when `OPENGSO_PROVIDER` is `groq`. If the only key available belongs to another
provider, the run stops and says so rather than sending it. The same goes for the rest of the
address: a model, `baseUrl`, `api`, `auth`, `headers` or `params` set for one provider is not
carried over when a flag picks another.

## A model on your own machine

Ollama and LM Studio need no key and no network. Nothing leaves the machine, and `opengso settings`
will not ask you for a key when you pick either one.

### Ollama

```bash
OLLAMA_CONTEXT_LENGTH=32768 ollama serve    # in another terminal
ollama pull llama3.2
opengso test https://example.com --content --provider ollama
```

Start the server with a larger context than its default. A long page is otherwise cut short before
the model sees it, and the rewrite quietly loses its second half.

### LM Studio

Open the Developer tab, switch the server on, and load a model. Use the id LM Studio shows for it:

```bash
opengso generate https://example.com --tier ai --provider lmstudio --model openai/gpt-oss-20b
```

It listens on `http://localhost:1234/v1`. If you moved it, set `ai.baseUrl`.

## Notes on particular providers

**Alibaba Qwen.** Keys are tied to a region. The default address is the international one
(Singapore). A key from the China console needs
`"baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1"` in `opengso.config.json`.

**Perplexity.** Sonar is built for search. OpenGSO switches search off for the default model, so it
rewrites the page it was given rather than one it found, but a general model is the better fit.

**Hugging Face.** The token needs the "Make calls to Inference Providers" permission, and a token
without it is refused.

**OpenRouter.** One key, hundreds of models. The model id carries the vendor prefix, for example
`qwen/qwen-plus` or `anthropic/claude-haiku-5.5`.

**Azure OpenAI.** Use `custom` with the resource's v1 address:

```json
{
  "ai": {
    "provider": "custom",
    "model": "my-deployment-name",
    "baseUrl": "https://my-resource.openai.azure.com/openai/v1",
    "api": "openai",
    "auth": "bearer"
  }
}
```

## Thinking, and other request flags

A rewrite is not a reasoning problem, and a model that thinks first is slower and costs more for
the same page. So for its own default models OpenGSO sends the flag each vendor uses to keep
thinking short or off (`reasoning_effort`, `thinking`, `enable_thinking` and so on). A model you
choose yourself is sent exactly what you configure and nothing more, because the same flag can be
refused by a different model.

`ai.params` adds fields of your own to every request body, for any provider:

```json
{ "ai": { "provider": "openai", "model": "gpt-6", "params": { "reasoning_effort": "low", "temperature": 0.2 } } }
```

- Objects are merged key by key into what OpenGSO sends, so `{ "generationConfig": { "temperature":
  0.2 } }` on Gemini keeps the output limit OpenGSO sets.
- `null` removes a field, including one of the default flags: `{ "thinking": null }`.
- `model`, `messages`, `system`, `contents`, `systemInstruction` and `stream` are OpenGSO's and are
  never overwritten. A config that sets one is refused with the reason.

Some models always think, whatever they are sent (Claude Opus 5.5 is one). Thinking counts toward
the output limit, so on a long page it can leave too little room and the twin comes back cut off,
which OpenGSO catches and replaces with the algorithmic version. Turning the effort down fixes it:

```json
{ "ai": { "provider": "anthropic", "model": "claude-opus-5-5", "params": { "output_config": { "effort": "low" } } } }
```

## Add your own AI tool

Anything that speaks the OpenAI, Anthropic or Gemini request format works, including a company
gateway, a proxy, vLLM, llama.cpp's server, LiteLLM, or a vendor OpenGSO has never heard of.

**1. Pick the shape it speaks.** Almost everything is `openai`, which means it has a
`POST /chat/completions`. Anthropic's own API is `anthropic` (`POST /messages`) and Google's is
`gemini` (`POST /models/<model>:generateContent`).

**2. Put the address in `opengso.config.json`.** It is not a secret, so it belongs in the file your
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
| `params` | Extra fields in every request body, as above | none |
| `model` | The model id your endpoint expects | required for `custom` |

**3. Put the key in `.env`.**

```
OPENGSO_PROVIDER=custom
OPENGSO_API_KEY=...
```

Set `"auth": "none"` and skip the key entirely if the endpoint does not authenticate.

Then use it like any other provider:

```bash
opengso test https://example.com --content
opengso generate https://example.com --tier ai
```

`opengso settings` walks through the same three answers interactively, and the dashboard has the
same fields under Settings.

### Overriding a built-in

The same fields work for **any** provider, not just `custom`. The usual reason is a gateway that
mirrors a vendor's API at a different host:

```json
{ "ai": { "provider": "anthropic", "model": "claude-sonnet-5-5", "baseUrl": "https://gateway.example.com/anthropic" } }
```

Changing `provider` clears `baseUrl`, `api`, `auth`, `headers` and `params` unless the same edit
restates them, so a new key can never inherit the previous provider's endpoint.

## If it does not work

`opengso` names the missing field rather than failing at the HTTP layer:

```
Provider "custom" is not fully configured. Missing: ai.baseUrl, ai.model
```

When the provider does answer with an error, the first line is its status and the second says what
that status almost always means:

| Status | Usually means |
| --- | --- |
| 400, 422 | The request was refused: a model id it does not serve, or a field in `ai.params` it does not accept |
| 401, 403 | The key was refused: a key for another provider, a revoked one, or an account with no credit |
| 402 | The account is out of credit |
| 404 | The model id, or `baseUrl` and `api` do not match what the endpoint serves |
| 429 | Rate limited, or out of quota for now. Waiting a minute usually works |
| 5xx | The provider's own problem. Try again later |

A 404 from your own gateway almost always means the wrong `api` shape. A 401 means `auth` is wrong
for that endpoint. Both are one field in `opengso.config.json`.

When a model declines to rewrite a page under its own safety rules, OpenGSO says so and keeps the
algorithmic version of that page. The key is fine, and nothing else in the run is affected.
