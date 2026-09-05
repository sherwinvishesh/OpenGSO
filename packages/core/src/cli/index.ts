import type { CommandName } from '../shared/errors.js';
import { COMMAND_BLURB, NARROWEST_PACKAGE, commandUnavailable, unknownCommand } from '../shared/errors.js';
import { c } from '../shared/log.js';

export * from './args.js';
export * from './project.js';

/**
 * The shared CLI (§10, §13).
 *
 * Every published package runs this same function and passes only the handlers it actually ships.
 * A command the install doesn't include is not "unknown" - it produces the §13 message naming the
 * package to add, which is the whole point of shipping narrow packages.
 */

export interface CommandContext {
  /** Argv after the command name, e.g. `['http://localhost:3000', '--json']`. */
  argv: string[];
  packageName: string;
  version: string;
}

export type CommandHandler = (ctx: CommandContext) => Promise<number>;

export interface CliOptions {
  packageName: string;
  version: string;
  commands: Partial<Record<CommandName, CommandHandler>>;
  argv?: string[];
}

const ALL_COMMANDS: CommandName[] = ['test', 'generate', 'prod test', 'setup', 'start'];

export async function runCli(options: CliOptions): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const available = ALL_COMMANDS.filter((name) => options.commands[name]);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(renderHelp(options.packageName, options.version, available));
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${options.packageName} ${options.version}\n`);
    return 0;
  }

  const { command, rest } = matchCommand(argv);
  if (!command) {
    process.stderr.write(`${unknownCommand(argv.join(' '), available)}\n`);
    return 1;
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(renderCommandHelp(command));
    return 0;
  }

  const handler = options.commands[command];
  if (!handler) {
    process.stderr.write(`${commandUnavailable(command, options.packageName)}\n`);
    return 1;
  }

  try {
    return await handler({ argv: rest, packageName: options.packageName, version: options.version });
  } catch (error) {
    process.stderr.write(`${c.red('Error')} ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** `prod test` is the one two-word command, so matching is explicit rather than a prefix search. */
function matchCommand(argv: string[]): { command?: CommandName; rest: string[] } {
  if (argv[0] === 'prod' && argv[1] === 'test') return { command: 'prod test', rest: argv.slice(2) };
  const first = argv[0];
  if (first && (ALL_COMMANDS as string[]).includes(first)) {
    return { command: first as CommandName, rest: argv.slice(1) };
  }
  return { rest: argv.slice(1) };
}

function renderHelp(packageName: string, version: string, available: CommandName[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`${c.bold('OpenGEO')} ${c.gray(`${packageName} ${version}`)}`);
  lines.push(c.gray('Make your site readable by AI agents, and prove it.'));
  lines.push('');
  lines.push(c.bold('Usage'));
  lines.push('  opengeo <command> [options]');
  lines.push('');

  if (available.length > 0) {
    lines.push(c.bold('Commands in this install'));
    const width = Math.max(...available.map((name) => name.length));
    for (const name of available) {
      lines.push(`  ${name.padEnd(width + 2)}${c.gray(COMMAND_BLURB[name])}`);
    }
    lines.push('');
  }

  const missing = ALL_COMMANDS.filter((name) => !available.includes(name));
  if (missing.length > 0) {
    lines.push(c.bold('Not in this install'));
    const width = Math.max(...missing.map((name) => name.length));
    for (const name of missing) {
      // The narrowest package that ships it, not the widest: someone who wants `generate` and has
      // `opengeo-testing` is better served by `opengeo-generate` than by being told to install
      // everything. `commandUnavailable` offers the wider option if they want it.
      lines.push(`  ${c.gray(name.padEnd(width + 2))}${c.gray(`needs ${NARROWEST_PACKAGE[name]}`)}`);
    }
    lines.push('');
  }

  lines.push(c.bold('Global options'));
  lines.push(`  --help, -h      ${c.gray('this message')}`);
  lines.push(`  --version, -v   ${c.gray('print the version')}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Per-command help. Kept here rather than in each command module so `opengeo <cmd> --help` works
 * even in an install that doesn't ship that command - the user gets the flags and the "install X"
 * message, not one or the other.
 */
const COMMAND_HELP: Record<CommandName, string[]> = {
  test: [
    'Usage: opengeo test <url> [options]',
    '',
    'Scores a live URL 0-100 on how readable it is to AI agents, and says exactly what failed.',
    '',
    'Options',
    '  --prompt           print a ready-to-paste fix prompt for your coding agent instead of a report',
    '  --quality          add a separate AI content-quality review (needs a key, never runs in CI)',
    '  --verbose, -v      show why each passing check passed, not just the failures',
    '  --json             machine-readable output',
    '  --out <file>       write the output to a file instead of stdout',
    '  --provider <name>  anthropic | openai | gemini (--quality only)',
    '  --model <name>     model id (--quality only)',
    '  --project <dir>    project directory holding opengeo.config.json (default: cwd)',
    '  --timeout <secs>   per-request timeout (default: 15)',
  ],
  generate: [
    'Usage: opengeo generate <url> [options]',
    '',
    'Crawls the site by following links, writes a Markdown twin for every page, then writes',
    'robots.txt, llms.txt and sitemap.xml from the same crawl.',
    '',
    'Options',
    '  --tier <free|ai>   free is algorithmic and needs no key; ai is bring-your-own-key',
    '  --single           only the URL given, leaving every other page in the manifest alone',
    '  --max-pages <n>    override crawl.maxPages',
    '  --depth <n>        override crawl.maxDepth',
    '  --force            overwrite hand-written robots/llms/sitemap and manual .md files',
    '  --skip-files       twins only, leave robots.txt / llms.txt / sitemap.xml alone',
    '  --provider <name>  anthropic | openai | gemini (AI tier only)',
    '  --model <name>     model id for the AI tier',
    '  --json             machine-readable output',
    '  --project <dir>    project directory holding opengeo.config.json (default: cwd)',
  ],
  'prod test': [
    'Usage: opengeo prod test <url> [options]',
    '',
    'Probes a deployed opengeo-prod middleware four ways - allowed bot UA, ordinary browser UA,',
    'Accept: text/markdown, and an Accept header that excludes both - and reports each separately.',
    '',
    'Options',
    '  --bot <name>       user agent to impersonate (default: ClaudeBot)',
    '  --verbose, -v      show the exact curl and the headers that came back for each probe',
    '  --json             machine-readable output',
    '  --out <file>       write the output to a file instead of stdout',
    '  --project <dir>    project directory holding opengeo.config.json (default: cwd)',
    '  --timeout <secs>   per-request timeout (default: 15)',
  ],
  setup: [
    'Usage: opengeo setup [options]',
    '',
    'Interactive first-run setup: project, site URL, AI provider and key, and the bot lists.',
    'The key is written to .env in your project, and .env is added to .gitignore.',
    '',
    'Options',
    '  --project <dir>    project directory to set up (default: cwd)',
    '  --yes, -y          accept every default without prompting (writes no key)',
  ],
  start: [
    'Usage: opengeo start [options]',
    '',
    'Serves the local OpenGEO dashboard, a GUI over exactly the same functions the CLI calls.',
    'Nothing leaves your machine except the AI provider calls you explicitly trigger.',
    '',
    'Options',
    '  --port, -p <n>     port to listen on (default: 4321)',
    '  --project <dir>    project directory to open (default: cwd)',
    '  --host <addr>      interface to bind (default: 127.0.0.1, loopback only)',
    '  --web <dir>        directory of built dashboard assets (default: beside this binary)',
    '  --no-open          do not open a browser window',
  ],
};

function renderCommandHelp(command: CommandName): string {
  return `\n${COMMAND_HELP[command].join('\n')}\n\n`;
}

/** Entry point wrapper every package's `bin` uses. */
export async function main(options: CliOptions): Promise<void> {
  process.exitCode = await runCli(options);
}
