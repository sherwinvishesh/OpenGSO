import { main } from '@opengeo/core/cli';
import { generateCommand } from '@opengeo/core/cli/commands/generate';
import { prodTestCommand } from '@opengeo/core/cli/commands/prod-test';
import { setupCommand } from '@opengeo/core/cli/commands/setup';
import { testCommand } from '@opengeo/core/cli/commands/test';

await main({
  packageName: __OPENGEO_PACKAGE__,
  version: __OPENGEO_VERSION__,
  commands: { test: testCommand, generate: generateCommand, 'prod test': prodTestCommand, setup: setupCommand },
});
