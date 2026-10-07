import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server/server.js';
import { CONFIG_FILENAME } from '../../shared/config.js';
import { c } from '../../shared/log.js';
import { parseArgs } from '../args.js';
import { SetupAbort, setupMode } from '../configure.js';
import { runOnboarding } from '../onboarding.js';

/** @import { CommandContext } from '../index.js' */

const SPEC = /** @type {const} */ ({
  booleans: ['no-open', 'no-setup', 'setup', 'yes'],
  strings: ['project', 'host', 'web'],
  numbers: { port: { min: 1, max: 65535, integer: true } },
  alias: { p: 'port', y: 'yes' },
});

/**
 * `opengeo start` - set the project up, then open the local dashboard (§8, §11).
 *
 * One command for the whole first five minutes. A directory with no `opengeo.config.json` gets the
 * four setup questions in the terminal and then the dashboard; a directory that already has one
 * goes straight to the dashboard, because asking a configured project to re-answer its own settings
 * every morning would be the wrong kind of thorough. `opengeo settings` is the way back to those
 * questions, and start says so on the way past. `--setup` forces them, and on a configured project
 * they arrive as settings rather than as onboarding.
 *
 * The dashboard itself is a GUI over exactly the same core functions the CLI calls, served from
 * 127.0.0.1 by a dependency-free `node:http` server. Nothing is uploaded, nothing is synced, and the
 * only network calls it ever makes are the ones the user explicitly triggers from the UI.
 *
 * @param {CommandContext} ctx
 * @returns {Promise<number>}
 */
export async function startCommand(ctx) {
  const args = parseArgs(ctx.argv, SPEC);
  const problem = args.problem();
  if (problem) {
    process.stderr.write(`${problem}\n`);
    return 1;
  }

  const projectDir = args.str('project');
  const root = projectDir ? resolve(process.cwd(), projectDir) : process.cwd();
  const port = args.num('port') ?? 4321;
  const webRoot = args.str('web') ? resolve(process.cwd(), /** @type {string} */ (args.str('web'))) : findWebRoot();

  const mode = setupMode(root);
  // `--setup` re-runs the questions on purpose; `--no-setup` is the escape hatch for a script that
  // wants a server and nothing else, and for a fresh checkout where answering prompts would hang.
  const wantsSetup = args.bool('setup') || (mode === 'first-run' && !args.bool('no-setup'));

  if (wantsSetup) {
    try {
      // A project that already has a config is being edited, not onboarded, even when `--setup`
      // asked for the questions again: settings mode puts every current value on one screen, so
      // pressing Enter through it cannot quietly widen a list the user had narrowed.
      await runOnboarding({ root, mode, autoAccept: args.bool('yes'), tag: `${ctx.packageName} ${ctx.version}` });
    } catch (error) {
      if (error instanceof SetupAbort) {
        process.stderr.write(`\n${c.red('setup stopped')} ${error.message}\n`);
        return 1;
      }
      throw error;
    }
    process.stdout.write(`\n${c.gray('Opening the dashboard.')}\n`);
  }

  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let running;
  try {
    running = await startServer({
      port,
      host: args.str('host'),
      root,
      webRoot,
      version: ctx.version,
      packageName: ctx.packageName,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('EADDRINUSE')) {
      process.stderr.write(`\n${c.red('Port in use')} Something is already listening on ${port}. Try \`opengeo start -p ${port + 1}\`.\n\n`);
      return 1;
    }
    throw error;
  }

  process.stdout.write(`\n${c.bold('OpenGEO')} ${c.gray('dashboard')}\n`);
  process.stdout.write(`  ${c.green(running.url)}\n`);
  process.stdout.write(`  ${c.gray(`project: ${root}`)}\n`);
  process.stdout.write(
    `  ${c.gray(existsSync(join(root, CONFIG_FILENAME)) ? `config:  ${CONFIG_FILENAME}` : `config:  none yet, the dashboard will offer to create one`)}\n`,
  );
  if (!wantsSetup) {
    process.stdout.write(`  ${c.gray('settings: `opengeo settings`, or the Settings tab in the dashboard')}\n`);
  }
  if (running.token === undefined) {
    process.stdout.write(`\n  ${c.gray('Runs on your machine only. Nothing is uploaded and no key ever leaves this computer')}\n`);
    process.stdout.write(`  ${c.gray('except in the calls you trigger to the AI provider you chose.')}\n`);
  } else {
    // The loopback promise above is false here, so it is not printed. What replaces it says what is
    // actually exposed: a page that can write an API key, over plain HTTP.
    const where = /** @type {string} */ (args.str('host'));
    process.stdout.write(`\n  ${c.yellow(`Reachable from the network on ${where}, not just this machine.`)}\n`);
    process.stdout.write(`  ${c.gray('Every request needs the token in the URL above. It is new on every launch. From another')}\n`);
    process.stdout.write(`  ${c.gray("machine, use this one's address with the same ?token=.")}\n`);
    process.stdout.write(`  ${c.gray('The traffic is plain HTTP: anyone who can see it can read the token and any API key')}\n`);
    process.stdout.write(`  ${c.gray('saved through it. Use this only on a network you trust.')}\n`);
  }
  process.stdout.write(`\n  ${c.gray('Ctrl-C to stop.')}\n\n`);

  if (!args.bool('no-open')) openBrowser(running.url);

  // Resolves on Ctrl-C. Without this the command would return and the process would exit while the
  // server is still listening.
  await /** @type {Promise<void>} */ (new Promise((resolveWait) => {
    const stop = () => {
      process.stdout.write(`\n${c.gray('Stopped.')}\n`);
      void running.close().then(resolveWait, resolveWait);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }));
  return 0;
}

/**
 * Where the dashboard lives.
 *
 * It is plain HTML, CSS and JavaScript with no build step, so the files that ship are the files in
 * the repo. At runtime this module is bundled into `<package>/dist/cli.js`, and `web/` is the
 * package's own folder beside `dist/`, which is the same place in an install and in a clone. Run
 * from source, this module is still in core, so the clone layout is the second candidate.
 *
 * @returns {string}
 */
function findWebRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'web'),
    // From source (vitest or plain node): packages/core/src/cli/commands -> packages/opengeo/web
    join(here, '..', '..', '..', '..', 'opengeo', 'web'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ?? candidates[0];
}

/**
 * Best-effort. A dashboard that fails to open a browser is still a dashboard at a printed URL.
 *
 * @param {string} url
 * @param {string} [command] The opener. Only tests pass one.
 * @returns {import('node:child_process').ChildProcess | undefined}
 */
export function openBrowser(url, command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open') {
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    // A missing opener (xdg-open on a headless box) arrives later as an 'error' event, which the
    // catch below never sees and which kills the process if nobody listens for it.
    child.on('error', () => {});
    child.unref();
    return child;
  } catch {
    // Ignored on purpose: the URL is already on screen.
    return undefined;
  }
}
