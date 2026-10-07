import { describe, expect, it } from 'vitest';
import { field, select } from '../src/cli/tui/interact.js';
import { stripAnsi } from '../src/cli/tui/paint.js';
/** @import { Key, KeyReader } from '../src/cli/tui/keys.js' */
/** @import { Screen } from '../src/cli/tui/screen.js' */

/**
 * The full-screen questions, driven by a fake screen and a scripted key reader.
 *
 * Every script ends in Escape, so a key that is wrongly ignored shows up as `undefined` rather than
 * as a test that waits forever.
 */

/** @param {{ columns?: number; rows?: number }} [size] */
const fakeScreen = (size = {}) => {
  /** @type {string[][]} */
  const frames = [];
  const screen = {
    paint: (/** @type {string[]} */ lines) => void frames.push(lines),
    close: () => {},
    size: () => ({ columns: size.columns ?? 80, rows: size.rows ?? 24 }),
  };
  return { screen: /** @type {Screen} */ (/** @type {unknown} */ (screen)), frames };
};

/**
 * @param {Array<Key['name'] | string>} script A key name, or a single printable character.
 * @returns {KeyReader}
 */
const fakeKeys = (script) =>
  /** @type {KeyReader} */ (
    /** @type {unknown} */ ({
      next: async () => {
        const next = script.shift() ?? 'escape';
        return [...next].length === 1 ? { name: 'char', value: next } : { name: next, value: '' };
      },
      close: () => {},
    })
  );

const items = [
  { value: 'test', label: 'Test' },
  { value: 'generate', label: 'Generate', disabled: true },
  { value: 'quit', label: 'Quit' },
];

describe('select', () => {
  it('ignores a shortcut whose row is disabled', async () => {
    const { screen } = fakeScreen();
    const answer = await select(screen, fakeKeys(['g']), {
      header: [],
      items,
      shortcuts: { t: 'test', g: 'generate', q: 'quit' },
    });
    expect(answer).toBeUndefined();
  });

  it('still honours a shortcut whose row is enabled', async () => {
    const { screen } = fakeScreen();
    const answer = await select(screen, fakeKeys(['q']), { header: [], items, shortcuts: { q: 'quit' } });
    expect(answer).toBe('quit');
  });

  it('does not pick a row by a number the list never shows', async () => {
    const { screen } = fakeScreen();
    expect(await select(screen, fakeKeys(['3']), { header: [], items })).toBeUndefined();
  });
});

describe('select on a short terminal', () => {
  // The provider picker: a ten-line header over thirteen rows, on an 80x24 terminal.
  const header = Array.from({ length: 10 }, (_, line) => `header ${line}`);
  const many = Array.from({ length: 13 }, (_, row) => ({ value: row, label: `Row ${row}` }));
  /** @param {string[]} frame */
  const plain = (frame) => frame.map((line) => stripAnsi(line));

  it('scrolls to keep the selected row and the key hints on screen', async () => {
    const { screen, frames } = fakeScreen({ rows: 24 });
    await select(screen, fakeKeys(['end']), { header, items: many });
    const frame = plain(frames[frames.length - 1] ?? []);

    // `paint` shows rows - 1 lines, so anything past that is never seen.
    expect(frame.length).toBeLessThanOrEqual(23);
    expect(frame.join('\n')).toContain('Row 12');
    expect(frame.join('\n')).toContain('more above');
    expect(frame[frame.length - 1]).toContain('enter');
  });

  it('starts at the top and says how much is below', async () => {
    const { screen, frames } = fakeScreen({ rows: 24 });
    await select(screen, fakeKeys([]), { header, items: many });
    const frame = plain(frames[0] ?? []);
    expect(frame.length).toBeLessThanOrEqual(23);
    expect(frame.join('\n')).toContain('Row 0');
    expect(frame.join('\n')).toContain('more below');
  });

  it('draws a list that fits exactly as before, with no scroll markers', async () => {
    const { screen, frames } = fakeScreen({ rows: 40 });
    await select(screen, fakeKeys([]), { header, items: many });
    const frame = plain(frames[0] ?? []).join('\n');
    expect(frame).toContain('Row 12');
    expect(frame).not.toContain('more');
  });
});

describe('field', () => {
  /** @param {Array<Key['name'] | string>} script */
  const typed = async (script, value = '') => {
    const { screen } = fakeScreen();
    return await field(screen, fakeKeys([...script, 'enter']), { header: [], label: 'URL', value });
  };

  it('deletes the word before the caret on ctrl-w', async () => {
    expect(await typed(['ctrl-w'], 'foo bar')).toBe('foo');
    expect(await typed([...Array(6).fill('left'), 'ctrl-w'], 'one two three')).toBe('one  three');
  });

  it('edits a character outside the Basic Multilingual Plane as one character', async () => {
    expect(await typed(['backspace'], 'ab\u{1F600}')).toBe('ab');
    expect(await typed(['home', 'right', 'y'], '\u{1F600}x')).toBe('\u{1F600}yx');
    expect(await typed(['home', 'delete'], '\u{1F600}x')).toBe('x');
  });

  it('masks a secret with one star per character', async () => {
    const { screen, frames } = fakeScreen();
    await field(screen, fakeKeys(['enter']), { header: [], label: 'Key', value: 'k\u{1F511}', secret: true });
    const line = stripAnsi(frames[0].find((row) => row.includes('Key')) ?? '');
    expect(line).toContain('**');
    expect(line).not.toContain('***');
  });
});
