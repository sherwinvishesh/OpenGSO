---
title: "Nothing is collected."
url: "https://sherwinvishesh.github.io/OpenGSO/privacy"
last_updated: "2026-10-21T10:48:01.598Z"
tokens: 605
source_hash: "30eab229982ee666"
generated_by: "opengso-free"
description: "What OpenGSO and this website collect: nothing. No telemetry, no analytics, no cookies. The only data that leaves your machine is what you send to the site you test and the AI provider you pick."
---

Privacy

# Nothing is collected.

Not by the tool, and not by this site. This page says what that means in practice, and names the few places where data does leave your machine because you asked it to.

Applies to OpenGSO 0.1.1 and this website · Updated October 20, 2026

OpenGSO has no telemetry, no analytics, no crash reporting and no cloud sync. It never contacts a server of its own, because there is none. This website sets no cookies, runs no analytics and loads nothing from a third party.

## The tool

Every OpenGSO command runs on your machine. The only network requests it makes are the ones its job requires, to addresses you chose:

- **opengso test** fetches the URL you give it, along with that site's robots.txt, llms.txt, sitemap.xml and markdown twin.
- **opengso generate** fetches the pages of the site you point it at, or reads its build folder and makes no request at all.
- **opengso prod test** fetches your deployed site to check what it serves.
- **The two optional AI passes**, the content review and the AI generate tier, send page content to the one provider you picked, with your key. If that provider is Ollama or LM Studio, the content stays on your machine.

Results stay where they are written: the report on your screen, the files generate writes, and the run history in `.opengso/history.json`, which is never served to the web and never read by the production middleware.

## Your API key

The key is read from `.env` and sent to exactly one place, the provider you picked. It is never logged, never written to `opengso.config.json`, never returned by the dashboard's API, and never attached to any other request. The setup flow adds `.env` to `.gitignore` before it asks for the key, so it does not end up in a commit by accident.

## The dashboard

`opengso start` serves the dashboard from your own machine on 127.0.0.1, which nothing else on the network can reach. Nothing in it is uploaded or synced.

## The production middleware

`opengso-prod` runs inside your server and answers requests from the manifest generate wrote. It makes no network call, stores nothing about the requests it sees, and has no code path that blocks a visitor.

## This website

The site is plain HTML, CSS and one small script, served by GitHub Pages. Its fonts are served from the same place as its pages. There are no cookies, no analytics, no tracking pixels and no embedded third-party content. GitHub, as the host, may keep server logs of requests, including IP addresses, under the [GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

## Questions

If something here is unclear, or you find the tool doing anything this page does not describe, please [open an issue on GitHub](https://github.com/sherwinvishesh/OpenGSO/issues).
