import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Where prod reads markdown from (§7).
 *
 * Everything is loaded once, at startup. By the time a request arrives, serving a twin is a map
 * lookup against already-parsed strings - no filesystem walk, no frontmatter parsing, no token
 * counting, and certainly no AI call.
 *
 * Two implementations, because hosting targets differ:
 *  - `createFsStore`   - Node runtime (Next.js Node middleware, a Node server, Netlify functions).
 *  - `createManifestStore` - edge runtimes with no filesystem: the caller imports the manifest and
 *    the markdown bodies as data at build time and hands them over.
 */

export interface MarkdownDoc {
  route: string;
  title: string;
  /** Body only - frontmatter is stripped once at load, never per request. */
  body: string;
  tokens: number;
  lastUpdated: string;
  /**
   * Hash of the HTML this twin was generated from. Carried so prod can advertise it and `test`'s
   * B14 check can tell "regenerated from this exact page" from "the page moved on without me".
   */
  sourceHash?: string;
}

export interface MarkdownStore {
  get(route: string): MarkdownDoc | undefined;
  has(route: string): boolean;
  routes(): string[];
  size: number;
  /** Non-fatal problems found while loading, reported by the startup log. */
  problems: string[];
}

interface StoreManifestEntry {
  route: string;
  title?: string;
  file: string;
  tokens: number;
  lastUpdated?: string;
  sourceHash?: string;
}

interface StoreManifest {
  pages: Record<string, StoreManifestEntry>;
}

export interface FsStoreOptions {
  /** Project root. `publicDir` and `internalDir` are resolved against it. */
  root: string;
  publicDir?: string;
  internalDir?: string;
}

export function createFsStore(options: FsStoreOptions): MarkdownStore {
  const root = resolve(options.root);
  const publicDir = resolve(root, options.publicDir ?? 'public');
  const internalDir = resolve(root, options.internalDir ?? '.opengeo');
  const manifestFile = join(internalDir, 'manifest.json');
  const problems: string[] = [];
  const docs = new Map<string, MarkdownDoc>();

  if (!existsSync(manifestFile)) {
    problems.push(`No manifest at ${manifestFile}. Run \`opengeo generate <url>\` to create the markdown twins.`);
    return buildStore(docs, problems);
  }

  let manifest: StoreManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as StoreManifest;
  } catch (error) {
    problems.push(`Could not read ${manifestFile}: ${error instanceof Error ? error.message : String(error)}`);
    return buildStore(docs, problems);
  }

  for (const entry of Object.values(manifest.pages ?? {})) {
    const file = join(publicDir, entry.file);
    if (!existsSync(file)) {
      problems.push(`Manifest lists ${entry.route} but ${file} is missing. Rerun \`opengeo generate\`.`);
      continue;
    }
    const raw = readFileSync(file, 'utf8');
    docs.set(entry.route, {
      route: entry.route,
      title: entry.title ?? entry.route,
      body: stripFrontmatter(raw),
      tokens: entry.tokens,
      lastUpdated: entry.lastUpdated ?? '',
      sourceHash: entry.sourceHash,
    });
  }
  return buildStore(docs, problems);
}

export interface ManifestStoreOptions {
  manifest: StoreManifest;
  /** Raw file contents keyed by the manifest's `file` value, e.g. `md/resume.md`. */
  contents: Record<string, string>;
}

export function createManifestStore(options: ManifestStoreOptions): MarkdownStore {
  const problems: string[] = [];
  const docs = new Map<string, MarkdownDoc>();
  for (const entry of Object.values(options.manifest.pages ?? {})) {
    const raw = options.contents[entry.file];
    if (raw === undefined) {
      problems.push(`Manifest lists ${entry.route} but no content was supplied for ${entry.file}.`);
      continue;
    }
    docs.set(entry.route, {
      route: entry.route,
      title: entry.title ?? entry.route,
      body: stripFrontmatter(raw),
      tokens: entry.tokens,
      lastUpdated: entry.lastUpdated ?? '',
      sourceHash: entry.sourceHash,
    });
  }
  return buildStore(docs, problems);
}

/** In-memory store, used by tests and by the local product website's preview. */
export function createMemoryStore(docs: MarkdownDoc[]): MarkdownStore {
  return buildStore(new Map(docs.map((d) => [d.route, d])), []);
}

function buildStore(docs: Map<string, MarkdownDoc>, problems: string[]): MarkdownStore {
  return {
    get: (route) => docs.get(route),
    has: (route) => docs.has(route),
    routes: () => [...docs.keys()],
    size: docs.size,
    problems,
  };
}

/**
 * Strip a leading `---` frontmatter block. Done once per file at load; the served body is the
 * markdown a reader actually wants, without OpenGEO's bookkeeping at the top.
 */
function stripFrontmatter(raw: string): string {
  const text = raw.replace(/^﻿/, '');
  if (!text.startsWith('---')) return text.trim();
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text.trim();
  return text.slice(end + '\n---'.length).replace(/^[^\n]*\n?/, '').trim();
}
