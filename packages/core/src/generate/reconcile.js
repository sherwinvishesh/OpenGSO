import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { ERRORS } from '../shared/errors.js';
import { normalizeRoute } from '../shared/routes.js';
import { countWords, estimateTokens } from '../shared/tokens.js';
import { parseFrontmatter } from './frontmatter.js';

/**
 * @import { Manifest, ManifestEntry, OrphanTwin } from './manifest.js'
 */

/**
 * Squaring a generate run with what is already on disk: which prior twins still count, which pages
 * are hand-written, whether anything changed, and which twins this run left behind. generatePages
 * does the per-route work and calls these to settle the result.
 */

/**
 * Whether the twin on disk is what this run's tier would produce. A free twin the AI tier already
 * tried and could not improve counts for the AI tier, or every run would pay for the same rejection.
 *
 * @param {ManifestEntry} prior
 * @param {'free' | 'ai'} tier
 * @returns {boolean}
 */
export function tierSatisfied(prior, tier) {
  return prior.tier === tier || (tier === 'ai' && prior.tier === 'free' && prior.aiFallback !== undefined);
}

/**
 * @param {Record<string, ManifestEntry>} a
 * @param {Record<string, ManifestEntry>} b
 * @returns {boolean}
 */
export function samePages(a, b) {
  const left = Object.keys(a).sort();
  const right = Object.keys(b).sort();
  return left.length === right.length && left.every((route, i) => route === right[i] && JSON.stringify(a[route]) === JSON.stringify(b[route]));
}

/**
 * Find the twins OpenGSO wrote for pages this run no longer has, and delete them only when asked.
 *
 * A candidate comes from the previous manifest, either as a page or as an orphan it already listed,
 * so a file no manifest ever vouched for is never considered. It must still be on disk inside the
 * twin directory, be a `.md` file, not be the file of a page this run kept, and still carry OpenGSO's
 * frontmatter: a twin the user has since taken over, with generated_by: manual or by rewriting it, is
 * theirs. A page this run kept whose twin moved, as it does when a project switches from crawling to
 * reading its files, leaves its old file behind as an orphan.
 *
 * @param {Manifest} previous
 * @param {Manifest} manifest
 * @param {string} publicDir
 * @param {string} twinDir
 * @param {boolean} prune
 * @param {string[]} warnings
 * @returns {{ orphans: OrphanTwin[]; pruned: OrphanTwin[] }}
 */
export function settleOrphans(previous, manifest, publicDir, twinDir, prune, warnings) {
  /** @type {Map<string, OrphanTwin>} */
  const candidates = new Map();
  for (const item of Array.isArray(previous.orphans) ? previous.orphans : []) {
    if (typeof item?.route === 'string' && typeof item.url === 'string' && typeof item.file === 'string') {
      candidates.set(item.route, { route: item.route, url: item.url, file: item.file });
    }
  }
  for (const entry of Object.values(previous.pages)) {
    candidates.set(entry.route, { route: entry.route, url: entry.url, file: entry.file });
  }
  const live = new Set(Object.values(manifest.pages).map((entry) => entry.file));

  /** @type {OrphanTwin[]} */
  const orphans = [];
  /** @type {OrphanTwin[]} */
  const pruned = [];
  for (const route of dedupeRoutes([...candidates.keys()])) {
    const orphan = candidates.get(route);
    if (!orphan || manifest.pages[route]?.file === orphan.file || live.has(orphan.file)) continue;
    const absPath = resolve(publicDir, orphan.file);
    if (!absPath.startsWith(twinDir + sep) || !absPath.endsWith('.md') || !existsSync(absPath)) continue;
    /** @type {string} */
    let contents;
    try {
      contents = readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }
    if (!isOpenGsoTwin(parseFrontmatter(contents).data)) continue;
    if (prune) {
      try {
        unlinkSync(absPath);
        pruned.push(orphan);
        continue;
      } catch (error) {
        warnings.push(ERRORS.pruneFailed(orphan.file, error instanceof Error ? error.message : String(error)));
      }
    }
    orphans.push(orphan);
  }
  return { orphans, pruned };
}

/**
 * @param {Record<string, unknown>} data
 * @returns {boolean}
 */
export function isOpenGsoTwin(data) {
  return data.generated_by === 'opengso-free' || data.generated_by === 'opengso-ai';
}

/**
 * A hand-written twin, recorded in the manifest so prod still serves it, but never re-derived.
 *
 * `sourceHash` is carried through only when the author put one there. A hand-written twin usually
 * has none, and a made-up hash would make test's drift check pass a page nobody has verified; with
 * the field absent the check falls back to comparing facts, which is the honest answer.
 *
 * @param {string} route
 * @param {string} url
 * @param {string} relPath
 * @param {Record<string, unknown>} data
 * @param {string} contents
 * @returns {ManifestEntry}
 */
export function manualEntry(
  route,
  url,
  relPath,
  data,
  contents,
) {
  const body = parseFrontmatter(contents).body;
  return {
    route,
    url,
    title: typeof data.title === 'string' ? data.title : route,
    file: relPath,
    tokens: typeof data.tokens === 'number' ? data.tokens : estimateTokens(body),
    wordCount: countWords(body),
    lastUpdated: typeof data.last_updated === 'string' ? data.last_updated : new Date().toISOString(),
    tier: 'manual',
    ...(typeof data.source_hash === 'string' ? { sourceHash: data.source_hash } : {}),
  };
}

/**
 * @param {string[]} routes
 * @returns {string[]}
 */
export function dedupeRoutes(routes) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const raw of routes) {
    const route = normalizeRoute(raw);
    if (seen.has(route)) continue;
    seen.add(route);
    out.push(route);
  }
  // Code-unit order rather than localeCompare, whose result depends on the machine's locale.
  return out.sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a < b ? -1 : a > b ? 1 : 0));
}
