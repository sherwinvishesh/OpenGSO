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

/**
 * Normalise any path into a canonical route: leading slash, no trailing slash (except "/").
 *
 * @param {string} pathname
 * @returns {string}
 */
export function normalizeRoute(pathname) {
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
 *
 * @param {string} route
 * @returns {boolean}
 */
export function hasDotSegment(route) {
  return route.split(/[\\/]/).some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
}

/**
 * `/` -> `md/index.md`, `/resume` -> `md/resume.md`, `/blog/post` -> `md/blog/post.md`.
 *
 * @param {string} route
 * @returns {string}
 */
export function routeToMdRelPath(route) {
  const r = normalizeRoute(route);
  const slug = r === '/' ? 'index' : r.slice(1);
  return `${MD_DIR}/${slug}.md`;
}

/**
 * Where a twin goes on disk.
 *
 * `md` is the layout prod serves from: every twin under `md/`, kept apart from the site so prod can
 * answer `/about.md` with the right headers. `beside` puts `about.md` next to `about.html`, for a
 * site generated from its files and served by a static host, which answers `/about.md` only if a
 * file sits at exactly that path. Prod reads the path from the manifest, so it serves either.
 *
 * In the `beside` layout the name is decoded, because a static host decodes the URL before it looks
 * on disk: the twin of `/my%20page` is `my page.md`.
 *
 * @param {string} route
 * @param {TwinLayout} [layout]
 * @returns {string}
 */
export function routeToTwinRelPath(route, layout = 'md') {
  if (layout === 'md') return routeToMdRelPath(route);
  const r = normalizeRoute(route);
  if (r === '/') return 'index.md';
  const slug = r
    .slice(1)
    .split('/')
    .map((segment) => {
      // A segment that would decode into a separator stays encoded: `%2F` is part of one name, not a
      // way into another folder.
      try {
        const decoded = decodeURIComponent(segment);
        return /[\\/]/.test(decoded) ? segment : decoded;
      } catch {
        return segment;
      }
    })
    .join('/');
  return `${slug}.md`;
}

/** @typedef {'md' | 'beside'} TwinLayout */

/**
 * Two routes with the same key would write the same twin file: `/` and `/index` always, and
 * `/About` and `/about` on a case-insensitive filesystem. Case is folded everywhere, not only on the
 * machine that generates, because `public/` is committed and checked out on macOS and Windows too.
 *
 * @param {string} route
 * @param {TwinLayout} [layout]
 * @returns {string}
 */
export function twinFileKey(route, layout = 'md') {
  return routeToTwinRelPath(route, layout).toLowerCase();
}

/**
 * `/` -> `/index.md`, `/resume` -> `/resume.md`.
 *
 * @param {string} route
 * @returns {string}
 */
export function routeToTwinUrlPath(route) {
  const r = normalizeRoute(route);
  return r === '/' ? '/index.md' : `${r}.md`;
}

/**
 * Reverse of the two above. Accepts both the canonical twin URL (`/resume.md`) and a direct hit on
 * the on-disk location (`/md/resume.md`), because prod intercepts both.
 *
 * @param {string} pathname
 * @returns {string | undefined}
 */
export function twinUrlPathToRoute(pathname) {
  let p = normalizeRoute(pathname);
  if (!p.endsWith('.md')) return undefined;
  p = p.slice(0, -'.md'.length);
  if (p.startsWith(`/${MD_DIR}/`)) p = p.slice(`/${MD_DIR}`.length);
  if (p === `/${MD_DIR}` || p === '') return undefined;
  if (p === '/index') return '/';
  return normalizeRoute(p);
}

/**
 * @param {string} pathname
 * @returns {boolean}
 */
export function isMarkdownPath(pathname) {
  return normalizeRoute(pathname).endsWith('.md');
}

/**
 * Absolute URL of a route's twin, for `Link: rel="alternate"` and test output.
 *
 * @param {string} pageUrl
 * @returns {string}
 */
export function twinUrl(pageUrl) {
  const u = new URL(pageUrl);
  u.pathname = routeToTwinUrlPath(u.pathname);
  u.search = '';
  u.hash = '';
  return u.toString();
}
