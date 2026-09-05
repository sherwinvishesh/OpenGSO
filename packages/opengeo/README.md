# opengeo

The whole toolkit: `test`, `generate`, `prod test`, `setup`, and the local dashboard.

This is the package to install if you want everything, including the GUI. If you only want the
terminal, install
[`opengeo-cli`](https://github.com/sherwinvishesh/OpenGEO/blob/main/packages/cli/README.md);
if you only want one pillar, install just that one.

Part of [OpenGEO](https://github.com/sherwinvishesh/OpenGEO).

## Install

```bash
npm install --save-dev opengeo
```

Or run it without installing:

```bash
npx opengeo start
```

## The dashboard

```bash
opengeo start
```

Serves a local dashboard on `http://127.0.0.1:4321` and opens it. Options:

| Flag | Meaning |
| --- | --- |
| `-p, --port <n>` | Port to listen on. Default `4321`. |
| `--host <addr>` | Interface to bind. Default `127.0.0.1`. |
| `--project <dir>` | Project root. Default the current directory. |
| `--no-open` | Do not launch a browser. |

Five screens, all driving the same core functions the CLI calls:

- **Test** runs the 22 checks against a live URL and shows the score with every reason attached.
- **Generate** crawls the site, writes the twins and the three root files, and can show you the
  exact bytes an agent would receive, read back off disk.
- **Prod** probes a running deployment and reports the two bot levers separately.
- **Bot settings** edits those two levers, and refuses to pretend they are the same thing.
- **Settings** edits `opengeo.config.json` and stores an API key.

On a project with no `opengeo.config.json`, the first screen is a three-step setup: site, optional
key, bot routing.

### It binds to 127.0.0.1

The dashboard can write an API key to disk, so it listens on the loopback interface only and refuses
any request that arrives with a cross-origin `Origin` header. Both are deliberate: any page on the
internet can POST to a port on your machine, and the refusal has to happen before the body is
parsed, not after.

`--host 0.0.0.0` exists for the container case. Only reach for it if you understand that it exposes
a key-writing API to your network.

### It is a wrapper, not a second implementation

Every endpoint calls the same function the CLI calls. There is no separate pipeline behind the GUI,
which is why the two can never disagree about a score, a header or a file.

## The CLI

Identical to `opengeo-cli`:

```bash
opengeo setup                                  # site, bot routing, optional API key
opengeo test http://localhost:3000/resume      # score it as it is today
opengeo generate http://localhost:3000         # write the twins and the three root files
opengeo prod test http://localhost:3000/resume # prove the deployment serves them correctly
opengeo start                                  # the same thing with a UI
```

See the
[CLI README](https://github.com/sherwinvishesh/OpenGEO/blob/main/packages/cli/README.md)
for the full flag list and the config file format.

## The middleware

`opengeo` also exports the runtime, so a project that installs this one package needs nothing else:

```ts
// middleware.ts
export { middleware, config } from 'opengeo/prod/next';
```

See
[opengeo-prod](https://github.com/sherwinvishesh/OpenGEO/blob/main/packages/prod/README.md)
for the framework-agnostic handler and the header contract.

## Where your API key lives

`.env` in your project, under `OPENGEO_API_KEY`, and nowhere else.

The dashboard adds `.env` to `.gitignore` **before** it writes the key, every time. The key is never
written to `opengeo.config.json`, never included in an API response (`/api/state` reports only that
a key exists, which provider it belongs to and which file it came from), and never sent anywhere
except the direct call to the AI provider you chose. There is no telemetry, no analytics and no
cloud sync in this package, so there is nothing else that could transmit it.

Most of OpenGEO needs no key at all: the whole 0 to 100 structural test, the entire free generate
tier, and all of the middleware.

## What it ships

`jsdom` is the only runtime dependency. React and Vite build the dashboard into static files at
publish time and are never installed into your `node_modules`.

## Reference

- [The check catalogue](https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/checks.md)
- [The wire spec](https://github.com/sherwinvishesh/OpenGEO/blob/main/docs/spec.md)
