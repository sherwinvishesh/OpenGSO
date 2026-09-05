import { main } from '@opengeo/core/cli';
import { prodTestCommand } from '@opengeo/core/cli/commands/prod-test';

/**
 * opengeo-prod ships the runtime middleware and exactly one command: the verifier for it.
 * There is no generate here and no key, so `opengeo generate` produces the §13 message naming the
 * package to install rather than an "unknown command".
 */
await main({
  packageName: __OPENGEO_PACKAGE__,
  version: __OPENGEO_VERSION__,
  commands: { 'prod test': prodTestCommand },
});
