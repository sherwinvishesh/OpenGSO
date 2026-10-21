#!/usr/bin/env node
/**
 * Every action a workflow uses is pinned to a commit.
 *
 * `uses: actions/checkout@v6` trusts whoever can move the `v6` tag, and moved tags have shipped
 * compromised actions before. A 40-character commit cannot be moved. The release it belongs to goes
 * in a comment after it, so a reader knows what the commit is and Dependabot knows what to update:
 * it moves the commit and the comment together.
 */
import { readdirSync, readFileSync } from 'node:fs';

const workflows = new URL('../.github/workflows/', import.meta.url);
const USES = /^\s*-?\s*uses:\s*["']?([^\s"'#]+)["']?\s*(#.*)?$/;
const PINNED = /^[^@]+@[0-9a-f]{40}$/;
const RELEASE = /^#\s*v\d+\.\d+\.\d+(?:\s|$)/;

/** @type {string[]} */
const failures = [];
let pinned = 0;
const files = readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name)).sort();
for (const file of files) {
  readFileSync(new URL(file, workflows), 'utf8').split('\n').forEach((line, index) => {
    const match = USES.exec(line);
    if (!match) return;
    const [, action, comment = ''] = match;
    // An action in this repository, or a container image: neither has a commit to pin.
    if (action.startsWith('./') || action.startsWith('docker://')) return;
    const where = `${file}:${index + 1}`;
    if (!PINNED.test(action)) failures.push(`${where}: ${action} is not pinned to a commit`);
    else if (!RELEASE.test(comment.trim())) failures.push(`${where}: ${action} needs the release after the commit, as "# v1.2.3"`);
    else pinned += 1;
  });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log(`ok  ${pinned} actions pinned to a commit across ${files.length} workflows`);
