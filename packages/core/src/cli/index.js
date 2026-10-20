import { COMMAND_BLURB, NARROWEST_PACKAGE, commandUnavailable, unknownCommand } from '../shared/errors.js';
import { c, cErr } from '../shared/log.js';
import { PROVIDERS } from '../shared/providers.js';
import { wrap } from '../shared/render/paint.js';
import { EXIT_USAGE, UsageError } from './args.js';
import { runHome } from './home.js';

/** @import { CommandName } from '../shared/errors.js' */

export * from './args.js';
export * from './project.js';

/**
 * The shared CLI (§10, §13).
 *
 * Every published package runs this same function and passes only the handlers it actually ships.
 * A command the install doesn't include is not "unknown" - it produces the §13 message naming the
 * package to add, which is the whole point of shipping narrow packages.
 */

/**
 * @typedef {object} CommandContext
 * @property {string[]} argv Argv after the command name, e.g. `['http://localhost:3000', '--json']`.
 * @property {string} packageName
 * @property {string} version
 */

/** @typedef {(ctx: CommandContext) => Promise<number>} CommandHandler */

/**
 * @typedef {object} CliOptions
 * @property {string} packageName
 * @property {string} version
 * @property {Partial<Record<CommandName, CommandHandler>>} commands
 * @property {string[]} [argv]
 */

/** @type {CommandName[]} */
const ALL_COMMANDS = ['test', 'generate', 'prod test', 'settings', 'start'];

/**
 * `setup` was the name until the flow split into `start` (set up, then open the dashboard) and
 * `settings` (change something later). It stays as an alias forever: it is in every README written
 * before the rename, and a renamed command that answers "unknown command" is just a broken link.
 *
 * @type {Record<string, CommandName>}
 */
const ALIASES = { setup: 'settings' };

/**
 * @param {CliOptions} options
 * @returns {Promise<number>}
 */
export async function runCli(options) {
  const argv = options.argv ?? process.argv.slice(2);
  const available = ALL_COMMANDS.filter((name) => options.commands[name]);

  // `opengeo help providers` and `opengeo providers` are the same page. It is a help topic rather
  // than a command because every install has AI providers available to configure, including the
  // ones that ship no AI-using command at all.
  if (argv[0] === 'providers' || (argv[0] === 'help' && argv[1] === 'providers')) {
    process.stdout.write(renderProvidersHelp());
    return 0;
  }
  // A bare `opengeo` opens the home screen, because the first thing a person types after installing
  // is the name of the thing they installed, and answering that with a wall of flags wastes the one
  // moment they are most willing to be shown around. It reads the project, says where it stands and
  // offers the things there are to do. `opengeo start` still goes straight to the dashboard, so
  // nothing written before this exists has changed meaning.
  //
  // `runHome` returns -1 when there is nobody to ask - a pipe, a script, `opengeo | head` - and the
  // help page below is the right answer there, exactly as it was.
  if (argv.length === 0 && available.length > 0) {
    const code = await runHome({
      packageName: options.packageName,
      version: options.version,
      commands: options.commands,
    });
    if (code >= 0) return code;
  }
  // `opengeo help test` is how a lot of people ask for `opengeo test --help`, and answering it with
  // the global page makes them go looking for the flags all over again.
  if (argv[0] === 'help' && argv.length > 1) {
    const { command } = matchCommand(argv.slice(1));
    if (!command) {
      process.stderr.write(`${unknownCommand(argv.slice(1).join(' '), available)}\n`);
      return EXIT_USAGE;
    }
    process.stdout.write(renderCommandHelp(command));
    return 0;
  }
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
    return EXIT_USAGE;
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(renderCommandHelp(command));
    return 0;
  }

  const handler = options.commands[command];
  if (!handler) {
    process.stderr.write(`${commandUnavailable(command, options.packageName)}\n`);
    return EXIT_USAGE;
  }

  try {
    return await handler({ argv: rest, packageName: options.packageName, version: options.version });
  } catch (error) {
    process.stderr.write(`${cErr.red('Error')} ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? EXIT_USAGE : 1;
  }
}

/**
 * `prod test` is the one two-word command, so matching is explicit rather than a prefix search.
 *
 * @param {string[]} argv
 * @returns {{ command?: CommandName; rest: string[] }}
 */
function matchCommand(argv) {
  if (argv[0] === 'prod' && argv[1] === 'test') return { command: 'prod test', rest: argv.slice(2) };
  const first = argv[0];
  if (first && /** @type {string[]} */ (ALL_COMMANDS).includes(first)) {
    return { command: /** @type {CommandName} */ (first), rest: argv.slice(1) };
  }
  if (first && ALIASES[first]) return { command: ALIASES[first], rest: argv.slice(1) };
  return { rest: argv.slice(1) };
}

/**
 * @param {string} packageName
 * @param {string} version
 * @param {CommandName[]} available
 * @returns {string}
 */
function renderHelp(packageName, version, available) {
  /** @type {string[]} */
  const lines = [];
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
  lines.push(c.bold('Exit codes'));
  lines.push(`  0   ${c.gray('done, and nothing failed')}`);
  lines.push(`  1   ${c.gray('a check failed, or the command could not finish')}`);
  lines.push(`  2   ${c.gray('the command line was wrong: unknown command or option, missing or bad value, no URL')}`);
  lines.push('');
  lines.push(c.bold('Help topics'));
  lines.push(`  opengeo help providers   ${c.gray('every AI tool OpenGEO can use, and how to add your own')}`);
  lines.push(`  opengeo help <command>   ${c.gray('the options for one command, same as <command> --help')}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * The AI provider page.
 *
 * It exists because "which AI tools does this work with" and "can I use mine" are the two questions
 * that decide whether someone can use the AI features at all, and neither should require reading
 * the source or a website. The answer to the second is always yes, and the steps are here.
 *
 * @returns {string}
 */
export function renderProvidersHelp() {
  /** @type {string[]} */
  const lines = [];
  const width = Math.max(...PROVIDERS.map((provider) => provider.id.length)) + 2;
  // Measured, not guessed: two labels in the table are long enough to swallow the gap before the
  // note when the column is a fixed number.
  const labelWidth = Math.max(...PROVIDERS.map((provider) => provider.label.length)) + 2;

  lines.push('');
  lines.push(`${c.bold('AI providers')} ${c.gray('used by `opengeo generate --tier ai` and `opengeo test --content`')}`);
  lines.push('');
  lines.push(c.gray('Everything else - the 0-100 structural score, the free generate tier, and the'));
  lines.push(c.gray('middleware - never needs a key.'));
  lines.push('');

  for (const provider of PROVIDERS) {
    const note = provider.keyless
      ? c.green('no key needed')
      : provider.userDefined
        ? c.cyan('your own endpoint')
        : c.gray(provider.envVars[0] ?? '');
    lines.push(`  ${c.bold(provider.id.padEnd(width))}${provider.label.padEnd(labelWidth)}${note}`);
    lines.push(`  ${' '.repeat(width)}${c.gray(`${provider.defaultModel || 'model of your choice'}${provider.keysUrl ? `  ${provider.keysUrl}` : ''}`)}`);
    // The one thing about this provider that would otherwise be learned from a failed run.
    if (provider.note) for (const line of wrap(provider.note, 92 - width)) lines.push(`  ${' '.repeat(width)}${c.dim(line)}`);
  }

  lines.push('');
  lines.push(c.bold('Pick one'));
  lines.push('  opengeo settings                         ' + c.gray('asks, and writes .env for you'));
  lines.push('  OPENGEO_PROVIDER=xai OPENGEO_API_KEY=... ' + c.gray('or set it yourself in .env'));
  lines.push('  opengeo test <url> --content --provider groq --model openai/gpt-oss-20b');
  lines.push('');

  lines.push(c.bold('Add your own AI tool'));
  lines.push(c.gray('  OpenGEO dispatches on the wire format, not the brand, so anything that speaks the'));
  lines.push(c.gray('  OpenAI, Anthropic or Gemini API is already supported. Three steps:'));
  lines.push('');
  lines.push(`  ${c.bold('1.')} Find your endpoint's base URL and which of the three shapes it speaks.`);
  lines.push(`     ${c.gray('Almost every vendor and gateway is OpenAI-shaped: it has /chat/completions.')}`);
  lines.push(`  ${c.bold('2.')} Put it in opengeo.config.json:`);
  lines.push('');
  lines.push(c.gray('       "ai": {'));
  lines.push(c.gray('         "provider": "custom",'));
  lines.push(c.gray('         "model": "the model id your endpoint expects",'));
  lines.push(c.gray('         "baseUrl": "https://your-endpoint.example.com/v1",'));
  lines.push(c.gray('         "api": "openai",'));
  lines.push(c.gray('         "auth": "bearer",'));
  lines.push(c.gray('         "headers": { "x-tenant": "acme" }'));
  lines.push(c.gray('       }'));
  lines.push('');
  lines.push(`  ${c.bold('3.')} Put the key in .env as OPENGEO_API_KEY, the way every other provider does.`);
  lines.push('');
  lines.push(c.gray('  "auth" is optional and defaults to bearer. Use "none" for a local server with no'));
  lines.push(c.gray('  key. "headers" is optional and is for things a gateway needs, never for the key.'));
  lines.push('');
  lines.push(c.gray('  The same fields work on a built-in provider, which is how you point OpenGEO at a'));
  lines.push(c.gray('  company mirror of a vendor API without giving up the vendor default model.'));
  lines.push('');
  lines.push(c.bold('Thinking, and other request flags'));
  lines.push(c.gray('  A rewrite is not a reasoning job, so on each default model that thinks, OpenGEO turns'));
  lines.push(c.gray('  it off or as low as that model allows.'));
  lines.push(c.gray('  "params" in the "ai" block adds fields of your own to every request body, such as'));
  lines.push(c.gray('  { "temperature": 0.2 }, and a null removes one OpenGEO would have sent.'));
  lines.push('');
  lines.push(c.gray('  `opengeo settings` asks all of this if you would rather answer questions, and the'));
  lines.push(c.gray('  dashboard has the same fields under Settings.'));
  lines.push('');
  return lines.join('\n');
}

/**
 * Per-command help. Kept here rather than in each command module so `opengeo <cmd> --help` works
 * even in an install that doesn't ship that command - the user gets the flags and the "install X"
 * message, not one or the other.
 *
 * @type {Record<CommandName, string[]>}
 */
const COMMAND_HELP = {
  test: [
    'Usage: opengeo test <url> [options]',
    '',
    'Scores a live URL 0-100 on how readable it is to AI agents, and says exactly what failed.',
    '',
    'Two passes, and you choose how many of them run.',
    '',
    '  structure   the 22 deterministic checks. Free, no key. Seven of them make the 0-100',
    '              score; the other fifteen are suggestions, counted as "N of 15 adopted".',
    '  content     an AI review of every Markdown document the site serves: is the product',
    '              defined, are the right keywords there, is it specific, could an agent',
    '              answer a question from it. Needs a key. Never touches the score.',
    '',
    'By default it runs both, in that order - the structural pass is what finds the documents',
    'the content pass reviews. With no key configured it runs the structural pass and says so.',
    '',
    'Modes',
    '  (default)          structure, then content if a key is configured',
    '  --structure        structure only. --offline and -nq mean the same thing.',
    '  --content          content only, for when you are editing the Markdown itself',
    '  --quality, -q      require the content pass: fail instead of skipping when no key',
    '',
    'Options',
    '  --prompt           print a ready-to-paste fix prompt for your coding agent instead of a report',
    '  --strict           fail the build on a suggestion that fails too, not only on a scored check',
    '  --max-docs <n>     how many documents the content pass reviews (default: 10)',
    '  --verbose, -v      show why each passing check passed, not just the failures',
    '  --json             machine-readable output',
    '  --out <file>       write the output to a file instead of stdout',
    "  --provider <name>  which AI tool to review with. `opengeo help providers` lists them all.",
    '  --model <name>     model id (content pass only)',
    '  --project <dir>    project directory holding opengeo.config.json (default: cwd)',
    '  --timeout <secs>   per-request timeout (default: 15)',
    '',
    'The exit code always comes from the structural checks. A model\'s opinion never fails a build.',
    'It is 1 when a scored check fails (or, with --strict, any check), and 2 when the command line',
    'itself is wrong. A partial never fails a build on its own.',
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
    '  --force            overwrite hand-written robots/llms/sitemap and .md files',
    '  --skip-files       twins only, leave robots.txt / llms.txt / sitemap.xml alone',
    '  --prune            delete orphaned twins: ones OpenGEO wrote for pages this crawl no longer',
    '                     found. Without it they are only reported. Never deletes a file OpenGEO',
    '                     did not write, and refuses on a run that hit a crawl cap or reached no page.',
    "  --provider <name>  which AI tool to use. `opengeo help providers` lists them all.",
    '  --model <name>     model id for the AI tier',
    '  --json             machine-readable output',
    '  --project <dir>    project directory holding opengeo.config.json (default: cwd)',
  ],
  'prod test': [
    'Usage: opengeo prod test <url> [options]',
    '',
    'Probes a deployed opengeo-prod middleware five ways - a routed bot UA, a bot UA nobody has',
    'heard of, an ordinary browser UA, Accept: text/markdown, and an Accept header that excludes',
    'both - and reports each separately.',
    '',
    'Options',
    '  --bot <name>       user agent to impersonate (default: ClaudeBot)',
    '  --verbose, -v      show the exact curl and the headers that came back for each probe',
    '  --json             machine-readable output',
    '  --out <file>       write the output to a file instead of stdout',
    '  --project <dir>    project directory holding opengeo.config.json (default: cwd)',
    '  --timeout <secs>   per-request timeout (default: 15)',
  ],
  settings: [
    'Usage: opengeo settings [options]',
    '',
    'Change what `opengeo start` asked you: site URL, web root, which AI agents get the Markdown',
    'twin, who is blocked in robots.txt, and the AI provider key. Every default is the current',
    'value, so pressing Enter through the whole thing changes nothing.',
    '',
    'Picking "let me pick, one by one" for markdown routing opens the full crawler list, where you',
    'can toggle any of them by name or number and add a crawler OpenGEO has never heard of.',
    'The key is written to .env in your project, and .env is added to .gitignore first.',
    '',
    'Options',
    '  --project <dir>    project directory to configure (default: cwd)',
    '  --yes, -y          accept every default without prompting (changes nothing, writes no key)',
    '',
    'Also answers to `opengeo setup`.',
  ],
  start: [
    'Usage: opengeo start [options]',
    '',
    'Sets the project up, then serves the local OpenGEO dashboard - a GUI over exactly the same',
    'functions the CLI calls. A directory with no opengeo.config.json is asked the four setup',
    'questions first; one that already has a config goes straight to the dashboard.',
    'Nothing leaves your machine except the AI provider calls you explicitly trigger.',
    '',
    'Options',
    '  --port, -p <n>     port to listen on (default: 4321)',
    '  --project <dir>    project directory to open (default: cwd)',
    '  --host <addr>      interface to bind (default: 127.0.0.1; any other needs the printed token)',
    '  --web <dir>        directory of built dashboard assets (default: beside this binary)',
    '  --no-open          do not open a browser window',
    '  --setup            run the setup questions even if the project is already configured',
    '  --no-setup         skip the setup questions and go straight to the dashboard',
    '  --yes, -y          accept every setup default without prompting (writes no key)',
  ],
};

/**
 * @param {CommandName} command
 * @returns {string}
 */
function renderCommandHelp(command) {
  return `\n${COMMAND_HELP[command].join('\n')}\n\n`;
}

/**
 * Entry point wrapper every package's `bin` uses.
 *
 * @param {CliOptions} options
 * @returns {Promise<void>}
 */
export async function main(options) {
  process.exitCode = await runCli(options);
}
