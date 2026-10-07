import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig } from './config.js';
import { BROWSER_UA, parseUrl, probe } from './http.js';
import { twinUrl } from './routes.js';
import { HEADERS } from './version.js';

/**
 * The two things setup can find out for itself instead of asking.
 *
 * Onboarding used to ask four questions blind and then print three commands to go and try. Both
 * halves of that were a missed opportunity: the answers to two of the questions are sitting on the
 * filesystem and on the wire, and the person answering them has no way to tell whether they got
 * them right until much later.
 *
 * So: the site URL is fetched as it is typed, and the web root is guessed from what the project
 * actually is. Neither is allowed to block. A probe that times out, a `package.json` that will not
 * parse, a directory that cannot be read - all of it degrades to "we could not tell", because a
 * setup flow that fails on a diagnostic is worse than one that never ran it.
 *
 * It lives in `shared/` rather than beside the setup flow because both doors onto setup need it and
 * neither owns it: the terminal reads it through `cli/setup-preview.js`, and the dashboard reads it
 * over `POST /api/preview`. Nothing here knows about either. The rendering is somebody else's job.
 */

/**
 * @typedef {object} SitePreview
 * @property {string} url
 * @property {boolean} ok The page answered with a 2xx.
 * @property {number} status
 * @property {number} ttfbMs
 * @property {string} [error] Set when the request never completed: DNS, connection refused, a
 *   timeout.
 * @property {string} [framework] A human name for what is serving the page, when the response
 *   gives it away.
 * @property {boolean} [clientRendered] The raw HTML is an empty mount element, so `generate` will
 *   find nothing to convert.
 * @property {{ url: string; ok: boolean; status: number; served: boolean }} [twin] What is already
 *   at the `.md` URL, if anything.
 */

/**
 * Signals in the order they are checked. A header beats markup, because markup can be copied from a
 * tutorial and a header is emitted by the thing actually running.
 *
 * @type {ReadonlyArray<{ name: string; header?: RegExp; markup?: RegExp }>}
 */
const FRAMEWORKS = [
  { name: 'Next.js', header: /next\.js/i, markup: /__NEXT_DATA__|\/_next\/static\//i },
  { name: 'Nuxt', markup: /__NUXT__|\/_nuxt\//i },
  { name: 'SvelteKit', markup: /__sveltekit|\/_app\/immutable\//i },
  { name: 'Astro', markup: /astro-island|content=["']Astro/i },
  { name: 'Remix', markup: /__remixContext/i },
  { name: 'Gatsby', markup: /___gatsby|\/page-data\//i },
  { name: 'Docusaurus', markup: /__docusaurus/i },
  { name: 'Hugo', markup: /content=["']Hugo/i },
  { name: 'Jekyll', markup: /content=["']Jekyll/i },
  { name: 'WordPress', markup: /wp-content\/|content=["']WordPress/i },
  { name: 'Vite', markup: /\/@vite\/client/i },
];

/** An empty root element and nothing else is the shape of a page whose content only exists after JS. */
const EMPTY_MOUNT = /<div[^>]+id=["'](root|app|__next)["'][^>]*>\s*<\/div>/i;

/**
 * @typedef {object} PreviewOptions
 * @property {number} [timeoutMs] Kept short on purpose: this runs while somebody is waiting at a
 *   prompt.
 * @property {typeof probe} [fetchPage]
 */

/**
 * @param {string} url
 * @param {PreviewOptions} [options]
 * @returns {Promise<SitePreview>}
 */
export async function previewSite(url, options = {}) {
  const fetchPage = options.fetchPage ?? probe;
  const timeoutMs = options.timeoutMs ?? 6_000;
  // As a browser, because the answer wanted here is "what does this site serve people", and a site
  // that already routes markdown to OpenGEO's own agent would otherwise report itself as markdown.
  const page = await fetchPage(url, { timeoutMs, headers: { 'User-Agent': BROWSER_UA } });

  /** @type {SitePreview} */
  const preview = { url, ok: page.ok, status: page.status, ttfbMs: page.ttfbMs };
  if (page.error) preview.error = whyUnreachable(url, page.error);
  if (!page.ok) return preview;

  const poweredBy = page.headers.get('x-powered-by') ?? '';
  const framework = FRAMEWORKS.find(
    (candidate) => (candidate.header && candidate.header.test(poweredBy)) || (candidate.markup && candidate.markup.test(page.body)),
  );
  if (framework) preview.framework = framework.name;
  if (EMPTY_MOUNT.test(page.body)) preview.clientRendered = true;

  // Head-only: whether a twin exists is the question, and downloading it to answer that would make
  // the prompt wait on a document nobody has asked for yet.
  const twin = twinUrl(url);
  const found = await fetchPage(twin, { timeoutMs, headOnly: true });
  preview.twin = {
    url: twin,
    ok: found.ok,
    status: found.status,
    served: found.ok && Boolean(found.headers.get(HEADERS.aeoVersion)),
  };
  return preview;
}

/**
 * The fetch failure as something a person can act on.
 *
 * Undici says "fetch failed" for a refused connection, an unknown host and a rejected certificate
 * alike, and a setup prompt that repeats those two words has told the reader nothing they had not
 * already worked out from the fact that they are reading an error. The cause is not on the message,
 * so this does not pretend to diagnose: for a loopback address the port is the only thing that can
 * be wrong and it says so, and everything else gets the honest general answer. Anything that already
 * reads like a sentence is passed through untouched.
 *
 * @param {string} url
 * @param {string} message
 * @returns {string}
 */
function whyUnreachable(url, message) {
  const target = parseUrl(url);
  if (/abort|timed? ?out/i.test(message)) return 'it did not answer in time';
  if (!/fetch failed|ECONNREFUSED|ECONNRESET|terminated|other side closed|socket hang up/i.test(message)) return message;
  const local = target?.hostname === 'localhost' || target?.hostname === '127.0.0.1' || target?.hostname === '::1';
  if (local) return `nothing is listening on port ${target?.port || (target?.protocol === 'https:' ? '443' : '80')}`;
  return 'the host could not be reached';
}

/**
 * @typedef {object} WebRootGuess
 * @property {string} dir
 * @property {string} why Why this directory, in the half-sentence a prompt can afford to show.
 * @property {boolean} found False when nothing pointed here and the default is being offered for
 *   want of anything better.
 */

/**
 * Dependencies first, then directories.
 *
 * A `next` in `package.json` is a statement about where static files go; a `public/` on disk is
 * evidence for the same thing but weaker, because plenty of projects have one for other reasons.
 * `dist/` is last and says so: it is a build output, and anything written there is one `npm run
 * build` away from being deleted.
 *
 * @type {ReadonlyArray<{ dep: RegExp; dir: string; why: string }>}
 */
const BY_DEPENDENCY = [
  { dep: /^next$/, dir: 'public', why: 'Next.js serves public/ from the site root' },
  { dep: /^gatsby$/, dir: 'static', why: 'Gatsby serves static/ from the site root' },
  { dep: /^@sveltejs\/kit$/, dir: 'static', why: 'SvelteKit serves static/ from the site root' },
  { dep: /^nuxt$/, dir: 'public', why: 'Nuxt serves public/ from the site root' },
  { dep: /^astro$/, dir: 'public', why: 'Astro serves public/ from the site root' },
  { dep: /^@docusaurus\/core$/, dir: 'static', why: 'Docusaurus serves static/ from the site root' },
  { dep: /^(vite|react-scripts)$/, dir: 'public', why: 'Vite serves public/ from the site root' },
];

/** @type {ReadonlyArray<{ dir: string; why: string }>} */
const BY_DIRECTORY = [
  { dir: 'public', why: 'public/ exists and is served as-is by most frameworks' },
  { dir: 'static', why: 'static/ exists and is served as-is by most static site generators' },
  { dir: 'www', why: 'www/ exists and looks like the served directory' },
  { dir: 'dist', why: 'dist/ exists, but it is a build output, so check this one' },
];

/**
 * @param {string} root
 * @returns {WebRootGuess}
 */
export function detectWebRoot(root) {
  const deps = readDependencies(root);
  for (const candidate of BY_DEPENDENCY) {
    if (deps.some((name) => candidate.dep.test(name))) return { dir: candidate.dir, why: candidate.why, found: true };
  }
  for (const candidate of BY_DIRECTORY) {
    if (isDirectory(join(root, candidate.dir))) return { dir: candidate.dir, why: candidate.why, found: true };
  }
  return { dir: defaultConfig().publicDir, why: 'nothing on disk pointed anywhere, so this is the usual answer', found: false };
}

/**
 * Every dependency name in `package.json`, or none if there is no readable one.
 *
 * @param {string} root
 * @returns {string[]}
 */
function readDependencies(root) {
  try {
    const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
    /** @type {string[]} */
    const names = [];
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const block = parsed[field];
      if (block && typeof block === 'object') names.push(...Object.keys(/** @type {Record<string, unknown>} */ (block)));
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isDirectory(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
