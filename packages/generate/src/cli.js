import { readFileSync } from 'node:fs';
import { main } from '@omnigeo/core/cli';
import { generateCommand } from '@omnigeo/core/cli/commands/generate';

// Read at run time rather than stamped in at build time. The bundle sits in dist/ and the source in
// src/, both one level below package.json, so the same path works from either.
const pkg = /** @type {{ name: string; version: string }} */ (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
);

await main({
  packageName: pkg.name,
  version: pkg.version,
  commands: { generate: generateCommand },
});
