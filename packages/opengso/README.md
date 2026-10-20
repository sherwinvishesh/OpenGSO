# opengso

> **Early release.** Until 1.0, a minor release may change a command, a flag, a config field or an export.

The whole toolkit: `test`, `generate`, `prod test`, `prod data`, `settings`, and the local dashboard.

This is the package to install if you want everything, including the GUI. If you only want the
terminal, install
[`opengso-cli`](https://github.com/sherwinvishesh/OpenGSO/blob/main/packages/cli/README.md);
if you only want one pillar, install just that one.

Part of [OpenGSO](https://github.com/sherwinvishesh/OpenGSO).

## Install

Needs Node.js 22 or later.

```bash
npm install --save-dev opengso
```

Or run it without installing:

```bash
npx opengso start
```

## The dashboard

```bash
opengso start
```

One command for the whole first five minutes. In a directory with no `opengso.config.json` it asks
four questions in the terminal first, then opens the dashboard. In a directory that already has one
it goes straight to the dashboard, because a configured project should not have to re-answer its own
settings every morning.

Serves the dashboard on `http://127.0.0.1:4321` and opens it. Options:

| Flag | Meaning |
| --- | --- |
| `-p, --port <n>` | Port to listen on. Default `4321`. |
| `--host <addr>` | Interface to bind. Default `127.0.0.1`. Anything else requires a launch token, below. |
| `--project <dir>` | Project root. Default the current directory. |
| `--no-open` | Do not launch a browser. |
| `--setup` | Ask the four questions even though the project is already configured. On a configured project they arrive as settings, with your current values as the defaults. |
| `--no-setup` | Never ask. For scripts, and for a fresh checkout where a prompt would hang. |
| `-y, --yes` | Accept every default without prompting, and write no key. |

Five screens, all driving the same core functions the CLI calls:

- **Test** runs the 22 checks against a live URL and shows the score with every reason attached,
  then optionally has a model read the markdown your site serves. Three buttons: everything, the
  structural checks alone, or the content review alone. The review renders in its own cards, below
  the score and never mixed into it. A **Fix it with Claude Code** card copies a ready-to-paste fix
  prompt, every group and failing check has its own copy button, and `c` copies the lot.
- **Generate** crawls the site, writes the twins and the three root files, and can show you the
  exact bytes an agent would receive, read back off disk.
- **Prod** probes a running deployment and reports the two bot levers separately.
- **Bot settings** edits those two levers, refuses to pretend they are the same thing, and is where
  you add a crawler OpenGSO has never heard of.
- **Settings** edits `opengso.config.json` and stores an API key, for any of the twenty-five providers
  in the catalogue or an endpoint you name yourself.

On a project with no `opengso.config.json`, the first screen is a three-step setup: site and web
root, optional key, bot routing.

### It binds to 127.0.0.1

The dashboard can write an API key to disk, so it listens on the loopback interface only and refuses
any request that arrives with a cross-origin `Origin` header. Both are deliberate: any page on the
internet can POST to a port on your machine, and the refusal has to happen before the body is
parsed, not after.

`--host 0.0.0.0` exists for the container case. Any address other than loopback makes the dashboard
reachable from your network, so it then requires a token, new on every launch. The URL `opengso
start` prints carries it as `?token=`; opening that URL swaps it for a cookie and drops it from the
address bar. Without the token every request, page or API, gets a 401. Scripts can send it as
`Authorization: Bearer <token>`.

The traffic is still plain HTTP, so anyone who can watch it can read the token and any API key you
save through the dashboard. Only do this on a network you trust.

### It is a wrapper, not a second implementation

Every endpoint calls the same function the CLI calls. There is no separate pipeline behind the GUI,
which is why the two can never disagree about a score, a header or a file.

## The CLI

Identical to `opengso-cli`:

```bash
opengso settings                               # site, bot routing, optional API key
opengso test http://localhost:3000/resume      # score it as it is today
opengso generate http://localhost:3000         # write the twins and the three root files
opengso prod test http://localhost:3000/resume # prove the deployment serves them correctly
opengso start                                  # the same questions, then the UI
```

See the
[CLI README](https://github.com/sherwinvishesh/OpenGSO/blob/main/packages/cli/README.md)
for the full flag list and the config file format.

## The middleware

`opengso` also exports the runtime, so a project that installs this one package needs nothing else.
Each entry is the same code as the matching `opengso-prod` one:

| Import | Same as | What it is |
| --- | --- | --- |
| `opengso/prod` | `opengso-prod` | the handler, the stores, and the startup log |
| `opengso/prod/next` | `opengso-prod/next` | the Next.js adapter, for `proxy.ts` (or Node `middleware.ts` on Next 15) |
| `opengso/prod/node` | `opengso-prod/node` | `(req, res, next)` middleware: Express, Connect, Polka, Fastify, Koa, Nest, Nuxt and h3 |
| `opengso/prod/fetch` | `opengso-prod/fetch` | `(request, next)` middleware: Hono, SvelteKit, Astro, React Router, Bun, Deno |
| `opengso/prod/vite` | `opengso-prod/vite` | the Vite plugin, for `vite` and `vite preview` |
| `opengso/prod/edge` | `opengso-prod/edge` | the edge middleware, fed by `opengso prod data` instead of the disk |

```ts
// proxy.ts (Next 16)
import { NextResponse } from 'next/server';
import { applyPassthroughHeaders, createNextMiddleware } from 'opengso/prod/next';

const opengso = createNextMiddleware({ root: process.cwd() });

export function proxy(request: Request) {
  const { response, headers } = opengso(request);
  if (response) return response;
  const next = NextResponse.next();
  applyPassthroughHeaders(next, headers);
  return next;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
```

On Next 15 the file is `middleware.ts`, the function is `middleware`, and `config` adds
`runtime: 'nodejs'`. Under `next dev` a fresh `opengso generate` is picked up within a second,
without a restart.

See
[opengso-prod](https://github.com/sherwinvishesh/OpenGSO/blob/main/packages/prod/README.md)
for every other framework, from Express to a Cloudflare Worker, and the header contract.

## Where your API key lives

`.env` in your project, under `OPENGSO_API_KEY`, and nowhere else.

The dashboard adds `.env` to `.gitignore` **before** it writes the key, every time. The key is never
written to `opengso.config.json`, never included in an API response (`/api/state` reports only that
a key exists, which provider it belongs to and which file it came from), and never sent anywhere
except the direct call to the AI provider you chose. There is no telemetry, no analytics and no
cloud sync in this package, so there is nothing else that could transmit it.

Most of OpenGSO needs no key at all: the whole 0 to 100 structural test, the entire free generate
tier, and all of the middleware.

The provider list in Settings comes from the server, not from the bundle, so it is the same
catalogue `opengso help providers` prints: Anthropic, OpenAI and Gemini, Qwen, DeepSeek, Kimi and
GLM, Groq, Cerebras and OpenRouter among them, Ollama and LM Studio on this machine, and **your own
endpoint**.
Picking the last one asks for a base URL and which of the three API shapes it speaks. See
[docs/providers.md](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/providers.md).

## What it ships

`jsdom` is the only runtime dependency. The dashboard is plain HTML, CSS and JavaScript in `web/`,
served as it is, with no framework and nothing built at publish time.

## Reference

- [The check catalogue](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/checks.md)
- [The wire spec](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/spec.md)
- [AI providers, and adding your own](https://github.com/sherwinvishesh/OpenGSO/blob/main/docs/providers.md)
