import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig } from '../shared/config.js';
import { BROWSER_UA, probe } from '../shared/http.js';
import { twinUrl } from '../shared/routes.js';
import { c } from '../shared/log.js';
import { HEADERS } from '../shared/version.js';
import { ink } from './tui/theme.js';

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
 */

export interface SitePreview {
  url: string;
  /** The page answered with a 2xx. */
  ok: boolean;
  status: number;
  ttfbMs: number;
  /** Set when the request never completed: DNS, connection refused, a timeout. */
  error?: string;
  /** A human name for what is serving the page, when the response gives it away. */
  framework?: string;
  /** The raw HTML is an empty mount element, so `generate` will find nothing to convert. */
  clientRendered?: boolean;
  /** What is already at the `.md` URL, if anything. */
  twin?: { url: string; ok: boolean; status: number; served: boolean };
}

/**
 * Signals in the order they are checked. A header beats markup, because markup can be copied from a
 * tutorial and a header is emitted by the thing actually running.
 */
const FRAMEWORKS: ReadonlyArray<{ name: string; header?: RegExp; markup?: RegExp }> = [
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

export interface PreviewOptions {
  /** Kept short on purpose: this runs while somebody is waiting at a prompt. */
  timeoutMs?: number;
  fetchPage?: typeof probe;
}

export async function previewSite(url: string, options: PreviewOptions = {}): Promise<SitePreview> {
  const fetchPage = options.fetchPage ?? probe;
  const timeoutMs = options.timeoutMs ?? 6_000;
  // As a browser, because the answer wanted here is "what does this site serve people", and a site
  // that already routes markdown to OpenGEO's own agent would otherwise report itself as markdown.
  const page = await fetchPage(url, { timeoutMs, headers: { 'User-Agent': BROWSER_UA } });

  const preview: SitePreview = { url, ok: page.ok, status: page.status, ttfbMs: page.ttfbMs };
  if (page.error) preview.error = page.error;
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

export interface WebRootGuess {
  dir: string;
  /** Why this directory, in the half-sentence a prompt can afford to show. */
  why: string;
  /** False when nothing pointed here and the default is being offered for want of anything better. */
  found: boolean;
}

/**
 * Dependencies first, then directories.
 *
 * A `next` in `package.json` is a statement about where static files go; a `public/` on disk is
 * evidence for the same thing but weaker, because plenty of projects have one for other reasons.
 * `dist/` is last and says so: it is a build output, and anything written there is one `npm run
 * build` away from being deleted.
 */
const BY_DEPENDENCY: ReadonlyArray<{ dep: RegExp; dir: string; why: string }> = [
  { dep: /^next$/, dir: 'public', why: 'Next.js serves public/ from the site root' },
  { dep: /^gatsby$/, dir: 'static', why: 'Gatsby serves static/ from the site root' },
  { dep: /^@sveltejs\/kit$/, dir: 'static', why: 'SvelteKit serves static/ from the site root' },
  { dep: /^nuxt$/, dir: 'public', why: 'Nuxt serves public/ from the site root' },
  { dep: /^astro$/, dir: 'public', why: 'Astro serves public/ from the site root' },
  { dep: /^@docusaurus\/core$/, dir: 'static', why: 'Docusaurus serves static/ from the site root' },
  { dep: /^(vite|react-scripts)$/, dir: 'public', why: 'Vite serves public/ from the site root' },
];

const BY_DIRECTORY: ReadonlyArray<{ dir: string; why: string }> = [
  { dir: 'public', why: 'public/ exists and is served as-is by most frameworks' },
  { dir: 'static', why: 'static/ exists and is served as-is by most static site generators' },
  { dir: 'www', why: 'www/ exists and looks like the served directory' },
  { dir: 'dist', why: 'dist/ exists, but it is a build output, so check this one' },
];

export function detectWebRoot(root: string): WebRootGuess {
  const deps = readDependencies(root);
  for (const candidate of BY_DEPENDENCY) {
    if (deps.some((name) => candidate.dep.test(name))) return { dir: candidate.dir, why: candidate.why, found: true };
  }
  for (const candidate of BY_DIRECTORY) {
    if (isDirectory(join(root, candidate.dir))) return { dir: candidate.dir, why: candidate.why, found: true };
  }
  return { dir: defaultConfig().publicDir, why: 'nothing on disk pointed anywhere, so this is the usual answer', found: false };
}

/** Every dependency name in `package.json`, or none if there is no readable one. */
function readDependencies(root: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    const names: string[] = [];
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const block = parsed[field];
      if (block && typeof block === 'object') names.push(...Object.keys(block as Record<string, unknown>));
    }
    return names;
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The probe as two or three lines under the URL prompt.
 *
 * Written so that every line is either a fact about the response or a consequence of it. "Reachable"
 * on its own is not worth the round trip; "reachable, Next.js, and the content is in the HTML" tells
 * somebody that generate is going to work before they run it.
 */
export function previewLines(preview: SitePreview): string[] {
  if (preview.error) {
    return [
      ink.warn(`Could not reach ${preview.url}: ${preview.error}`),
      c.gray('Setup carries on. The URL is saved either way, and nothing here is a blocker.'),
    ];
  }
  if (!preview.ok) {
    return [
      ink.warn(`${preview.url} answered ${preview.status}.`),
      c.gray('Worth checking the URL, though the rest of setup does not depend on it.'),
    ];
  }

  const facts = [`${preview.status} in ${preview.ttfbMs}ms`];
  if (preview.framework) facts.push(preview.framework);
  const lines = [`${ink.ok('Reachable')} ${c.gray(`(${facts.join(', ')})`)}`];

  if (preview.clientRendered) {
    lines.push(ink.warn('The raw HTML is an empty mount element, so the content only exists after JavaScript runs.'));
    lines.push(c.gray('Agents mostly do not run it, and neither does generate. Server-rendering is the fix.'));
  }

  if (preview.twin?.served) {
    lines.push(`${ink.ok('A markdown twin is already being served')} ${c.gray(`at ${preview.twin.url}, by opengeo-prod.`)}`);
  } else if (preview.twin?.ok) {
    lines.push(`${ink.ok('Something already answers')} ${c.gray(`at ${preview.twin.url}, without OpenGEO's headers.`)}`);
  } else {
    lines.push(c.gray(`No twin at ${preview.twin?.url ?? twinUrl(preview.url)} yet. That is what generate and prod are for.`));
  }
  return lines;
}
