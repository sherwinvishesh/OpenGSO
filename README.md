# Open Generative Engine Optimization (OpenGEO)

An open-source, framework-agnostic npm toolkit that makes any website readable by AI agents.

AI agents like ChatGPT, Claude, Gemini, and Perplexity strongly prefer clean markdown over full HTML/CSS/JS. It's cheaper to read, and many agents don't execute JavaScript at all, so client-rendered content is often invisible to them. OpenGEO fixes that across three pillars in one toolchain:

- **Test**: score a live site's AI-readiness from 0 to 100, and generate a ready-to-paste fix prompt for coding agents.
- **Generate**: produce a clean `.md` twin of every page, plus `robots.txt`, `llms.txt`, and `sitemap.xml`.
- **Prod**: serve the right format at runtime by detecting whether the visitor is a human or an AI agent.

Unlike existing tools, which each solve one piece and are usually locked to a single framework or CMS, OpenGEO works across the whole JS ecosystem, including React, Vue, Svelte, Remix, Vite, and vanilla JS.

## License

Licensed under the [Apache License 2.0](LICENSE).
