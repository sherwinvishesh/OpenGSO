import { main } from '@opengeo/core/cli';
import { testCommand } from '@opengeo/core/cli/commands/test';

/**
 * opengeo-testing ships one pillar. Asking it for `generate` produces the §13 message naming the
 * package to install, not an "unknown command".
 */
await main({
  packageName: __OPENGEO_PACKAGE__,
  version: __OPENGEO_VERSION__,
  commands: { test: testCommand },
});
