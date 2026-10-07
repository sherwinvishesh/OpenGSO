import { readFileSync } from 'node:fs';
import { main } from '@opengeo/core/cli';
import { testCommand } from '@opengeo/core/cli/commands/test';

// Read at run time rather than stamped in at build time. The bundle sits in dist/ and the source in
// src/, both one level below package.json, so the same path works from either.
const pkg = /** @type {{ name: string; version: string }} */ (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
);

/**
 * opengeo-testing ships one pillar. Asking it for `generate` produces the §13 message naming the
 * package to install, not an "unknown command".
 */
await main({
  packageName: pkg.name,
  version: pkg.version,
  commands: { test: testCommand },
});
