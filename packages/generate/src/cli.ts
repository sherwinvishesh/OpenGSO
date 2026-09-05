import { main } from '@opengeo/core/cli';
import { generateCommand } from '@opengeo/core/cli/commands/generate';

await main({
  packageName: __OPENGEO_PACKAGE__,
  version: __OPENGEO_VERSION__,
  commands: { generate: generateCommand },
});
