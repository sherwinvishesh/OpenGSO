import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_PACKAGES } from '../shared/errors.js';

/** @import { CommandName } from '../shared/errors.js' */

/**
 * Every OpenGSO package installs the same `opengso` bin. Two of them in one project, which is what
 * the README recommends (the narrowest tool as a dev dependency, opengso-prod for the server), both
 * claim node_modules/.bin/opengso, and npm links whichever it installed last without a word. A
 * `test` typed at a tree where opengso-prod won the link used to answer "install opengso-cli" to
 * someone who had.
 *
 * So before giving that answer, the CLI looks for a sibling that ships the command and runs that
 * sibling's bin in its place. The handover is silent: a `--json` run through the wrong bin has to
 * be byte-identical to one through the right one.
 *
 * The lookup walks up from where the running bin is installed, and from nowhere else: the packages
 * it can find are exactly the ones that bin could import by name, so nothing runs that was not
 * already in its path. The directory the command was typed in is deliberately not searched. A
 * global `opengso` run inside a checkout would otherwise execute whatever that checkout's
 * `node_modules` holds, and the user typed a global command precisely so that it would not.
 */

/**
 * Set in the sibling's environment so that it answers the command itself or prints the §13 message,
 * and never hands it back.
 */
export const DELEGATED_VARIABLE = 'OPENGSO_DELEGATED';

/**
 * @typedef {object} Sibling
 * @property {string} name
 * @property {string} version
 * @property {string} bin Absolute path of its `opengso` bin script.
 */

/**
 * Where a lookup starts from: the directory this bin lives in, which after bundling is the
 * package's own `dist/`. Never the current directory (see above).
 *
 * @returns {string[]}
 */
export function defaultSiblingRoots() {
  return [dirname(fileURLToPath(import.meta.url))];
}

/**
 * The first installed package, other than the one asking, that ships `command`. Each root is
 * searched the way Node resolves a bare specifier: every ancestor's `node_modules`, nearest first.
 * That is what finds a sibling through pnpm's `.pnpm/<name>/node_modules/<name>` layout and a
 * hoisted workspace as well as a flat install.
 *
 * @param {CommandName} command
 * @param {object} [options]
 * @param {string[]} [options.roots] Directories to walk up from, in order of preference.
 * @param {string} [options.self] The package asking, which is never its own sibling.
 * @returns {Sibling | undefined}
 */
export function findSibling(command, { roots = defaultSiblingRoots(), self } = {}) {
  const candidates = COMMAND_PACKAGES[command].filter((name) => name !== self);
  for (const root of roots) {
    for (const dir of ancestors(resolve(root))) {
      for (const name of candidates) {
        const sibling = readSibling(packageDir(dir, name));
        if (sibling) return sibling;
      }
    }
  }
  return undefined;
}

/**
 * Runs the sibling's bin with the same arguments and the same terminal, and answers with its exit
 * code. A child process rather than an import: the bin sets `process.exitCode` as a side effect of
 * being loaded, and a separate process is the only way to get that code back, and the only way its
 * raw-mode terminal handling stays its own.
 *
 * @param {Sibling} sibling
 * @param {string[]} argv The full command line, command words included.
 * @returns {number}
 */
export function runSibling(sibling, argv) {
  const result = spawnSync(process.execPath, [sibling.bin, ...argv], {
    stdio: 'inherit',
    env: { ...process.env, [DELEGATED_VARIABLE]: '1' },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function ancestors(dir) {
  const out = [];
  for (let current = dir; ; current = dirname(current)) {
    out.push(current);
    if (dirname(current) === current) return out;
  }
}

/**
 * Where `name` would be installed relative to one ancestor. Inside a `node_modules` directory the
 * package sits directly in it, which is where the walk from a bin's own location passes through.
 *
 * @param {string} dir
 * @param {string} name
 * @returns {string}
 */
function packageDir(dir, name) {
  return basename(dir) === 'node_modules' ? join(dir, name) : join(dir, 'node_modules', name);
}

/**
 * @param {string} dir
 * @returns {Sibling | undefined}
 */
function readSibling(dir) {
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return undefined;
  /** @type {{ name?: unknown; version?: unknown; bin?: unknown }} */
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch {
    return undefined;
  }
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && typeof pkg.bin === 'object' ? /** @type {Record<string, unknown>} */ (pkg.bin).opengso : undefined;
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string' || typeof bin !== 'string') return undefined;
  // The script has to be inside the package, the same rule npm applies before linking a bin.
  const script = resolve(dir, bin);
  if (!script.startsWith(resolve(dir) + sep)) return undefined;
  return existsSync(script) ? { name: pkg.name, version: pkg.version, bin: script } : undefined;
}
