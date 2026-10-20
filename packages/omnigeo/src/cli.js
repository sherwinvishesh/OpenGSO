import { readFileSync } from 'node:fs';
import { main } from '@omnigeo/core/cli';
import { generateCommand } from '@omnigeo/core/cli/commands/generate';
import { prodDataCommand } from '@omnigeo/core/cli/commands/prod-data';
import { prodTestCommand } from '@omnigeo/core/cli/commands/prod-test';
import { settingsCommand } from '@omnigeo/core/cli/commands/settings';
import { startCommand } from '@omnigeo/core/cli/commands/start';
import { testCommand } from '@omnigeo/core/cli/commands/test';

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
