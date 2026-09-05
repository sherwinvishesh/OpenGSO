import { main } from '@opengeo/core/cli';
import { generateCommand } from '@opengeo/core/cli/commands/generate';
import { testCommand } from '@opengeo/core/cli/commands/test';

await main({
  packageName: __OPENGEO_PACKAGE__,
  version: __OPENGEO_VERSION__,
  commands: { test: testCommand, generate: generateCommand },
});
