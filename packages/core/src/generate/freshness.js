import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { internalDirPath, publicDirPath } from '../shared/config.js';
import { ERRORS } from '../shared/errors.js';
import { contentHash } from '../shared/hash.js';
import { fileToRoute, listLocalPages } from '../shared/local-pages.js';
import { readManifest } from './manifest.js';

/**
 * @import { LoadedConfig } from '../shared/config.js'
 * @import { FreshnessReport, StaleKind, StaleTwin } from '../shared/api-types.js'
 */

/**
 * Which twins are older than the HTML file they were made from.
 *
 * Only a project that generates from its files can be asked: a crawl never sees a file, and a
 * crawled site's twins are checked against the live pages by test's drift check instead.
 *
 * A modification time alone is not the answer. A checkout, a copy or a `touch` moves it without
 * changing a word, so a newer date is only a reason to look: the file's text is hashed and compared
 * with the hash recorded when the twin last matched it. Nothing here reaches the extractor, so the
 * home screen can afford to ask.
 */

/** Two clocks a second apart are the same clock, and a hand-written twin is often saved alongside. */
const SLACK_MS = 1000;

/**
 * @param {Pick<LoadedConfig, 'root' | 'config'>} loaded
 * @returns {FreshnessReport | undefined} Undefined when the project does not generate from files.
 */
export function checkFreshness(loaded) {
  const manifest = readManifest(internalDirPath(loaded));
  const entries = Object.values(manifest.pages);
  if (manifest.source !== 'files' && !entries.some((entry) => entry.sourceFile)) return undefined;

  const webRoot = publicDirPath(loaded);
  /** @type {StaleTwin[]} */
  const stale = [];
  let checked = 0;
  /** @type {Set<string>} */
  const known = new Set();

  for (const entry of entries) {
    if (!entry.sourceFile) continue;
    known.add(entry.sourceFile);
    const source = resolve(webRoot, entry.sourceFile);
    const twin = resolve(webRoot, entry.file);
    // A manifest is a file anybody can edit, so neither path is trusted to stay in the web root.
    if (!source.startsWith(webRoot + sep) || !twin.startsWith(webRoot + sep)) continue;
    checked += 1;

    const sourceStat = statOf(source);
    if (!sourceStat) {
      stale.push({ kind: 'missing', sourceFile: entry.sourceFile, route: entry.route, twin: entry.file, message: ERRORS.staleMissing(entry.sourceFile, entry.file) });
      continue;
    }
    const modified = new Date(sourceStat.mtimeMs);

    if (entry.tier === 'manual') {
      const twinStat = statOf(twin);
      if (twinStat && sourceStat.mtimeMs > twinStat.mtimeMs + SLACK_MS) {
        const saved = new Date(twinStat.mtimeMs);
        stale.push({
          kind: 'manual',
          sourceFile: entry.sourceFile,
          route: entry.route,
          twin: entry.file,
          sourceModified: modified.toISOString(),
          twinWritten: saved.toISOString(),
          message: ERRORS.staleManual(entry.sourceFile, entry.file, ...localTimes(modified, saved)),
        });
      }
      continue;
    }

    if (entry.sourceModified === modified.toISOString()) continue;
    /** @type {string | undefined} */
    let hash;
    try {
      hash = contentHash(readFileSync(source, 'utf8'));
    } catch {
      // Stat-able and unreadable is a permissions problem generate will report. Not a stale twin.
      continue;
    }
    if (hash === entry.sourceFileHash) continue;
    const written = Date.parse(entry.lastUpdated);
    const writtenAt = Number.isNaN(written) ? undefined : new Date(written);
    const [modifiedShown, writtenShown] = writtenAt ? localTimes(modified, writtenAt) : [localTime(modified), 'at an unknown time'];
    stale.push({
      kind: 'changed',
      sourceFile: entry.sourceFile,
      route: entry.route,
      twin: entry.file,
      sourceModified: modified.toISOString(),
      ...(writtenAt ? { twinWritten: writtenAt.toISOString() } : {}),
      message: ERRORS.staleChanged(
        entry.sourceFile,
        entry.file,
        modifiedShown,
        writtenShown,
        !writtenAt || sourceStat.mtimeMs > written,
      ),
    });
  }

  // A page with no twin is behind as well, by its whole content. Matched by route as well as file,
  // so a page that lost its URL to another file, or a twin made before the file was recorded, is
  // not reported as new.
  const routes = new Set(Object.keys(manifest.pages));
  const listing = listLocalPages(webRoot, { exclude: loaded.config.crawl.exclude, skipDirs: [internalDirPath(loaded)] });
  for (const page of listing.pages) {
    if (known.has(page.file) || routes.has(fileToRoute(page.file, 'file')) || routes.has(fileToRoute(page.file, 'clean'))) continue;
    stale.push({ kind: 'new', sourceFile: page.file, sourceModified: new Date(page.mtimeMs).toISOString(), message: ERRORS.staleNew(page.file) });
  }

  stale.sort((a, b) => (a.sourceFile < b.sourceFile ? -1 : a.sourceFile > b.sourceFile ? 1 : 0));
  return { checked, stale };
}

/**
 * How many of each kind a report holds, for a summary line and for `ERRORS.staleRemedy`.
 *
 * @param {FreshnessReport} report
 * @returns {Record<StaleKind, number>}
 */
export function staleCounts(report) {
  /** @type {Record<StaleKind, number>} */
  const counts = { changed: 0, manual: 0, missing: 0, new: 0 };
  for (const twin of report.stale) counts[twin.kind] += 1;
  return counts;
}

/**
 * @param {string} path
 * @returns {import('node:fs').Stats | undefined}
 */
function statOf(path) {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `2026-10-19 14:05` in the machine's own time zone, which is the clock the person editing the file
 * reads.
 *
 * @param {Date} date
 * @param {boolean} [seconds]
 * @returns {string}
 */
export function localTime(date, seconds = false) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const minute = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return seconds ? `${minute}:${pad(date.getSeconds())}` : minute;
}

/**
 * Two times for one sentence. "Modified 14:05, after its twin was written 14:05" reads as a
 * contradiction, so when both fall in the same minute both get their seconds.
 *
 * @param {Date} first
 * @param {Date} second
 * @returns {[string, string]}
 */
function localTimes(first, second) {
  const seconds = localTime(first) === localTime(second);
  return [localTime(first, seconds), localTime(second, seconds)];
}
