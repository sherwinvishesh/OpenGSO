import { readFileSync } from 'node:fs';
import { main } from '@opengso/core/cli';
import { prodDataCommand } from '@opengso/core/cli/commands/prod-data';
import { prodTestCommand } from '@opengso/core/cli/commands/prod-test';

/**
 * opengso-prod ships the runtime middleware and the two commands that go with it: the verifier, and
 * the edge data writer.
 * There is no generate here and no key, so `opengso generate` produces the §13 message naming the
 * package to install rather than an "unknown command".
 */
// Read at run time rather than stamped in at build time. The bundle sits in dist/ and the source in
// src/, both one level below package.json, so the same path works from either.
const pkg = /** @type {{ name: string; version: string }} */ (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
);

await main({
  packageName: pkg.name,
  version: pkg.version,
  commands: { 'prod test': prodTestCommand, 'prod data': prodDataCommand },
});
