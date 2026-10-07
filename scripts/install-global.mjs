/**
 * Builds `opengeo` and installs it globally, so `opengeo <command>` works in any directory.
 *
 * A tarball install rather than `npm link`, because it exercises the exact artifact a user would
 * get from the registry: the `files` list, the `bin` entry, the real dependency tree, and the
 * dashboard under web/. A symlink would quietly paper over a mistake in any of those.
 *
 * The cost is that the global copy is a snapshot, so re-run this after changing anything the CLI
 * or dashboard ships. That is the whole reason it is one command.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `.pathname` keeps percent-escapes and a leading slash before a drive letter, so a checkout under a
// path with a space, or any checkout on Windows, would hand npm a directory that does not exist.
const root = fileURLToPath(new URL('..', import.meta.url));
const run = (args) => execFileSync('npm', args, { cwd: root, stdio: 'inherit' });

const skipBuild = process.argv.includes('--no-build');
if (!skipBuild) run(['run', 'build']);

const dir = mkdtempSync(join(tmpdir(), 'opengeo-pack-'));
try {
  run(['pack', '--workspace', 'packages/opengeo', '--pack-destination', dir, '--silent']);
  const tarball = readdirSync(dir).find((name) => name.endsWith('.tgz'));
  if (!tarball) throw new Error(`npm pack wrote nothing to ${dir}`);
  run(['install', '-g', join(dir, tarball)]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// Resolved from the npm prefix rather than `which`, because npm puts the workspace's own
// node_modules/.bin at the front of PATH for scripts, and that is not the copy just installed.
const prefix = execFileSync('npm', ['prefix', '-g']).toString().trim();
const where = join(prefix, 'bin', 'opengeo');
const version = execFileSync(where, ['--version']).toString().trim();
console.log(`\n  ${version} installed at ${where}`);
console.log(`  Try: opengeo --help\n`);
