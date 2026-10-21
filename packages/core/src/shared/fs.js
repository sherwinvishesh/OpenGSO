import { existsSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { ERRORS } from './errors.js';

/**
 * @typedef {object} AtomicWriteOptions
 * @property {number} [mode] The mode a newly created file gets. A file that already exists keeps
 *   the mode it has.
 */

/**
 * Write a whole file or nothing.
 *
 * writeFileSync truncates first and fills after, so a Ctrl-C, a full disk or a crash in between
 * leaves half a manifest or half a `.env`, and the next run reads that as "no manifest" or "no
 * key". The contents go to a temporary name in the same directory and are renamed over the target,
 * which is one step on the same filesystem: a reader sees the old file or the new one.
 *
 * Two things writeFileSync did are kept on purpose. A symlink is written through rather than
 * replaced, and an existing file keeps its mode, so a `.env` its owner locked down stays that way.
 *
 * @param {string} path
 * @param {string} contents
 * @param {AtomicWriteOptions} [options]
 * @returns {void}
 */
export function writeFileAtomic(path, contents, options = {}) {
  const target = existsSync(path) ? realpathSync(path) : path;
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : (options.mode ?? 0o666);
  const temp = join(dir, `.${basename(target)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(temp, contents, { encoding: 'utf8', mode });
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Never created, or already renamed: either way there is nothing left to clean up.
    }
    // The staging name is an implementation detail; the file the caller asked for is the one to name.
    if (error instanceof Error && 'path' in error && error.path === temp) error.path = target;
    throw error;
  }
}

/**
 * A filesystem failure as a sentence, with the path shown the way every report shows paths.
 *
 * Node's own message is `EACCES: permission denied, open '/abs/path/.robots.txt.123.tmp'`, which
 * tells the reader the errno name, the syscall and a staging file, and not which of their folders is
 * in the way. Anything that is not a filesystem error comes back as its own message.
 *
 * @param {unknown} error
 * @param {string} [root] Paths under it are shown relative to it.
 * @returns {string}
 */
export function describeFsError(error, root) {
  if (!(error instanceof Error)) return String(error);
  const { code, path, syscall } = /** @type {{ code?: unknown; path?: unknown; syscall?: unknown }} */ (error);
  if (typeof code !== 'string' || typeof path !== 'string') return error.message;
  // Forward slashes on every platform, as every other report line shows a project path.
  const shown = (/** @type {string} */ p) => (root && p.startsWith(root + sep) ? relative(root, p).split(sep).join('/') : p);
  // `open` is ambiguous and OpenGSO opens far more files to write them than to read them.
  const action = typeof syscall === 'string' && /^(read|stat|scandir|access|realpath)$/.test(syscall) ? 'read' : 'write';
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return ERRORS.fsNoPermission(shown(path), action);
    case 'EEXIST':
    case 'ENOTDIR':
      return ERRORS.fsNotAFolder(shown(fileInTheWay(path)));
    case 'ENOENT':
      return ERRORS.fsMissing(shown(path));
    case 'ENOSPC':
      return ERRORS.fsDiskFull(shown(path));
    case 'EROFS':
      return ERRORS.fsReadOnly(shown(path));
    case 'EMFILE':
    case 'ENFILE':
      return ERRORS.fsTooManyOpen(shown(path));
    default:
      return error.message;
  }
}

/**
 * The nearest existing ancestor of a path that is a file, which is what blocks a mkdir below it.
 * `mkdir public/md` fails on `public/md` itself; `mkdir x/.opengso` fails on `x` when `x` is a file.
 *
 * @param {string} path
 * @returns {string}
 */
function fileInTheWay(path) {
  let current = path;
  for (;;) {
    try {
      if (statSync(current).isFile()) return current;
    } catch {
      // Does not exist yet: look one level up.
    }
    const parent = dirname(current);
    if (parent === current) return path;
    current = parent;
  }
}
