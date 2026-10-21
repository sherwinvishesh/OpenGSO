/**
 * Points git at the hooks in .githooks/ when the repository is installed, so a commit runs them.
 *
 * `npm install` runs this as the root `prepare` script. It does nothing outside a git checkout
 * (a tarball of the repository, or no git on the machine), and nothing it does is load-bearing:
 * `git commit --no-verify` skips the hooks for one commit, and
 * `git config --unset core.hooksPath` switches them off.
 */
import { execFileSync } from 'node:child_process';

try {
  const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  if (inside === 'true') execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch {
  // Not a checkout, or no git: there is nowhere to install a hook.
}
