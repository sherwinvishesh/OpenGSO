import { basename } from 'node:path';
import { readManifest } from '../generate/manifest.js';
import { internalDirPath, loadConfig } from '../shared/config.js';
import { readCredentials } from '../shared/env.js';
import { ERRORS } from '../shared/errors.js';
import { c } from '../shared/log.js';
import { PALETTE, ink } from '../shared/render/theme.js';
import { deltaFor, lastScored, readHistory, relativeAge, scoreTrend } from '../test/history.js';
import { field, select } from './tui/interact.js';
import { readKeys } from './tui/keys.js';
import { padEnd, terminalWidth, truncate } from '../shared/render/paint.js';
import { canUseTui, openScreen } from './tui/screen.js';
import { lockedMeter, meter, sparkline } from '../shared/render/meters.js';
import { box, keyHints, wordmark } from './tui/widgets.js';
import { createPrompter } from './prompt.js';

/**
 * @import { CommandName } from '../shared/errors.js'
 * @import { CommandHandler } from './index.js'
 * @import { KeyReader } from './tui/keys.js'
 * @import { Screen } from './tui/screen.js'
 * @import { ListItem } from './tui/widgets.js'
 */

/**
 * `opengeo` on its own: the application, rather than a wall of flags.
 *
 * The first thing anyone types after installing something is its name, and until now that answered
 * with either a help page or a browser window. Neither is what the question meant. This is a home
 * screen: it reads the project off disk, says where it stands in four lines, and offers the five
 * things there are to do, each of which can be reached with one keystroke.
 *
 * The rule that shapes the whole file is that **it never hosts a command's output**. Picking Test
 * leaves the alternate screen buffer, runs the real `testCommand` in normal scrollback with its
 * live progress, and waits for a key before coming back. A report is long, and being able to scroll
 * and copy it is worth more than a pane with its own scrollbar. It also means there is exactly one
 * implementation of every command: the home screen is a launcher, not a second front end.
 */

/** @typedef {'test' | 'generate' | 'prod' | 'dashboard' | 'settings' | 'setup' | 'quit'} HomeAction */

/**
 * @typedef {object} HomeOptions
 * @property {string} packageName
 * @property {string} version
 * @property {Partial<Record<CommandName, CommandHandler>>} commands Whatever this install actually
 *   ships. An entry with no handler is drawn dim, not hidden.
 * @property {string} [root]
 * @property {NodeJS.ReadStream} [input]
 * @property {NodeJS.WriteStream} [output]
 */

/**
 * Everything the header knows, read once per repaint. Separated out so the rendering is testable.
 *
 * @typedef {object} HomeStatus
 * @property {string} project The directory name, which is what a person calls their project.
 * @property {string} root
 * @property {boolean} configured
 * @property {string} [site]
 * @property {{ value: number; at: string; delta?: number; trend: number[]; lockedPoints?: number }} [score]
 * @property {{ id: string; source: string }} [provider]
 * @property {number} twins
 * @property {string} [generatedAt]
 */

/**
 * Read the project's current state.
 *
 * Every source here is best-effort and every one of them is allowed to be missing: an unconfigured
 * directory, a project that has never generated, one with no key. A home screen that throws because
 * a file it wanted to summarise is absent would be worse than no home screen.
 *
 * @param {string} root
 * @returns {HomeStatus}
 */
export function readHomeStatus(root) {
  const loaded = safely(() => loadConfig(root));
  const configured = Boolean(loaded?.exists);
  /** @type {HomeStatus} */
  const status = { project: basename(root) || root, root, configured, twins: 0 };
  if (!loaded) return status;

  // Only a site the user actually chose. `defaultConfig()` fills in localhost:3000, and showing
  // that on an unconfigured directory would be the home screen inventing a project.
  status.site = configured ? loaded.config.site || undefined : undefined;
  const internalDir = internalDirPath(loaded);

  const manifest = safely(() => readManifest(internalDir, loaded.config.site));
  if (manifest) {
    const pages = Object.keys(manifest.pages ?? {});
    status.twins = pages.length;
    if (pages.length > 0) status.generatedAt = manifest.generatedAt;
  }

  const history = safely(() => readHistory(internalDir)) ?? { version: 1, entries: [] };
  const last = lastScored(history);
  if (last && typeof last.score === 'number') {
    status.score = {
      value: last.score,
      at: last.at,
      delta: deltaFor(history, last)?.points,
      trend: scoreTrend(history, last.url, 16),
      lockedPoints: last.lockedPoints,
    };
    // A score always belongs to the URL it was measured against, so the header shows that URL
    // rather than the configured one when they differ. Otherwise a run against localhost would be
    // reported under the production address it was never taken from.
    if (last.url && last.url !== status.site) status.site = last.url;
  }

  // Never the key itself, and never its length. Which provider and where it lives is the whole of
  // what a status line needs, and it is the one value in OpenGEO that must not reach a screen.
  const credentials = safely(() => readCredentials(root));
  if (credentials) {
    status.provider = { id: credentials.provider, source: credentials.source === 'env-file' ? '.env' : 'environment' };
  }
  return status;
}

/**
 * @template T
 * @param {() => T} read
 * @returns {T | undefined}
 */
function safely(read) {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * The header box: what this project is, and where it stands.
 *
 * @param {HomeStatus} status
 * @param {string} version
 * @param {number} [width]
 * @returns {string[]}
 */
export function homeHeader(status, version, width = terminalWidth()) {
  const inner = Math.max(24, Math.min(width, 96) - 4);
  /** @type {string[]} */
  const body = [];
  body.push(`${c.bold(status.project)}  ${ink.faint(status.site ?? 'no site configured yet')}`);
  body.push('');
  for (const row of statusRows(status, inner)) body.push(row);
  return box(body, { title: wordmark(), tag: version, width: Math.min(width, 96) });
}

const LABEL_WIDTH = 10;

/**
 * The three status rows, each of which says "unknown" honestly rather than not appearing.
 *
 * @param {HomeStatus} status
 * @param {number} width
 * @returns {string[]}
 */
export function statusRows(status, width) {
  /** @type {string[]} */
  const rows = [];
  /** @param {string} text */
  const label = (text) => ink.faint(padEnd(text, LABEL_WIDTH));

  if (!status.configured) {
    rows.push(`${label('Setup')}${ink.warn('not configured')}  ${ink.faint('press s to answer four questions')}`);
    return rows;
  }

  if (status.score) {
    const bar = status.score.lockedPoints
      ? lockedMeter(status.score.value, status.score.lockedPoints, 16)
      : meter(status.score.value, 16);
    const parts = [`${bar} ${c.bold(String(status.score.value))}`];
    if (typeof status.score.delta === 'number' && status.score.delta !== 0) {
      const sign = status.score.delta > 0 ? '+' : '';
      const paint = status.score.delta > 0 ? ink.ok : ink.danger;
      parts.push(paint(`${sign}${status.score.delta}`));
    }
    if (status.score.trend.length > 1) parts.push(sparkline(status.score.trend, PALETTE.muted));
    parts.push(ink.faint(relativeAge(status.score.at)));
    rows.push(`${label('Score')}${parts.join('  ')}`);
  } else {
    rows.push(`${label('Score')}${ink.faint('never tested')}  ${ink.faint('press t')}`);
  }

  rows.push(
    status.twins > 0
      ? `${label('Twins')}${status.twins} ${status.twins === 1 ? 'page' : 'pages'}  ${ink.faint(status.generatedAt ? `generated ${relativeAge(status.generatedAt)}` : '')}`
      : `${label('Twins')}${ink.faint('none generated')}  ${ink.faint('press g')}`,
  );

  rows.push(
    status.provider
      ? `${label('AI key')}${status.provider.id}  ${ink.faint(`from ${status.provider.source}`)}`
      : `${label('AI key')}${ink.faint('none')}  ${ink.faint('optional, only the AI features need one')}`,
  );

  return rows.map((row) => truncate(row, width));
}

/**
 * The menu.
 *
 * An install that does not ship a command still shows its row, dimmed and unselectable. Hiding it
 * would make two installs look like the same product with a different number of features, when the
 * honest reading is that this one is narrower and the row says which package widens it.
 *
 * @param {Partial<Record<CommandName, CommandHandler>>} commands
 * @param {HomeStatus} status
 * @returns {Array<ListItem<HomeAction>>}
 */
export function homeEntries(commands, status) {
  /** @param {CommandName} name */
  const has = (name) => Boolean(commands[name]);
  /** @type {Array<ListItem<HomeAction>>} */
  const entries = [];

  if (!status.configured && has('settings')) {
    entries.push({ value: 'setup', label: 'Set up this project', note: 'four questions, then you are done' });
  }
  entries.push({ value: 'test', label: 'Test', note: 'score a live URL 0-100', disabled: !has('test') });
  entries.push({ value: 'generate', label: 'Generate', note: 'write the markdown twins', disabled: !has('generate') });
  entries.push({ value: 'prod', label: 'Prod check', note: 'probe the deployed middleware', disabled: !has('prod test') });
  entries.push({ value: 'dashboard', label: 'Dashboard', note: 'the same thing in a browser', disabled: !has('start') });
  entries.push({ value: 'settings', label: 'Settings', note: 'site, crawlers, AI key', disabled: !has('settings') });
  entries.push({ value: 'quit', label: 'Quit' });
  return entries;
}

/** @type {Record<string, HomeAction>} */
const SHORTCUTS = {
  t: 'test',
  g: 'generate',
  p: 'prod',
  d: 'dashboard',
  s: 'settings',
  q: 'quit',
};

/**
 * The application loop.
 *
 * Returns a process exit code, which is always 0 for a normal quit: the home screen is a launcher,
 * and the exit code of the last thing launched is not the exit code of the launcher. A test that
 * scored 40 should not make `opengeo` itself look like it crashed.
 *
 * @param {HomeOptions} options
 * @returns {Promise<number>}
 */
export async function runHome(options) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const root = options.root ?? process.cwd();

  if (!canUseTui({ input, output })) return runFlatHome(options, root);

  const screen = openScreen({ input, output });
  /** @type {KeyReader} */
  let keys = readKeys(input);
  // `keys` is read when the event fires, not now: it is replaced after every command.
  const stopResize = screen.onResize(() => keys.wake());

  try {
    for (;;) {
      const status = readHomeStatus(root);
      /** @type {HomeAction | undefined} */
      const action = await select(screen, keys, {
        // A function, so a resize draws the box at the new width rather than the one it opened at.
        header: () => ['', ...homeHeader(status, `${options.packageName} ${options.version}`, screen.size().columns)],
        items: homeEntries(options.commands, status),
        shortcuts: SHORTCUTS,
        hints: [
          ['up/down', 'move'],
          ['enter', 'run'],
          ['t g p d s', 'jump'],
          ['q', 'quit'],
        ],
      });
      if (!action || action === 'quit') return 0;

      const argv = await composeArgs(screen, keys, action, status, `${options.packageName} ${options.version}`);
      if (!argv) continue;

      // The key reader is detached before the command runs. Both it and whatever the command puts
      // on stdin (`settings` opens a readline) would otherwise receive every keystroke, and the
      // menu would replay the setup answers into itself the moment the command returned.
      keys.close();
      const ended = await screen.suspend(async () => {
        await runInScrollback(options, action, argv, output);
        return await waitForKey(input, output);
      });
      // Ctrl-D at the prompt closes stdin for good, and a menu with no input could only hang.
      if (ended) return 0;
      keys = readKeys(input);
    }
  } finally {
    stopResize();
    keys.close();
    screen.close();
  }
}

/**
 * Which handler an action runs, and under what name it is announced.
 *
 * @param {HomeAction} action
 * @returns {CommandName}
 */
function commandFor(action) {
  if (action === 'prod') return 'prod test';
  if (action === 'dashboard') return 'start';
  if (action === 'setup') return 'settings';
  return /** @type {CommandName} */ (action);
}

/**
 * @param {HomeOptions} options
 * @param {HomeAction} action
 * @param {string[]} argv
 * @param {NodeJS.WriteStream} output
 * @returns {Promise<void>}
 */
async function runInScrollback(options, action, argv, output) {
  const name = commandFor(action);
  const handler = options.commands[name];
  if (!handler) return;
  const shown = [name, ...argv].join(' ');
  output.write(`\n${ink.faint(`$ opengeo ${shown}`)}\n`);
  try {
    await handler({ argv, packageName: options.packageName, version: options.version });
  } catch (error) {
    output.write(`\n${c.red('Error')} ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * The little form in front of each command.
 *
 * Only the two questions that change the answer are asked. Everything else has a flag and a sane
 * default, and a menu that re-asked every flag would be slower than typing the command. Returns
 * undefined when the user backed out, which must not be read as "run it with no arguments".
 *
 * @param {Screen} screen
 * @param {KeyReader} keys
 * @param {HomeAction} action
 * @param {HomeStatus} status
 * @param {string} version
 * @returns {Promise<string[] | undefined>}
 */
async function composeArgs(screen, keys, action, status, version) {
  const header = ['', ...homeHeader(status, version, screen.size().columns)];
  const site = status.site ?? '';

  if (action === 'settings' || action === 'setup') return [];
  if (action === 'dashboard') return status.configured ? ['--no-setup'] : [];

  if (action === 'prod') {
    const url = await askUrl(screen, keys, header, site, 'Which deployed URL should I probe?');
    return url ? [url] : undefined;
  }

  if (action === 'test') {
    /** @type {'full' | 'structure' | 'content' | undefined} */
    const mode = await select(screen, keys, {
      header,
      items: [
        { value: 'structure', label: 'Structure', note: 'the 22 checks and the 0-100 score. Free, no key.' },
        { value: 'full', label: 'Structure and content', note: 'both passes. The content half needs a key.' },
        { value: 'content', label: 'Content only', note: 'an AI review of the markdown, no score' },
      ],
      hints: [['up/down', 'move'], ['enter', 'select'], ['esc', 'back']],
    });
    if (!mode) return undefined;
    const url = await askUrl(screen, keys, header, site, 'Which URL should I test?');
    if (!url) return undefined;
    return mode === 'full' ? [url] : [url, `--${mode}`];
  }

  if (action === 'generate') {
    /** @type {'free' | 'ai' | undefined} */
    const tier = await select(screen, keys, {
      header,
      items: [
        { value: 'free', label: 'Free', note: 'algorithmic extraction. No key, no cost.' },
        { value: 'ai', label: 'AI', note: 'rewritten by your provider. Needs a key.', disabled: !status.provider },
      ],
      hints: [['up/down', 'move'], ['enter', 'select'], ['esc', 'back']],
    });
    if (!tier) return undefined;
    const url = await askUrl(screen, keys, header, site, 'Which site should I crawl?');
    if (!url) return undefined;
    return tier === 'ai' ? [url, '--tier', 'ai'] : [url];
  }

  return [];
}

/**
 * @param {Screen} screen
 * @param {KeyReader} keys
 * @param {string[]} header
 * @param {string} site
 * @param {string} label
 * @returns {Promise<string | undefined>}
 */
async function askUrl(screen, keys, header, site, label) {
  return await field(screen, keys, {
    header: [...header, '', `  ${c.bold(label)}`],
    label: 'URL',
    value: site,
    placeholder: 'https://example.com',
    hint: 'Enter to accept, esc to go back.',
    validate: (value) => (isUrlish(value) ? undefined : ERRORS.urlNeedsScheme),
  });
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isUrlish(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Wait before returning to the menu.
 *
 * Called from inside `suspend`, so the terminal is back in cooked mode and this is a plain "press
 * Enter". Trying to read a single raw keypress here would mean turning raw mode back on while the
 * report is still on screen, which is how a terminal ends up echoing nothing after a Ctrl-C.
 *
 * Resolves true when the input ended instead (Ctrl-D on an empty line), which is not a keypress and
 * never arrives as `data`.
 *
 * @param {NodeJS.ReadStream} input
 * @param {NodeJS.WriteStream} output
 * @returns {Promise<boolean>}
 */
function waitForKey(input, output) {
  return new Promise((resolve) => {
    output.write(`\n${ink.faint('Press Enter to go back to the menu.')} `);
    /** @param {boolean} ended */
    const settle = (ended) => {
      input.off('data', onData);
      input.off('end', onEnd);
      output.write('\n');
      resolve(ended);
    };
    const onData = () => settle(false);
    const onEnd = () => settle(true);
    input.once('data', onData);
    input.once('end', onEnd);
    input.resume();
  });
}

/**
 * The same menu without any of the terminal control.
 *
 * `NO_COLOR`, `TERM=dumb`, `CI` and a pipe on either end all land here, and a pipe goes straight on
 * to the help page. It is numbered rather than arrow-driven because there is no raw mode to read
 * arrows with, and it is the same list in the same order so that describing one describes both.
 *
 * @param {HomeOptions} options
 * @param {string} root
 * @returns {Promise<number>}
 */
async function runFlatHome(options, root) {
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  // Nobody is there to answer, or nobody is there to read the question (`opengeo | head`). A menu
  // would either hang or silently pick its own default, and both are worse than the help page the
  // old bare invocation printed.
  if (!input.isTTY || !output.isTTY) return -1;

  for (;;) {
    const status = readHomeStatus(root);
    output.write(`\n${c.bold('OpenGEO')} ${c.gray(`${options.packageName} ${options.version}`)}\n`);
    output.write(`${status.project}  ${c.gray(status.site ?? 'no site configured yet')}\n`);
    for (const row of plainStatus(status)) output.write(`${row}\n`);
    output.write('\n');

    const entries = homeEntries(options.commands, status).filter((entry) => !entry.disabled);
    // One reader per question, closed before the command starts. A menu reader left attached to
    // stdin echoes every keystroke, including the API key `settings` is masking, and a Ctrl-D meant
    // for the command would close it too.
    const prompter = createPrompter({ input, output });
    /** @type {HomeAction} */
    let action;
    try {
      action = await prompter.choose(
        'What would you like to do?',
        entries.map((entry) => ({ value: entry.value, label: entry.label, note: entry.note })),
        /** @type {HomeAction} */ ('quit'),
      );
    } finally {
      prompter.close();
    }
    if (action === 'quit') return 0;

    const argv = flatArgs(action, status);
    await runInScrollback(options, action, argv, output);
  }
}

/**
 * The status rows with no colour and no meters, for the flat menu.
 *
 * @param {HomeStatus} status
 * @returns {string[]}
 */
export function plainStatus(status) {
  if (!status.configured) return ['  not configured yet'];
  const rows = [
    status.score ? `  score    ${status.score.value}/100, ${relativeAge(status.score.at)}` : '  score    never tested',
    status.twins > 0 ? `  twins    ${status.twins} pages` : '  twins    none generated',
    status.provider ? `  ai key   ${status.provider.id}` : '  ai key   none',
  ];
  return rows;
}

/**
 * No form in the flat menu: it takes the configured site and the defaults, or it needs a flag.
 *
 * @param {HomeAction} action
 * @param {HomeStatus} status
 * @returns {string[]}
 */
function flatArgs(action, status) {
  if (action === 'settings' || action === 'setup') return [];
  if (action === 'dashboard') return status.configured ? ['--no-setup'] : [];
  return status.site ? [status.site] : [];
}

