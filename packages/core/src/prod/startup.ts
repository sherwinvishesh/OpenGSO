import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AiBot } from '../shared/bots.js';
import { AI_BOTS } from '../shared/bots.js';
import type { MarkdownStore } from './store.js';

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

export interface StartupStatusOptions {
  root: string;
  publicDir?: string;
  store?: MarkdownStore;
  /** Built-ins plus the project's own crawlers, so the robots.txt summary covers both. */
  bots?: readonly AiBot[];
  /** Injected in tests so the guard and the formatting can be checked without touching stdout. */
  logger?: (line: string) => void;
}

export interface FileStatus {
  name: string;
  found: boolean;
  detail?: string;
}

export interface StartupStatus {
  files: FileStatus[];
  twins: number;
  problems: string[];
  lines: string[];
}

export function buildStartupStatus(options: StartupStatusOptions): StartupStatus {
  const publicDir = resolve(options.root, options.publicDir ?? 'public');
  const files: FileStatus[] = [
    describeRobots(join(publicDir, 'robots.txt'), options.bots),
    describeSimple('llms.txt', join(publicDir, 'llms.txt')),
    describeSimple('sitemap.xml', join(publicDir, 'sitemap.xml')),
  ];

  const twins = options.store?.size ?? 0;
  const problems = options.store?.problems ?? [];
  const lines: string[] = ['[opengeo-prod] startup check'];

  for (const file of files) {
    lines.push(
      file.found
        ? `[opengeo-prod]   ${file.name}: found${file.detail ? ` - ${file.detail}` : ''}`
        : `[opengeo-prod]   ${file.name}: not found - hand-write one, or install opengeo-generate and run \`opengeo generate <url>\``,
    );
  }

  lines.push(`[opengeo-prod]   markdown twins loaded: ${twins}`);
  for (const problem of problems) lines.push(`[opengeo-prod]   ${problem}`);
  if (twins === 0) {
    lines.push('[opengeo-prod]   nothing to serve yet - every request will pass through to the normal site');
  }

  return { files, twins, problems, lines };
}

/** Log the startup status exactly once per process. Repeat calls are no-ops by design. */
export function logStartupStatus(options: StartupStatusOptions): StartupStatus | undefined {
  if (alreadyLogged) return undefined;
  alreadyLogged = true;
  const status = buildStartupStatus(options);
  const log = options.logger ?? ((line: string) => console.log(line));
  for (const line of status.lines) log(line);
  return status;
}

/** Test-only: reset the once-per-process guard. */
export function resetStartupLogForTests(): void {
  alreadyLogged = false;
}

function describeSimple(name: string, path: string): FileStatus {
  return { name, found: existsSync(path) };
}

function describeRobots(path: string, bots?: readonly AiBot[]): FileStatus {
  if (!existsSync(path)) return { name: 'robots.txt', found: false };
  let contents = '';
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return { name: 'robots.txt', found: true, detail: 'could not be read' };
  }
  const { allowed, blocked } = summarizeRobots(contents, bots);
  const parts: string[] = [];
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
 */
export function summarizeRobots(contents: string, bots: readonly AiBot[] = AI_BOTS): { allowed: string[]; blocked: string[] } {
  const groups = parseRobots(contents);
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const bot of bots) {
    const rules = groups.get(bot.robotsToken.toLowerCase()) ?? groups.get('*');
    if (!rules) continue;
    if (rules.some((rule) => rule.type === 'disallow' && rule.path === '/')) blocked.push(bot.name);
    else if (groups.has(bot.robotsToken.toLowerCase())) allowed.push(bot.name);
  }
  return { allowed, blocked };
}

interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
}

export function parseRobots(contents: string): Map<string, RobotsRule[]> {
  const groups = new Map<string, RobotsRule[]>();
  let currentAgents: string[] = [];
  let expectingAgents = true;

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!expectingAgents) {
        currentAgents = [];
        expectingAgents = true;
      }
      currentAgents.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), []);
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      expectingAgents = false;
      for (const agent of currentAgents) {
        const list = groups.get(agent) ?? [];
        list.push({ type: field, path: value });
        groups.set(agent, list);
      }
    }
  }
  return groups;
}
