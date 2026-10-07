import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERRORS } from '../shared/errors.js';
import { writeFileAtomic } from '../shared/fs.js';
import { AEO_SPEC_VERSION } from '../shared/version.js';

/**
 * Defined in `api-types.js` with every other shape the dashboard reads, and re-exported here.
 *
 * @typedef {import('../shared/api-types.js').GenerationTier} GenerationTier
 */

/**
 * `.opengeo/manifest.json` - the one record of what generate produced.
 *
 * It lives in the internal directory rather than `public/` on purpose: it is bookkeeping, not
 * content, and there is no reason for it to be web-served.
 *
 * It does double duty, which is why there is no separate cache file to drift out of sync with it:
 *  - generate reads `sourceHash` to skip pages whose content hasn't changed (§6 caching);
 *  - prod loads it once at startup so every request is a map lookup with nothing to parse (§7).
 */

export const MANIFEST_FILENAME = 'manifest.json';
export const MANIFEST_VERSION = 1;

/**
 * @typedef {object} ManifestEntry
 * @property {string} route
 * @property {string} url
 * @property {string} title
 * @property {string} file Path relative to the public directory, e.g. `md/resume.md`.
 * @property {number} tokens
 * @property {number} wordCount
 * @property {string} [sourceHash] Hash of the *extracted content* this twin came from, not of the raw
 *   HTML.
 *
 *   Raw HTML is the obvious thing to hash and the wrong one. Every framework stamps a build id,
 *   a script hash or a nonce into its markup, so a rebuild with no content change would produce a
 *   fresh hash, invalidate the whole cache, and make test's drift check cry wolf on every deploy.
 *   Hashing what a reader actually receives means the hash changes exactly when the page changes.
 *
 *   Absent for a hand-written twin that declares no `source_hash`: there is no honest value to put
 *   here, and inventing one would make the drift check report a page as verified when it isn't.
 * @property {string} lastUpdated
 * @property {GenerationTier} tier
 * @property {'fidelity' | 'truncated' | 'too-long'} [aiFallback] The AI tier was asked for this
 *   content and could not be used, for a reason that would recur. The next AI run treats the free
 *   twin as current instead of paying for the same outcome again; a content change or `--force`
 *   tries again.
 * @property {string} [description] Carried so a fully-cached rerun can still write llms.txt without
 *   re-extracting every page.
 * @property {string} [lastModified] The modification date the page declares about itself, which
 *   sitemap.xml uses for `<lastmod>`. Unlike `lastUpdated` (when the twin was written), it is never
 *   invented: absent when the page declares none.
 * @property {string} [canonical] The page's own `<link rel="canonical">`, which sitemap.xml lists in
 *   place of `url` when it is on the same site. Absent when the page declares none.
 */

/**
 * @typedef {object} Manifest
 * @property {number} version
 * @property {string} specVersion
 * @property {string} site
 * @property {string} generatedAt
 * @property {Record<string, ManifestEntry>} pages
 */

/**
 * @param {string} site
 * @returns {Manifest}
 */
export function emptyManifest(site) {
  return {
    version: MANIFEST_VERSION,
    specVersion: AEO_SPEC_VERSION,
    site,
    generatedAt: new Date().toISOString(),
    pages: {},
  };
}

/**
 * @param {string} internalDir
 * @returns {string}
 */
export function manifestPath(internalDir) {
  return join(internalDir, MANIFEST_FILENAME);
}

/**
 * @param {string} internalDir
 * @param {string} [site]
 * @returns {Manifest}
 */
export function readManifest(internalDir, site = '') {
  return readManifestChecked(internalDir, site).manifest;
}

/**
 * The manifest, or an empty one and the reason the file on disk could not be used.
 *
 * An empty manifest is the right thing to carry on with, and the wrong thing to carry on with in
 * silence: it means every page is regenerated and nothing a failed fetch would have kept is kept.
 * A missing file is a first run and not a problem.
 *
 * @param {string} internalDir
 * @param {string} [site]
 * @returns {{ manifest: Manifest; problem?: string }}
 */
export function readManifestChecked(internalDir, site = '') {
  const path = manifestPath(internalDir);
  if (!existsSync(path)) return { manifest: emptyManifest(site) };
  /** @type {Manifest} */
  let parsed;
  try {
    parsed = /** @type {Manifest} */ (JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    return { manifest: emptyManifest(site), problem: ERRORS.manifestUnreadable(path, error instanceof Error ? error.message : String(error)) };
  }
  if (parsed?.version !== MANIFEST_VERSION || typeof parsed.pages !== 'object' || parsed.pages === null) {
    const why = parsed?.version === MANIFEST_VERSION ? 'it has no page table' : `it is manifest version ${String(parsed?.version)}, not ${MANIFEST_VERSION}`;
    return { manifest: emptyManifest(site), problem: ERRORS.manifestUnreadable(path, why) };
  }
  return { manifest: parsed };
}

/**
 * @param {string} internalDir
 * @param {Manifest} manifest
 * @returns {string}
 */
export function writeManifest(internalDir, manifest) {
  const path = manifestPath(internalDir);
  writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}
