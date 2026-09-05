export * from './headers.js';
export * from './middleware.js';
export * from './negotiate.js';
export * from './startup.js';
export * from './store.js';
export * from './verify.js';
export * from './verify-report.js';
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
export type { AiBot, BotKind, CustomBotInput } from '../shared/bots.js';
export { routeToTwinUrlPath, twinUrlPathToRoute, normalizeRoute, isMarkdownPath } from '../shared/routes.js';
