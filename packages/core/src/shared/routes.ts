/**
 * Route <-> file <-> markdown-twin-URL mapping.
 *
 * Generated output lives under `public/` (so it deploys with the site), with the twins in
 * `public/md/`. The twin's canonical URL is the page path with `.md` appended - `/resume` ->
 * `/resume.md`, `/` -> `/index.md` - which prod serves from `public/md/<route>.md` with the full
 * §7 header set. Keeping the URL and the on-disk path separate is what lets prod attach correct
 * headers instead of letting the host's static file handler answer with the wrong ones.
 */

export const MD_DIR = 'md';

/** Normalise any path into a canonical route: leading slash, no trailing slash (except "/"). */
export function normalizeRoute(pathname: string): string {
  let p = pathname.trim();
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p === '' ? '/' : p;
}

/**
 * True when a route has a `.` or `..` segment, written out or percent-encoded.
 *
 * A route becomes a file path, so `/../../x` would be a file outside `public/`. Routes found by
 * the crawl have been through the URL parser, which resolves dots, so this only ever trips on a
 * route someone typed: `extraRoutes`, or a caller of the programmatic API. Backslashes count as
 * separators because they are on Windows.
 */
export function hasDotSegment(route: string): boolean {
  return route.split(/[\\/]/).some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
}

/** `/` -> `md/index.md`, `/resume` -> `md/resume.md`, `/blog/post` -> `md/blog/post.md`. */
export function routeToMdRelPath(route: string): string {
  const r = normalizeRoute(route);
  const slug = r === '/' ? 'index' : r.slice(1);
  return `${MD_DIR}/${slug}.md`;
}

/** `/` -> `/index.md`, `/resume` -> `/resume.md`. */
export function routeToTwinUrlPath(route: string): string {
  const r = normalizeRoute(route);
  return r === '/' ? '/index.md' : `${r}.md`;
}

/**
 * Reverse of the two above. Accepts both the canonical twin URL (`/resume.md`) and a direct hit on
 * the on-disk location (`/md/resume.md`), because prod intercepts both.
 */
export function twinUrlPathToRoute(pathname: string): string | undefined {
  let p = normalizeRoute(pathname);
  if (!p.endsWith('.md')) return undefined;
  p = p.slice(0, -'.md'.length);
  if (p.startsWith(`/${MD_DIR}/`)) p = p.slice(`/${MD_DIR}`.length);
  if (p === `/${MD_DIR}` || p === '') return undefined;
  if (p === '/index') return '/';
  return normalizeRoute(p);
}

export function isMarkdownPath(pathname: string): boolean {
  return normalizeRoute(pathname).endsWith('.md');
}

/** Absolute URL of a route's twin, for `Link: rel="alternate"` and test output. */
export function twinUrl(pageUrl: string): string {
  const u = new URL(pageUrl);
  u.pathname = routeToTwinUrlPath(u.pathname);
  u.search = '';
  u.hash = '';
  return u.toString();
}
