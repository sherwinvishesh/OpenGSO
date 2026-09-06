import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server/server.js';
import { CONFIG_FILENAME } from '../../shared/config.js';
import { c } from '../../shared/log.js';
import { parseArgs } from '../args.js';
import { SetupAbort, runSetup, setupMode } from '../configure.js';
import type { CommandContext } from '../index.js';
import { createPrompter } from '../prompt.js';

const SPEC = {
  booleans: ['no-open', 'no-setup', 'setup', 'yes'],
  strings: ['port', 'project', 'host', 'web'],
  alias: { p: 'port', y: 'yes' },
} as const;

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
 */
export async function startCommand(ctx: CommandContext): Promise<number> {
  const args = parseArgs(ctx.argv, SPEC);
  const unknown = args.unknown();
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option${unknown.length === 1 ? '' : 's'}: ${unknown.map((n) => `--${n}`).join(', ')}\n`);
    return 1;
  }

  const projectDir = args.str('project');
  const root = projectDir ? resolve(process.cwd(), projectDir) : process.cwd();
  const port = args.num('port') ?? 4321;
  const webRoot = args.str('web') ? resolve(process.cwd(), args.str('web')!) : findWebRoot();

  const mode = setupMode(root);
  // `--setup` re-runs the questions on purpose; `--no-setup` is the escape hatch for a script that
  // wants a server and nothing else, and for a fresh checkout where answering prompts would hang.
  const wantsSetup = args.bool('setup') || (mode === 'first-run' && !args.bool('no-setup'));

  if (wantsSetup) {
    const prompter = createPrompter({ autoAccept: args.bool('yes') });
    try {
      // A project that already has a config is being edited, not onboarded, even when `--setup`
      // asked for the questions again: settings mode puts every current value on one screen, so
      // pressing Enter through it cannot quietly widen a list the user had narrowed.
      await runSetup({ root, prompter, mode });
    } catch (error) {
      if (error instanceof SetupAbort) {
        process.stderr.write(`\n${c.red('setup stopped')} ${error.message}\n`);
        return 1;
      }
      throw error;
    } finally {
      prompter.close();
    }
    process.stdout.write(`${c.gray('Opening the dashboard.')}\n`);
  }

  let running: Awaited<ReturnType<typeof startServer>>;
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
  process.stdout.write(`\n  ${c.gray('Runs on your machine only. Nothing is uploaded and no key ever leaves this computer')}\n`);
  process.stdout.write(`  ${c.gray('except in the calls you trigger to the AI provider you chose.')}\n`);
  process.stdout.write(`\n  ${c.gray('Ctrl-C to stop.')}\n\n`);

  if (!args.bool('no-open')) openBrowser(running.url);

  // Resolves on Ctrl-C. Without this the command would return and the process would exit while the
  // server is still listening.
  await new Promise<void>((resolveWait) => {
    const stop = () => {
      process.stdout.write(`\n${c.gray('Stopped.')}\n`);
      void running.close().then(resolveWait, resolveWait);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

/**
 * Where the built dashboard lives.
 *
 * At runtime this module is bundled into `<package>/dist/cli.js`, so `./web/` beside it is the
 * published location. The clone layout is checked too, so `node packages/opengeo/dist/cli.js start`
 * works from a source checkout without an install.
 */
function findWebRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'web'),
    join(here, '..', 'web'),
    // Running from source (vitest, tsx): packages/core/src/cli/commands -> packages/opengeo/dist/web
    join(here, '..', '..', '..', '..', 'opengeo', 'dist', 'web'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ?? candidates[0]!;
}

/** Best-effort. A dashboard that fails to open a browser is still a dashboard at a printed URL. */
function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Ignored on purpose: the URL is already on screen.
  }
}
