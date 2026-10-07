import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { loadConfig, publicDirPath } from '../shared/config.js';
import { ERRORS } from '../shared/errors.js';
import { ok, bad } from './api-shared.js';

/**
 * @import { ApiOptions, ApiResponse } from './api-shared.js'
 */

/** The route that shows a generated file as it sits on disk. */

// -- generated files -----------------------------------------------------------------------------

/**
 * Show the reader the bytes an agent would receive, straight off disk, with no re-rendering.
 *
 * @param {unknown} body
 * @param {ApiOptions} options
 * @returns {ApiResponse}
 */
export function readFileRoute(body, options) {
  const input = /** @type {{ path?: string }} */ (body ?? {});
  const relative = (input.path ?? '').trim();
  if (!relative) return bad(ERRORS.filePathRequired);
  const content = readGeneratedFile(options.root, relative);
  if (content === undefined) return { status: 404, body: { error: ERRORS.noGeneratedFile(relative) } };
  return ok({ path: relative, content });
}

const GENERATED_FILE = /^(md\/.+\.md|(robots\.txt|llms\.txt|sitemap\.xml)(\.opengeo-proposed)?)$/;

/**
 * Read a generated file so the dashboard can show what is actually on disk.
 *
 * The path comes from a browser, so it is confined to the public directory the same way the static
 * server confines asset paths: resolve first, then refuse anything that did not stay inside. The
 * separator matters - without it, a sibling directory named `public-old` would pass a bare
 * `startsWith`.
 *
 * Staying inside is necessary and not enough. A web root holds whatever the project put there, so
 * on top of it the name has to be one generate writes: a twin under `md/`, or one of the three site
 * files and its proposed copy. No dotfile anywhere in the path, whatever directory it is in.
 *
 * @param {string} root
 * @param {string} relativePath
 * @returns {string | undefined}
 */
export function readGeneratedFile(root, relativePath) {
  if (!GENERATED_FILE.test(relativePath) || relativePath.split('/').some((part) => part.startsWith('.'))) {
    return undefined;
  }
  const loaded = loadConfig(root);
  const base = publicDirPath(loaded);
  const path = resolve(base, relativePath);
  if (path !== base && !path.startsWith(base + sep)) return undefined;
  return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined;
}
