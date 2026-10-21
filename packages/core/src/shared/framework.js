/**
 * Framework detection (§5): the one fingerprint table, read by the test report, the fix prompt and
 * the setup preview, so they cannot name two different frameworks for the same page.
 *
 * Detection is fingerprint matching on the HTML and response headers, nothing more. It is a
 * courtesy, never a dependency: no check's result changes based on what this returns, and every
 * caller has to handle `undefined`. That is deliberate, and it is the line between "we noticed
 * you're on Next.js, so here is the Next.js snippet" and the per-framework adapters §16 rules out.
 *
 * A wrong guess would be worse than no guess, because it sends the user editing the wrong file. So
 * each signal has to be something only that framework emits, never a word a page might contain,
 * and a page matching nothing reports nothing. Pure string work, because setup reads it too.
 *
 * "A word a page might contain" includes a page *about* a framework. Documentation that shows what
 * Next.js emits carries `href="/_next/static/..."` and `self.__next_f.push` inside a `<pre>`, as
 * escaped text: the attribute and the payload survive escaping, the tags around them do not. So an
 * asset path only counts inside the src or href of a real script, link or img tag, a hydration
 * payload only counts at the start of a real inline script, and an element id only counts on a
 * real element. The project's own website is the regression test.
 */

/**
 * @typedef {'nextjs'
 *   | 'nuxt'
 *   | 'astro'
 *   | 'sveltekit'
 *   | 'remix'
 *   | 'angular'
 *   | 'qwik'
 *   | 'gatsby'
 *   | 'docusaurus'
 *   | 'vitepress'
 *   | 'hugo'
 *   | 'jekyll'
 *   | 'eleventy'
 *   | 'wordpress'
 *   | 'vite'
 *   | 'plain'} FrameworkId
 */

/**
 * @typedef {object} Framework
 * @property {FrameworkId} id
 * @property {string} name Display name, used verbatim in the report, the fix prompt and setup.
 * @property {string} evidence What gave it away, so the user can disagree with us.
 */

/**
 * @typedef {object} Signature
 * @property {FrameworkId} id
 * @property {string} name
 * @property {Array<{ pattern: RegExp; evidence: string }>} [html] Ordered: the first match wins, so more specific frameworks come before what they are built on.
 * @property {Array<{ name: string; pattern?: RegExp; evidence: string }>} [header]
 */

/**
 * An asset path, counted only in the `src` or `href` of a script, link or img tag. The path may
 * sit behind a CDN host, so anything up to the quote is allowed in front of it.
 *
 * @param {string} path Regular expression source for the path.
 * @returns {RegExp}
 */
function asset(path) {
  return new RegExp(String.raw`<(?:script|link|img)\b[^>]*\s(?:src|href)=["'][^"']*` + path);
}

/**
 * A hydration payload, counted only at the start of an inline script, where the framework writes
 * it. Whitespace, a brace and a parenthesis may come first: Next.js opens with
 * `(self.__next_f=...)`, SvelteKit with a block.
 *
 * @param {string} marker Regular expression source for the payload's first identifier.
 * @returns {RegExp}
 */
function inlineScript(marker) {
  return new RegExp(String.raw`<script\b[^>]*>[\s({]*` + marker);
}

/**
 * An element id, counted only on a real element.
 *
 * @param {string} id
 * @returns {RegExp}
 */
function elementId(id) {
  return new RegExp(String.raw`<[a-z][^>]*\sid=["']` + id + String.raw`["']`);
}

/**
 * A generator meta tag naming the tool.
 *
 * @param {string} name
 * @returns {RegExp}
 */
function generator(name) {
  return new RegExp(String.raw`<meta[^>]+name=["']generator["'][^>]+content=["']` + name, 'i');
}

/** @type {Signature[]} */
const SIGNATURES = [
  {
    // Before Next.js: a Docusaurus site is a React site and carries some of the same markers.
    id: 'docusaurus',
    name: 'Docusaurus',
    html: [
      { pattern: generator('Docusaurus'), evidence: 'the generator meta tag names Docusaurus' },
      { pattern: elementId('__docusaurus'), evidence: 'the page has a __docusaurus root element' },
    ],
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    html: [
      { pattern: asset(String.raw`\/_next\/static\/`), evidence: 'assets are served from /_next/static/' },
      { pattern: elementId('__NEXT_DATA__'), evidence: 'the page carries a __NEXT_DATA__ script' },
      { pattern: inlineScript(String.raw`self\.__next_f\b`), evidence: 'the page carries an App Router flight payload' },
    ],
    header: [{ name: 'x-powered-by', pattern: /next\.js/i, evidence: 'X-Powered-By names Next.js' }],
  },
  {
    id: 'nuxt',
    name: 'Nuxt',
    html: [
      { pattern: asset(String.raw`\/_nuxt\/`), evidence: 'assets are served from /_nuxt/' },
      { pattern: elementId('__NUXT_DATA__'), evidence: 'the page carries a Nuxt payload' },
      { pattern: inlineScript(String.raw`window\.__NUXT__`), evidence: 'the page carries a Nuxt payload' },
    ],
  },
  {
    id: 'astro',
    name: 'Astro',
    html: [
      { pattern: generator('Astro'), evidence: 'the generator meta tag names Astro' },
      { pattern: asset(String.raw`\/_astro\/`), evidence: 'assets are served from /_astro/' },
      { pattern: /<astro-island\b|<[a-z][^>]*\sdata-astro-cid-/, evidence: 'the markup carries Astro island attributes' },
    ],
  },
  {
    id: 'sveltekit',
    name: 'SvelteKit',
    html: [
      { pattern: inlineScript('__sveltekit_'), evidence: 'the page carries a SvelteKit hydration payload' },
      { pattern: asset(String.raw`\/_app\/immutable\/`), evidence: 'assets are served from /_app/immutable/' },
    ],
  },
  {
    id: 'remix',
    name: 'Remix or React Router',
    html: [
      { pattern: inlineScript(String.raw`window\.(?:__remixContext|__reactRouterContext)\b`), evidence: 'the page carries a Remix or React Router context payload' },
    ],
  },
  {
    // Before Vite, which Angular's dev server is built on. The build-output rule wants both halves,
    // an empty custom element for the app and the polyfills-then-main pair Angular's builders emit,
    // because either alone is a pattern a hand-written page could have.
    id: 'angular',
    name: 'Angular',
    html: [
      { pattern: /<[a-z][^>]*\sng-version=["']\d/, evidence: 'the app root carries an ng-version attribute' },
      { pattern: /<[a-z][^>]*\sng-server-context=|<script[^>]*\sid=["']ng-state["']/, evidence: 'the page carries Angular server-rendering state' },
      {
        pattern: /<([a-z]+-[a-z0-9-]*)(?:\s[^>]*)?><\/\1>[\s\S]*?<script src=["'][^"']*polyfills(?:[-.][A-Za-z0-9]+)?\.js["'][^>]*><\/script>\s*<script src=["'][^"']*main(?:[-.][A-Za-z0-9]+)?\.js["']/,
        evidence: 'an empty app element followed by Angular\'s polyfills and main bundles',
      },
    ],
  },
  {
    // Before Vite too: Qwik's dev server is Vite.
    id: 'qwik',
    name: 'Qwik',
    html: [{ pattern: /<html[^>]*\sq:container=/, evidence: 'the document carries a q:container attribute' }],
  },
  {
    id: 'gatsby',
    name: 'Gatsby',
    html: [
      { pattern: elementId('___gatsby'), evidence: 'the page has a ___gatsby root element' },
      { pattern: asset(String.raw`\/page-data\/[^"']*app-data\.json`), evidence: 'the page loads Gatsby page-data' },
    ],
  },
  {
    // Before Vite: `vitepress dev` loads the Vite client.
    id: 'vitepress',
    name: 'VitePress',
    html: [{ pattern: generator('VitePress'), evidence: 'the generator meta tag names VitePress' }],
  },
  {
    id: 'hugo',
    name: 'Hugo',
    html: [{ pattern: generator('Hugo'), evidence: 'the generator meta tag names Hugo' }],
  },
  {
    id: 'jekyll',
    name: 'Jekyll',
    html: [{ pattern: generator('Jekyll'), evidence: 'the generator meta tag names Jekyll' }],
  },
  {
    id: 'eleventy',
    name: 'Eleventy',
    html: [{ pattern: generator('Eleventy'), evidence: 'the generator meta tag names Eleventy' }],
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    html: [
      { pattern: generator('WordPress'), evidence: 'the generator meta tag names WordPress' },
      { pattern: asset(String.raw`\/wp-content\/`), evidence: 'assets are served from /wp-content/' },
    ],
  },
  {
    // Last of the real frameworks: everything above is built on Vite, so this only fires for a
    // site that shows Vite's own fingerprints and nobody else's.
    id: 'vite',
    name: 'Vite',
    html: [
      { pattern: asset(String.raw`\/@vite\/client`), evidence: 'the page loads the Vite dev client' },
      { pattern: /<script[^>]+type=["']module["'][^>]+src=["'][^"']*\/assets\/index-[A-Za-z0-9_-]{8}\.js/, evidence: 'assets follow the Vite hashed build naming' },
    ],
  },
];

/**
 * @param {string} html
 * @param {Headers} [headers]
 * @returns {Framework | undefined}
 */
export function detectFramework(html, headers) {
  for (const signature of SIGNATURES) {
    for (const rule of signature.html ?? []) {
      if (rule.pattern.test(html)) {
        return { id: signature.id, name: signature.name, evidence: rule.evidence };
      }
    }
    for (const rule of signature.header ?? []) {
      const value = headers?.get(rule.name);
      if (!value) continue;
      if (!rule.pattern || rule.pattern.test(value)) {
        return { id: signature.id, name: signature.name, evidence: rule.evidence };
      }
    }
  }
  if (looksStatic(html)) {
    return { id: 'plain', name: 'plain HTML', evidence: 'the page loads no JavaScript bundle' };
  }
  return undefined;
}

/**
 * A page with no bundle at all. Worth naming separately, because the fix for a plain HTML site is
 * not middleware: it is writing the `.md` files next to the `.html` ones and configuring the host.
 *
 * @param {string} html
 * @returns {boolean}
 */
function looksStatic(html) {
  const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
  return !scripts.some((tag) => /\bsrc=/i.test(tag) || /type=["']module["']/i.test(tag));
}
