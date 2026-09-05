import type { CommandName } from '../shared/errors.js';
import { COMMAND_BLURB, COMMAND_PACKAGES, commandUnavailable, unknownCommand } from '../shared/errors.js';
import { c } from '../shared/log.js';

export * from './args.js';
export * from './project.js';

/**
 * The shared CLI (idea.md §10, §13).
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
      const suggestion = COMMAND_PACKAGES[name].filter((pkg) => pkg !== packageName)[0];
      lines.push(`  ${c.gray(name.padEnd(width + 2))}${c.gray(`needs ${suggestion}`)}`);
    }
    lines.push('');
  }

  lines.push(c.bold('Global options'));
  lines.push(`  --help, -h      ${c.gray('this message')}`);
  lines.push(`  --version, -v   ${c.gray('print the version')}`);
  lines.push('');
  return lines.join('\n');
}

/** Entry point wrapper every package's `bin` uses. */
export async function main(options: CliOptions): Promise<void> {
  process.exitCode = await runCli(options);
}
