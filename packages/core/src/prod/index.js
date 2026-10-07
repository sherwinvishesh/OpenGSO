export * from './headers.js';
export * from './middleware.js';
export * from './negotiate.js';
// The runtime entry is what a server imports on every boot, so it carries the middleware and
// nothing else. Deployment verification (`verify.js`, `verify-report.js`) makes network calls and
// paints a terminal, and lives behind the `prod test` command, which imports it directly. The
// startup module is named rather than starred so its test hook stays out of the public API.
export { buildStartupStatus, logStartupStatus } from './startup.js';
/**
 * @typedef {import('./startup.js').StartupStatus} StartupStatus
 * @typedef {import('./startup.js').StartupStatusOptions} StartupStatusOptions
 * @typedef {import('./startup.js').FileStatus} FileStatus
 */
export * from './store.js';
export { AEO_SPEC_VERSION, HEADERS, MARKDOWN_CONTENT_TYPE } from '../shared/version.js';
// `resolveBots` is part of the public surface because a hand-wired middleware has to build the
// same list the Next adapter builds: the shipped crawlers plus whatever the project put in
// `bots.custom`. Without it, a custom crawler would only ever work on Next.
export {
  AI_BOTS,
  ROUTABLE_BOTS,
  DEFAULT_MARKDOWN_ROUTING,
  identifyBot,
  findBot,
  resolveBots,
  resolveRoutableBots,
} from '../shared/bots.js';
/**
 * @typedef {import('../shared/bots.js').AiBot} AiBot
 * @typedef {import('../shared/bots.js').BotKind} BotKind
 * @typedef {import('../shared/bots.js').CustomBotInput} CustomBotInput
 */
export { routeToTwinUrlPath, twinUrlPathToRoute, normalizeRoute, isMarkdownPath } from '../shared/routes.js';
