import { describe, expect, it } from 'vitest';
import { select } from '../src/cli/tui/interact.js';
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
        return next.length === 1 ? { name: 'char', value: next } : { name: next, value: '' };
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
