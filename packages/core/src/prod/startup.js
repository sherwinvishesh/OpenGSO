import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AI_BOTS, routedSearchCrawlers } from '../shared/bots.js';
import { CONFIG_ERRORS } from '../shared/errors.js';
import { parseRobots, robotsAllows, robotsRulesFor } from '../shared/robots.js';

// Still exported from here, as opengso-prod always has; the one implementation lives in shared/.
export { parseRobots, robotsAllows, robotsRulesFor };

/**
 * @import { AiBot } from '../shared/bots.js'
 * @import { MarkdownStore } from './store.js'
 * @import { LoadedConfig } from '../shared/config.js'
 */

/**
 * Startup-only status logging (§7).
 *
 * Runs once, at boot, and never again - a per-request version of this would flood a production log
 * with the same three lines forever. The output is meant to be read in the hosting platform's own
 * deploy log (Vercel, Netlify, and similar), so a user can confirm the setup with no extra tooling.
 *
 * prod only ever *reads* these files. generate owns writing them, exclusively.
 */

let alreadyLogged = false;

/**
 * @typedef {object} StartupStatusOptions
 * @property {string} root
 * @property {string} [publicDir]
 * @property {MarkdownStore} [store]
 * @property {readonly AiBot[]} [bots] Built-ins plus the project's own crawlers, so the robots.txt
 *   summary covers both.
 * @property {readonly string[]} [routing] `bots.markdownRouting`, checked for search crawlers.
 * @property {LoadedConfig['unknownKeys']} [unknownKeys] Keys in the config nothing reads, each said
 *   once, since a misspelt `bots.markdownrouting` otherwise serves the defaults without a word.
 * @property {(line: string) => void} [logger] Injected in tests so the guard and the formatting can
 *   be checked without touching stdout.
 * @property {string} [heading] The first line, for a development server reporting a reload rather
 *   than a boot.
 */

/**
 * @typedef {object} FileStatus
 * @property {string} name
 * @property {boolean} found
 * @property {string} [detail]
 */

/**
 * @typedef {object} StartupStatus
 * @property {FileStatus[]} files
 * @property {number} twins
 * @property {string[]} problems
 * @property {string[]} lines
 */

/**
 * @param {StartupStatusOptions} options
 * @returns {StartupStatus}
 */
export function buildStartupStatus(options) {
  const publicDir = resolve(options.root, options.publicDir ?? 'public');
  /** @type {FileStatus[]} */
  const files = [
    describeRobots(join(publicDir, 'robots.txt'), options.bots),
    describeSimple('llms.txt', join(publicDir, 'llms.txt')),
    describeSimple('sitemap.xml', join(publicDir, 'sitemap.xml')),
  ];

  const twins = options.store?.size ?? 0;
  const problems = options.store?.problems ?? [];
  /** @type {string[]} */
  const lines = [`[opengso-prod] ${options.heading ?? 'startup check'}`];

  for (const file of files) {
    lines.push(
      file.found
        ? `[opengso-prod]   ${file.name}: found${file.detail ? ` - ${file.detail}` : ''}`
        : `[opengso-prod]   ${file.name}: not found - hand-write one, or install opengso-generate and run \`opengso generate <url>\``,
    );
  }

  lines.push(`[opengso-prod]   markdown twins loaded: ${twins}`);
  for (const problem of problems) lines.push(`[opengso-prod]   ${problem}`);
  const search = routedSearchCrawlers(options.routing ?? [], options.bots);
  if (search.length > 0) lines.push(`[opengso-prod]   ${CONFIG_ERRORS.searchCrawlersRouted(search)}`);
  for (const { key, suggestion } of options.unknownKeys ?? []) lines.push(`[opengso-prod]   ${CONFIG_ERRORS.unknownConfigKey(key, suggestion)}`);
  if (twins === 0) {
    lines.push('[opengso-prod]   nothing to serve yet - every request will pass through to the normal site');
  }

  return { files, twins, problems, lines };
}

/**
 * Log the startup status exactly once per process. Repeat calls are no-ops by design.
 *
 * @param {StartupStatusOptions} options
 * @returns {StartupStatus | undefined}
 */
export function logStartupStatus(options) {
  if (alreadyLogged) return undefined;
  alreadyLogged = true;
  const status = buildStartupStatus(options);
  const log = options.logger ?? ((/** @type {string} */ line) => console.log(line));
  for (const line of status.lines) log(line);
  return status;
}

/**
 * Log the status again after a development server reloaded the twins. Not guarded: it only runs when
 * something on disk changed, which is exactly when the person running the server wants to see it.
 *
 * @param {StartupStatusOptions} options
 * @returns {StartupStatus}
 */
export function logReloadStatus(options) {
  const status = buildStartupStatus({ heading: 'reloaded after a change on disk', ...options });
  const log = options.logger ?? ((/** @type {string} */ line) => console.log(line));
  for (const line of status.lines) log(line);
  return status;
}

/**
 * Test-only: reset the once-per-process guard.
 *
 * @returns {void}
 */
export function resetStartupLogForTests() {
  alreadyLogged = false;
}

/**
 * @param {string} name
 * @param {string} path
 * @returns {FileStatus}
 */
function describeSimple(name, path) {
  return { name, found: existsSync(path) };
}

/**
 * @param {string} path
 * @param {readonly AiBot[]} [bots]
 * @returns {FileStatus}
 */
function describeRobots(path, bots) {
  if (!existsSync(path)) return { name: 'robots.txt', found: false };
  let contents = '';
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return { name: 'robots.txt', found: true, detail: 'could not be read' };
  }
  const { allowed, blocked } = summarizeRobots(contents, bots);
  /** @type {string[]} */
  const parts = [];
  parts.push(blocked.length > 0 ? `blocking ${blocked.join(', ')}` : 'blocking no AI bots');
  if (allowed.length > 0) parts.push(`explicitly allowing ${allowed.length} AI bot${allowed.length === 1 ? '' : 's'}`);
  return { name: 'robots.txt', found: true, detail: parts.join('; ') };
}

/**
 * Which known AI bots a robots.txt currently allows or disallows at the site root.
 *
 * `bots` widens "known" to include the project's own `bots.custom` entries, so a custom crawler
 * named in `bots.blocked` shows up in the boot log and in `prod test` rather than being silently
 * absent from a summary that claims to be complete.
 *
 * @param {string} contents
 * @param {readonly AiBot[]} [bots]
 * @returns {{ allowed: string[]; blocked: string[] }}
 */
export function summarizeRobots(contents, bots = AI_BOTS) {
  const groups = parseRobots(contents);
  /** @type {string[]} */
  const allowed = [];
  /** @type {string[]} */
  const blocked = [];
  for (const bot of bots) {
    const rules = robotsRulesFor(groups, bot.robotsToken);
    if (!rules) continue;
    if (!robotsAllows(rules, '/')) blocked.push(bot.name);
    else if (groups.has(bot.robotsToken.toLowerCase())) allowed.push(bot.name);
  }
  return { allowed, blocked };
}
