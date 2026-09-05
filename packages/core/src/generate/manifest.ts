import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AEO_SPEC_VERSION } from '../shared/version.js';

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

export type GenerationTier = 'free' | 'ai' | 'manual';

export interface ManifestEntry {
  route: string;
  url: string;
  title: string;
  /** Path relative to the public directory, e.g. `md/resume.md`. */
  file: string;
  tokens: number;
  wordCount: number;
  /** Hash of the source HTML this twin came from. Drives skip-unchanged and test's drift check. */
  sourceHash: string;
  lastUpdated: string;
  tier: GenerationTier;
}

export interface Manifest {
  version: number;
  specVersion: string;
  site: string;
  generatedAt: string;
  pages: Record<string, ManifestEntry>;
}

export function emptyManifest(site: string): Manifest {
  return {
    version: MANIFEST_VERSION,
    specVersion: AEO_SPEC_VERSION,
    site,
    generatedAt: new Date().toISOString(),
    pages: {},
  };
}

export function manifestPath(internalDir: string): string {
  return join(internalDir, MANIFEST_FILENAME);
}

export function readManifest(internalDir: string, site = ''): Manifest {
  const path = manifestPath(internalDir);
  if (!existsSync(path)) return emptyManifest(site);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
    if (parsed.version !== MANIFEST_VERSION || typeof parsed.pages !== 'object') {
      return emptyManifest(site);
    }
    return parsed;
  } catch {
    return emptyManifest(site);
  }
}

export function writeManifest(internalDir: string, manifest: Manifest): string {
  const path = manifestPath(internalDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return path;
}
