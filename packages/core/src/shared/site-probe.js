import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig } from './config.js';
import { detectFramework } from './framework.js';
import { BROWSER_UA, parseUrl, probe } from './http.js';
import { twinUrl } from './routes.js';
import { frameworkWebRoot } from './web-root.js';
import { HEADERS } from './version.js';

/**
 * Defined in `api-types.js` with every other shape the dashboard reads, and re-exported here.
 *
 * @typedef {import('./api-types.js').SitePreview} SitePreview
 * @typedef {import('./api-types.js').WebRootGuess} WebRootGuess
 */

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
  // that already routes markdown to OpenGSO's own agent would otherwise report itself as markdown.
  const page = await fetchPage(url, { timeoutMs, headers: { 'User-Agent': BROWSER_UA } });

  /** @type {SitePreview} */
  const preview = { url, ok: page.ok, status: page.status, ttfbMs: page.ttfbMs };
  if (page.error) preview.error = whyUnreachable(url, page.error);
  if (!page.ok) return preview;

  // The same table the test report reads, so setup and the report cannot disagree. "plain HTML" is
  // a guess from the absence of a bundle rather than a fingerprint, and setup names only what it saw.
  const framework = detectFramework(page.body, page.headers);
  if (framework && framework.id !== 'plain') preview.framework = framework.name;
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
export function whyUnreachable(url, message) {
  const target = parseUrl(url);
  if (/abort|timed? ?out/i.test(message)) return 'it did not answer in time';
  if (!/fetch failed|ECONNREFUSED|ECONNRESET|terminated|other side closed|socket hang up/i.test(message)) return message;
  const local = target?.hostname === 'localhost' || target?.hostname === '127.0.0.1' || target?.hostname === '::1';
  if (local) return `nothing is listening on port ${target?.port || (target?.protocol === 'https:' ? '443' : '80')}`;
  return 'the host could not be reached';
}

/**
 * The framework's convention first (see web-root.js), then directories. A `public/` on disk is
 * evidence for the same thing but weaker, because plenty of projects have one for other reasons.
 * `dist/` is last and says so: it is a build output, and anything written there is one `npm run
 * build` away from being deleted.
 *
 * @type {ReadonlyArray<{ dir: string; why: string }>}
 */
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
  const framework = frameworkWebRoot(root);
  if (framework) return { ...framework, found: true };
  for (const candidate of BY_DIRECTORY) {
    if (isDirectory(join(root, candidate.dir))) return { dir: candidate.dir, why: candidate.why, found: true };
  }
  return { dir: defaultConfig().publicDir, why: 'nothing on disk pointed anywhere, so this is the usual answer', found: false };
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
