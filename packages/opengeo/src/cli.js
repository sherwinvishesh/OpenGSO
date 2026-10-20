import { readFileSync } from 'node:fs';
import { main } from '@opengeo/core/cli';
import { generateCommand } from '@opengeo/core/cli/commands/generate';
import { prodDataCommand } from '@opengeo/core/cli/commands/prod-data';
import { prodTestCommand } from '@opengeo/core/cli/commands/prod-test';
import { settingsCommand } from '@opengeo/core/cli/commands/settings';
import { startCommand } from '@opengeo/core/cli/commands/start';
import { testCommand } from '@opengeo/core/cli/commands/test';

// Read at run time rather than stamped in at build time. The bundle sits in dist/ and the source in
// src/, both one level below package.json, so the same path works from either.
const pkg = /** @type {{ name: string; version: string }} */ (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
);

await main({
  packageName: pkg.name,
  version: pkg.version,
  commands: {
    test: testCommand,
    generate: generateCommand,
    'prod test': prodTestCommand,
    'prod data': prodDataCommand,
    settings: settingsCommand,
    start: startCommand,
  },
});
