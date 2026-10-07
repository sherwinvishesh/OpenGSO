/** @import { ProbeResult } from '../shared/http.js' */

/**
 * Framework detection (§5), used to make the report and the fix prompt specific.
 *
 * Detection is fingerprint matching on the HTML and response headers, nothing more. It is a
 * courtesy, never a dependency: no check's result changes based on what this returns, and every
 * caller has to handle `undefined`. That is deliberate, and it is the line between "we noticed
 * you're on Next.js, so here is the Next.js snippet" and the per-framework adapters §16 rules out.
 *
 * A wrong guess would be worse than no guess, because it sends the user editing the wrong file. So
 * each signal has to be something only that framework emits, and a page matching nothing reports
 * nothing.
 */

/**
 * @typedef {'nextjs'
 *   | 'nuxt'
 *   | 'astro'
 *   | 'sveltekit'
 *   | 'remix'
 *   | 'gatsby'
 *   | 'docusaurus'
 *   | 'vite'
 *   | 'plain'} FrameworkId
 */

/**
 * @typedef {object} Framework
 * @property {FrameworkId} id
 * @property {string} name Display name, used verbatim in the report and the fix prompt.
 * @property {string} evidence What gave it away, so the user can disagree with us.
 */

/**
 * @typedef {object} Signature
 * @property {FrameworkId} id
 * @property {string} name
 * @property {Array<{ pattern: RegExp; evidence: string }>} [html] Ordered: the first match wins, so more specific frameworks come before what they are built on.
 * @property {Array<{ name: string; pattern?: RegExp; evidence: string }>} [header]
 */

/** @type {Signature[]} */
const SIGNATURES = [
  {
    // Before Next.js: a Docusaurus site is a React site and carries some of the same markers.
    id: 'docusaurus',
    name: 'Docusaurus',
    html: [
      { pattern: /<meta[^>]+name=["']generator["'][^>]+content=["']Docusaurus/i, evidence: 'the generator meta tag names Docusaurus' },
      { pattern: /\bdocusaurus\b/i, evidence: 'the markup references Docusaurus' },
    ],
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    html: [
      { pattern: /\/_next\/static\//, evidence: 'assets are served from /_next/static/' },
      { pattern: /id=["']__NEXT_DATA__["']/, evidence: 'the page carries a __NEXT_DATA__ script' },
      { pattern: /self\.__next_f\b/, evidence: 'the page carries an App Router flight payload' },
    ],
    header: [{ name: 'x-powered-by', pattern: /next\.js/i, evidence: 'X-Powered-By names Next.js' }],
  },
  {
    id: 'nuxt',
    name: 'Nuxt',
    html: [
      { pattern: /\/_nuxt\//, evidence: 'assets are served from /_nuxt/' },
      { pattern: /id=["']__NUXT_DATA__["']|window\.__NUXT__/, evidence: 'the page carries a Nuxt payload' },
    ],
  },
  {
    id: 'astro',
    name: 'Astro',
    html: [
      { pattern: /<meta[^>]+name=["']generator["'][^>]+content=["']Astro/i, evidence: 'the generator meta tag names Astro' },
      { pattern: /\/_astro\//, evidence: 'assets are served from /_astro/' },
      { pattern: /astro-island|data-astro-cid-/, evidence: 'the markup carries Astro island attributes' },
    ],
  },
  {
    id: 'sveltekit',
    name: 'SvelteKit',
    html: [
      { pattern: /__sveltekit_/, evidence: 'the page carries a SvelteKit hydration payload' },
      { pattern: /\/_app\/immutable\//, evidence: 'assets are served from /_app/immutable/' },
    ],
  },
  {
    id: 'remix',
    name: 'Remix or React Router',
    html: [
      { pattern: /window\.__remixContext|__reactRouterContext/, evidence: 'the page carries a Remix or React Router context payload' },
    ],
  },
  {
    id: 'gatsby',
    name: 'Gatsby',
    html: [
      { pattern: /id=["']___gatsby["']/, evidence: 'the page has a ___gatsby root element' },
      { pattern: /\/page-data\/[^"']*app-data\.json/, evidence: 'the page loads Gatsby page-data' },
    ],
  },
  {
    // Last of the real frameworks: everything above is built on Vite, so this only fires for a
    // site that shows Vite's own fingerprints and nobody else's.
    id: 'vite',
    name: 'Vite',
    html: [
      { pattern: /\/@vite\/client/, evidence: 'the page loads the Vite dev client' },
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

/**
 * Convenience for the report and the prompt, which both work from gathered evidence.
 *
 * @param {ProbeResult} html
 * @returns {Framework | undefined}
 */
export function detectFrameworkFrom(html) {
  if (!html.body) return undefined;
  return detectFramework(html.body, html.headers);
}
