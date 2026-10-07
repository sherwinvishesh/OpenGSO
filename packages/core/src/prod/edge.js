/**
 * The fs-free runtime entry, for edge runtimes and anywhere else without a disk (§7).
 *
 * Everything here is pure: no `node:` import anywhere in its graph, because an edge bundler rejects
 * one even when the code using it is never called. The Node entry (`index.js`) is this plus the
 * pieces that read the disk: `createFsStore` and the startup log.
 */
export * from './headers.js';
export * from './middleware.js';
export * from './negotiate.js';
export * from './manifest-store.js';
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
