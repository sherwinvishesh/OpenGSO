import { describe, expect, it } from 'vitest';
import { candidates, copyToClipboard, osc52 } from '../src/shared/clipboard.js';

/**
 * The clipboard as each system offers it, with the runner swapped out so no test ever touches the
 * real one: what gets tried, in what order, and what is said when nothing answers.
 */

/**
 * A runner that records every call and succeeds only for the named tools.
 *
 * @param {string[]} working
 */
function fakeRunner(working) {
  /** @type {Array<{ command: string; args: string[]; text: string }>} */
  const calls = [];
  /** @type {import('../src/shared/clipboard.js').ClipboardRunner} */
  const run = async (command, args, text) => {
    calls.push({ command, args, text });
    return working.includes(command);
  };
  return { run, calls };
}

/** A terminal that is not one, so OSC 52 is never the fallback unless a test asks for it. */
const notATerminal = { isTTY: false, write: () => true };

describe('copyToClipboard', () => {
  it('hands the text to pbcopy on stdin on macOS, with no arguments', async () => {
    const { run, calls } = fakeRunner(['pbcopy']);
    const result = await copyToClipboard('# Fix it', { platform: 'darwin', env: {}, run, terminal: notATerminal });
    expect(result).toEqual({ ok: true, via: 'pbcopy', confirmed: true });
    expect(calls).toEqual([{ command: 'pbcopy', args: [], text: '# Fix it' }]);
  });

  it('asks PowerShell for UTF-8 first on Windows, and falls back to clip', async () => {
    const { run, calls } = fakeRunner(['clip']);
    const result = await copyToClipboard('naïve', { platform: 'win32', env: {}, run, terminal: notATerminal });
    expect(result).toEqual({ ok: true, via: 'clip', confirmed: true });
    expect(calls.map((call) => call.command)).toEqual(['powershell.exe', 'clip']);
    expect(calls[0].args.join(' ')).toContain('UTF8');
    // The text is never part of the command line, only of stdin.
    expect(calls[0].args.join(' ')).not.toContain('naïve');
  });

  it('tries the Wayland tool only under Wayland, then the X tools only under X', () => {
    expect(candidates('linux', { WAYLAND_DISPLAY: 'wayland-0' }).map(([command]) => command)).toEqual(['wl-copy']);
    expect(candidates('linux', { DISPLAY: ':0' }).map(([command]) => command)).toEqual(['xclip', 'xsel']);
    expect(candidates('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }).map(([command]) => command)).toEqual([
      'wl-copy',
      'xclip',
      'xsel',
    ]);
  });

  it('reaches the Windows clipboard from WSL, and the Termux one on Android', () => {
    expect(candidates('linux', { WSL_DISTRO_NAME: 'Ubuntu' }).map(([command]) => command)).toEqual(['powershell.exe', 'clip.exe']);
    expect(candidates('android', { TERMUX_VERSION: '0.118' }).map(([command]) => command)).toEqual(['termux-clipboard-set']);
  });

  it('says which tools it tried when none of them worked and there is no terminal to ask', async () => {
    const { run } = fakeRunner([]);
    const result = await copyToClipboard('x', { platform: 'linux', env: { DISPLAY: ':0' }, run, terminal: notATerminal });
    expect(result).toEqual({ ok: false, tried: ['xclip', 'xsel'] });
  });

  it('falls back to OSC 52 on a terminal, and does not claim that it worked', async () => {
    const { run } = fakeRunner([]);
    /** @type {string[]} */
    const written = [];
    const terminal = { isTTY: true, write: (/** @type {string} */ text) => written.push(text) };
    const result = await copyToClipboard('hello', { platform: 'linux', env: {}, run, terminal });
    expect(result).toMatchObject({ ok: true, confirmed: false });
    expect(written).toEqual([`\u001b]52;c;${Buffer.from('hello').toString('base64')}\u0007`]);
  });

  it('does not send a runaway through OSC 52', async () => {
    const { run } = fakeRunner([]);
    /** @type {string[]} */
    const written = [];
    const terminal = { isTTY: true, write: (/** @type {string} */ text) => written.push(text) };
    const result = await copyToClipboard('x'.repeat(200_000), { platform: 'linux', env: {}, run, terminal });
    expect(result.ok).toBe(false);
    expect(written).toEqual([]);
  });

  it('fails cleanly, without throwing, when the tool does not exist', async () => {
    // The real runner, against a command that cannot exist on any system.
    const result = await copyToClipboard('x', {
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'nope' },
      terminal: notATerminal,
      run: undefined,
    }).catch((error) => error);
    expect(result).toEqual({ ok: false, tried: ['wl-copy'] });
  }, 10_000);
});

describe('osc52', () => {
  it('wraps the sequence for tmux and screen, which would otherwise swallow it', () => {
    const plain = osc52('hi', {});
    expect(osc52('hi', { TMUX: '/tmp/tmux-1/default,1,0' })).toBe(`\u001bPtmux;${plain.replace(/\u001b/g, '\u001b\u001b')}\u001b\\`);
    expect(osc52('hi', { TERM: 'screen-256color' })).toBe(`\u001bP${plain}\u001b\\`);
  });
});
