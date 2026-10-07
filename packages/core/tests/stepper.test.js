import { describe, expect, it } from 'vitest';
import { openStepper, stepRail } from '../src/cli/stepper.js';
import { pause } from '../src/cli/tui/interact.js';
import { glyphs, stripAnsi } from '../src/shared/render/paint.js';
/** @import { Key, KeyReader } from '../src/cli/tui/keys.js' */
/** @import { Screen } from '../src/cli/tui/screen.js' */

/**
 * The frame setup is drawn inside, tested without a terminal.
 *
 * Nothing here opens a real screen. `stepRail` is a pure function, `pause` takes the screen and the
 * key reader as arguments so a fake of each is enough, and `openStepper` is interesting precisely
 * for the cases where it declines to open anything at all.
 */

describe('stepRail', () => {
  /** @param {number} index */
  const rail = (index, total = 4) => stripAnsi(stepRail('Your site', index, total, 80)[0] ?? '');

  it('says where you are in words as well as dots', () => {
    expect(rail(2)).toContain('Step 2 of 4');
    expect(rail(2)).toContain('Your site');
  });

  it('draws one dot per step, whatever the count', () => {
    for (const total of [1, 4, 7]) {
      const dots = (rail(1, total).match(new RegExp(`[${glyphs().dot}]`, 'g')) ?? []).length;
      expect(dots, `${total} steps`).toBe(total);
    }
  });

  it('never runs past the width it was given', () => {
    expect(stripAnsi(stepRail('A label long enough to need cutting off somewhere', 3, 4, 30)[0] ?? '').length).toBeLessThanOrEqual(30);
  });
});

/**
 * The gate, which is the whole reason the stepper could be added without touching the flat flow.
 *
 * `openStepper` returning undefined is what `runOnboarding` reads to decide between a full-screen
 * frame and the readline prompter that has always been there. If this ever starts returning a
 * stepper for a pipe, `opengeo settings < answers.txt` hangs on a screen nobody can see.
 */
describe('openStepper', () => {
  /** @param {boolean} isTTY */
  const stream = (isTTY) => /** @type {NodeJS.WriteStream & NodeJS.ReadStream} */ (/** @type {unknown} */ ({ isTTY, write: () => true, on: () => {}, off: () => {} }));

  it('declines a pipe on either end', () => {
    expect(openStepper({ input: stream(false), output: stream(true) })).toBeUndefined();
    expect(openStepper({ input: stream(true), output: stream(false) })).toBeUndefined();
  });

  it('declines CI even on a TTY, because nobody is there to read a frame', () => {
    const before = process.env.CI;
    process.env.CI = '1';
    try {
      expect(openStepper({ input: stream(true), output: stream(true) })).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.CI;
      else process.env.CI = before;
    }
  });
});

/**
 * The step that tells rather than asks.
 *
 * Blocking is the one thing setup explains without offering a choice about it, and on a repainting
 * screen a paragraph with no question under it is gone the instant the next frame is drawn. These
 * two cases are the whole contract: something stops the flow, and Ctrl-C still leaves.
 */
describe('pause', () => {
  const fakeScreen = () => {
    /** @type {string[][]} */
    const frames = [];
    const screen = { paint: (/** @type {string[]} */ lines) => void frames.push(lines), close: () => {}, size: () => ({ columns: 80, rows: 24 }) };
    return { screen: /** @type {Screen} */ (/** @type {unknown} */ (screen)), frames };
  };
  /**
   * @param {Key['name'][]} names
   * @returns {KeyReader}
   */
  const fakeKeys = (names) =>
    /** @type {KeyReader} */ (/** @type {unknown} */ ({ next: async () => ({ name: names.shift() ?? 'enter', value: '' }), close: () => {} }));

  it('draws the header it was handed and waits', async () => {
    const { screen, frames } = fakeScreen();

    await pause(screen, fakeKeys(['enter']), { header: ['Nothing is blocked.'] });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('Nothing is blocked.');
    expect(stripAnsi(frames[0]?.join('\n') ?? '')).toContain('enter');
  });

  it('carries on for any key a person could plausibly press', async () => {
    for (const key of /** @type {Key['name'][]} */ (['enter', 'space', 'char', 'down'])) {
      const { screen } = fakeScreen();
      expect(await pause(screen, fakeKeys([key]), { header: [] }), key).toBe(true);
    }
  });

  it('ignores the bytes a terminal makes up, rather than treating them as a keypress', async () => {
    const { screen } = fakeScreen();

    // A mouse report or a bracketed-paste marker should not count as somebody having read the step.
    expect(await pause(screen, fakeKeys(['unknown', 'unknown', 'enter']), { header: [] })).toBe(true);
  });

  it('still lets Ctrl-C out, because a screen with no answer on it is a bad place to trap somebody', async () => {
    for (const key of /** @type {Key['name'][]} */ (['ctrl-c', 'ctrl-d'])) {
      const { screen } = fakeScreen();
      expect(await pause(screen, fakeKeys([key]), { header: [] }), key).toBe(false);
    }
  });
});
