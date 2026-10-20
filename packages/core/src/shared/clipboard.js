import { spawn } from 'node:child_process';

/**
 * Putting text on the system clipboard, with nothing but what the operating system already has.
 *
 * Every candidate is a program that reads the text on stdin, started without a shell and with its
 * arguments as an array, so nothing in the text can ever be read as a command. The first one that
 * exits 0 wins. On a terminal with none of them (a remote shell, a bare container) the last resort
 * is OSC 52, the escape sequence that asks the terminal itself to set its clipboard. That one cannot
 * report back, so the result says it was sent rather than that it worked.
 */

/**
 * @typedef {{ ok: true; via: string; confirmed: boolean } | { ok: false; tried: string[] }} CopyResult
 */

/**
 * @typedef {(command: string, args: string[], text: string) => Promise<boolean>} ClipboardRunner
 */

/**
 * @typedef {object} CopyOptions
 * @property {NodeJS.Platform} [platform]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {ClipboardRunner} [run] Swapped out in tests, so no test touches the real clipboard.
 * @property {NodeJS.WriteStream | { isTTY?: boolean; write: (text: string) => unknown }} [terminal] Where OSC 52 goes, if it comes to that.
 */

/** Long enough for a slow first start of PowerShell, short enough that a hung tool is not a hung CLI. */
const TIMEOUT_MS = 8000;

/**
 * Most terminals that honour OSC 52 cap the payload, and the common cap is around 100 KB of base64.
 * A fix prompt is a few kilobytes, so this only stops a runaway from becoming a wall of escape codes.
 */
const MAX_OSC52_BYTES = 74_000;

/**
 * @param {string} text
 * @param {CopyOptions} [options]
 * @returns {Promise<CopyResult>}
 */
export async function copyToClipboard(text, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runTool;
  /** @type {string[]} */
  const tried = [];
  for (const [command, args] of candidates(platform, env)) {
    tried.push(command);
    if (await run(command, args, text)) return { ok: true, via: command, confirmed: true };
  }
  const terminal = options.terminal ?? process.stdout;
  if (terminal.isTTY && Buffer.byteLength(text, 'utf8') <= MAX_OSC52_BYTES) {
    terminal.write(osc52(text, env));
    return { ok: true, via: 'the terminal (OSC 52)', confirmed: false };
  }
  return { ok: false, tried };
}

/**
 * The tools to try, in order, for this system.
 *
 * Windows gets PowerShell first because `clip` reads its input in the console's code page and turns
 * anything outside ASCII into question marks; telling PowerShell to read UTF-8 does not. Linux tries
 * the Wayland tool only under Wayland, since `wl-copy` on an X session fails slowly. WSL can reach
 * the Windows clipboard through the same `.exe`s, which is the only clipboard a WSL user can paste from.
 *
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} env
 * @returns {Array<[string, string[]]>}
 */
export function candidates(platform, env) {
  /** @type {[string, string[]]} */
  const powershell = [
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'],
  ];
  if (platform === 'darwin') return [['pbcopy', []]];
  if (platform === 'win32') return [powershell, ['clip', []]];
  /** @type {Array<[string, string[]]>} */
  const list = [];
  if (env.WAYLAND_DISPLAY) list.push(['wl-copy', []]);
  if (env.DISPLAY) list.push(['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]);
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) list.push(powershell, ['clip.exe', []]);
  if (env.TERMUX_VERSION) list.push(['termux-clipboard-set', []]);
  return list;
}

/**
 * The OSC 52 sequence for `text`. Inside tmux or GNU screen it is wrapped in their passthrough, or
 * the multiplexer swallows it before the terminal sees it.
 *
 * @param {string} text
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function osc52(text, env) {
  const sequence = `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;
  if (env.TMUX) return `\u001bPtmux;${sequence.replace(/\u001b/g, '\u001b\u001b')}\u001b\\`;
  if (env.TERM?.startsWith('screen')) return `\u001bP${sequence}\u001b\\`;
  return sequence;
}

/** @type {ClipboardRunner} */
function runTool(command, args, text) {
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, TIMEOUT_MS);
    // A missing tool is an 'error' event, not a throw, and both it and 'close' can fire.
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(text, 'utf8');
  });
}
