import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { GENERATED_MARKER, writeOrPropose } from '../generate/files.js';
import { PROD_ERRORS } from '../shared/errors.js';
import { AEO_SPEC_VERSION } from '../shared/version.js';
import { readTwins } from './store.js';

/**
 * @import { LoadedConfig } from '../shared/config.js'
 * @import { EdgeData } from './adapters/edge.js'
 * @import { StoreManifestEntry } from './manifest-store.js'
 */

/**
 * The module `opengso prod data` writes: the twins, the manifest and the bot settings, as data an
 * edge function imports, because there is no disk to read them from at the edge.
 *
 * It holds what the Node adapter would load from the same project and nothing more. A manifest
 * entry carries bookkeeping that is no business of a public function bundle, so only the fields a
 * store reads are kept.
 */

export const EDGE_DATA_BASENAME = 'opengso-edge-data';

/** Edge hosts cap a function's size, the strictest around a megabyte compressed. */
export const EDGE_DATA_WARN_BYTES = 1024 * 1024;

/** A file is ours when its first line is the comment this module writes. */
const OWNED = new RegExp(`^// ${GENERATED_MARKER} \\(`);

/**
 * @typedef {object} EdgeDataOptions
 * @property {LoadedConfig} loaded
 * @property {string} [out] Where to write it, relative to the project root. The extension picks the
 *   language: `.ts` or `.mts` writes TypeScript, anything else JavaScript.
 * @property {boolean} [force] Replace a file OpenGSO did not write.
 */

/**
 * @typedef {object} EdgeDataResult
 * @property {string} path Absolute path written: the `.opengso-proposed` one when the file was not ours.
 * @property {string} target The path that was asked for, which is the one to import.
 * @property {boolean} proposed
 * @property {boolean} written False when nothing was written: the module was unchanged, or there were
 *   no twins to put in it.
 * @property {boolean} unchanged Nothing changed since the last run.
 * @property {number} pages
 * @property {number} bytes
 * @property {string[]} problems Twins that could not be read, as the startup log would report them.
 * @property {string} importFrom The package specifier the module's type annotation names.
 */

/**
 * `opengso-edge-data.ts` in a TypeScript project, `.js` elsewhere, at the project root.
 *
 * @param {string} root
 * @returns {string}
 */
export function defaultEdgeDataPath(root) {
  const typescript = existsSync(join(root, 'tsconfig.json'));
  return join(root, `${EDGE_DATA_BASENAME}.${typescript ? 'ts' : 'js'}`);
}

/**
 * @param {LoadedConfig} loaded
 * @returns {{ data: EdgeData; problems: string[] }}
 */
export function buildEdgeData(loaded) {
  const { config, root } = loaded;
  const twins = readTwins({ root, publicDir: config.publicDir, internalDir: config.internalDir });
  /** @type {Record<string, StoreManifestEntry>} */
  const pages = {};
  for (const [key, entry] of Object.entries(twins.manifest.pages)) {
    pages[key] = {
      route: entry.route,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      file: entry.file,
      tokens: entry.tokens,
      ...(entry.lastUpdated === undefined ? {} : { lastUpdated: entry.lastUpdated }),
      ...(entry.sourceHash === undefined ? {} : { sourceHash: entry.sourceHash }),
    };
  }
  return {
    data: {
      manifest: { pages },
      contents: twins.contents,
      markdownRouting: [...config.bots.markdownRouting],
      customBots: [...(config.bots.custom ?? [])],
    },
    problems: twins.problems,
  };
}

/**
 * No timestamp in it, so the same twins write the same bytes and a build cache stays warm.
 *
 * @param {EdgeData} data
 * @param {{ typescript: boolean; importFrom: string }} options
 * @returns {string}
 */
export function renderEdgeDataModule(data, options) {
  const json = JSON.stringify(data, null, 2);
  const lines = [
    `// ${GENERATED_MARKER} (${AEO_SPEC_VERSION}) with \`opengso prod data\`. Do not edit it: run that command again`,
    `// after every \`opengso generate\`, or the edge keeps serving the twins from before.`,
  ];
  if (options.typescript) {
    lines.push(`import type { EdgeData } from '${options.importFrom}';`, '', `const data: EdgeData = ${json};`);
  } else {
    lines.push('', `/** @type {import('${options.importFrom}').EdgeData} */`, `const data = ${json};`);
  }
  lines.push('', 'export default data;', '');
  return lines.join('\n');
}

/**
 * The package that provides the type in this project: `opengso-prod` when it is a dependency,
 * `opengso` when only the umbrella is, and `opengso-prod` when neither is yet, since that is the
 * one the edge recipe installs.
 *
 * @param {string} root
 * @returns {string}
 */
export function edgeImportSpecifier(root) {
  /** @type {Record<string, unknown>} */
  let deps = {};
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    deps = { ...pkg.devDependencies, ...pkg.dependencies };
  } catch {
    // No package.json, or not one we can read: the default below is the right guess for both.
  }
  if (!('opengso-prod' in deps) && 'opengso' in deps) return 'opengso/prod/edge';
  return 'opengso-prod/edge';
}

/**
 * Write the module, or the proposal beside a file of the same name that OpenGSO did not write.
 *
 * @param {EdgeDataOptions} options
 * @returns {EdgeDataResult}
 */
export function writeEdgeData(options) {
  const { loaded } = options;
  const target = options.out ? resolve(loaded.root, options.out) : defaultEdgeDataPath(loaded.root);
  const typescript = ['.ts', '.mts', '.cts'].includes(extname(target));
  const importFrom = edgeImportSpecifier(loaded.root);
  const { data, problems } = buildEdgeData(loaded);
  const contents = renderEdgeDataModule(data, { typescript, importFrom });
  const pages = Object.keys(data.manifest.pages).length;
  const bytes = Buffer.byteLength(contents);
  const result = { path: target, target, proposed: false, written: false, unchanged: false, pages, bytes, problems, importFrom };

  // A module with no twins would deploy without complaint and serve no markdown, so an empty read
  // leaves whatever is on disk as it was.
  if (pages === 0) return result;
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  const owned = existing === undefined || OWNED.test(existing);
  if (owned && existing === contents) return { ...result, unchanged: true };
  const written = writeOrPropose(target, contents, owned, options.force === true);
  return { ...result, path: written.path, proposed: written.proposed, written: true };
}

/**
 * After a generate run: rewrite an edge data module this project already has, at either default
 * name, so the edge never serves the twins from before. Only a file OpenGSO wrote, and never a
 * fresh one: a project that does not deploy to the edge gets nothing new in its root.
 *
 * A module at a custom `--out` path is not found here. The build script that names it is what keeps
 * that one current.
 *
 * @param {LoadedConfig} loaded
 * @returns {{ notes: string[]; warnings: string[] }}
 */
export function refreshEdgeData(loaded) {
  /** @type {string[]} */
  const notes = [];
  /** @type {string[]} */
  const warnings = [];
  for (const extension of ['ts', 'js']) {
    const file = join(loaded.root, `${EDGE_DATA_BASENAME}.${extension}`);
    try {
      if (!existsSync(file) || !OWNED.test(readFileSync(file, 'utf8'))) continue;
      const result = writeEdgeData({ loaded, out: file });
      // Not written when nothing was readable (every page failed, say): it keeps the twins it had.
      if (!result.written) continue;
      notes.push(PROD_ERRORS.edgeDataRefreshed(`${EDGE_DATA_BASENAME}.${extension}`, result.pages));
    } catch (error) {
      warnings.push(PROD_ERRORS.edgeDataRefreshFailed(`${EDGE_DATA_BASENAME}.${extension}`, error instanceof Error ? error.message : String(error)));
    }
  }
  return { notes, warnings };
}
