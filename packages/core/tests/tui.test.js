import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  centre,
  colourDepth,
  gradient,
  hex,
  mix,
  padEnd,
  stripAnsi,
  terminalWidth,
  truncate,
  visibleWidth,
  wrap,
} from '../src/cli/tui/paint.js';
import { decode, splitChunks } from '../src/cli/tui/keys.js';
import { box, listView, lockedMeter, meter, sparkline, textField } from '../src/cli/tui/widgets.js';
import { PALETTE, contentBand, structuralBand } from '../src/cli/tui/theme.js';

/**
 * The terminal layer, exercised without a terminal.
 *
 * Everything in `cli/tui` that draws is a pure function from values to strings, which is the whole
 * reason it is written that way: the alignment bugs a hand-rolled interface actually has are width
 * bugs, and a width bug is only visible if something measures the output.
 */

const ESC = String.fromCharCode(27);
const saved = { ...process.env };

beforeEach(() => {
  process.env.FORCE_COLOR = '3';
  delete process.env.NO_COLOR;
  process.env.LANG = 'en_US.UTF-8';
  delete process.env.OPENGEO_ASCII;
});

afterEach(() => {
  process.env = { ...saved };
});

describe('colour depth', () => {
  it('says nothing when NO_COLOR is set, whatever else the terminal claims', () => {
    process.env.COLORTERM = 'truecolor';
    process.env.NO_COLOR = '1';
    expect(colourDepth()).toBe(0);
  });

  it('reads FORCE_COLOR as a level, not merely as set', () => {
    process.env.FORCE_COLOR = '0';
    expect(colourDepth()).toBe(0);
    process.env.FORCE_COLOR = '2';
    expect(colourDepth()).toBe(2);
  });

  it('emits no escapes at all at depth 0, so piped output stays plain', () => {
    process.env.FORCE_COLOR = '0';
    const painted = gradient('OpenGEO', PALETTE.ok, PALETTE.okBright);
    expect(painted).toBe('OpenGEO');
    expect(painted).not.toContain(ESC);
  });
});

describe('width, once the string has colour in it', () => {
  it('measures what is drawn, not what is stored', () => {
    const painted = gradient('score', PALETTE.ok, PALETTE.okBright);
    expect(painted.length).toBeGreaterThan(5);
    expect(visibleWidth(painted)).toBe(5);
  });

  it('pads a coloured string to the column it is asked for', () => {
    const painted = gradient('ab', PALETTE.ok, PALETTE.okBright);
    expect(visibleWidth(padEnd(painted, 10))).toBe(10);
  });

  it('counts a wide character as the two columns it occupies', () => {
    expect(visibleWidth('日本')).toBe(4);
  });

  it('centres to the exact width', () => {
    expect(visibleWidth(centre('hi', 11))).toBe(11);
  });
});

describe('truncate', () => {
  it('leaves a short string alone', () => {
    expect(truncate('short', 20)).toBe('short');
  });

  it('never cuts through an escape sequence', () => {
    const painted = gradient('abcdefghij', PALETTE.ok, PALETTE.okBright);
    const cut = truncate(painted, 6);
    expect(visibleWidth(cut)).toBeLessThanOrEqual(6);
    // A sequence severed halfway would leave a bare `[38;2;` in the visible text.
    expect(stripAnsi(cut)).toMatch(/^[a-j]*\.\.\.$/);
  });

  it('closes any colour left open at the cut, so it cannot bleed into the next column', () => {
    const cut = truncate(gradient('abcdefghij', PALETTE.ok, PALETTE.okBright), 6);
    expect(cut).toContain(`${ESC}[0m`);
  });
});

describe('wrap', () => {
  it('breaks on words and keeps every line inside the width', () => {
    const lines = wrap('the quick brown fox jumps over the lazy dog', 12);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
    expect(lines.join(' ')).toContain('quick brown');
  });

  it('breaks a word that is longer than the line rather than letting it run off', () => {
    const lines = wrap('https://example.com/a/very/long/path/that/never/ends', 15);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(15);
  });
});

describe('meter', () => {
  it('fills nothing at zero and everything at a hundred', () => {
    expect(stripAnsi(meter(0, 10))).toBe('░'.repeat(10));
    expect(stripAnsi(meter(100, 10))).toBe('█'.repeat(10));
  });

  it('always occupies exactly the width it was given', () => {
    for (const value of [0, 1, 37, 54, 80, 96, 99, 100]) {
      expect(visibleWidth(meter(value, 24))).toBe(24);
    }
  });

  it('distinguishes two scores a whole-cell bar would draw identically', () => {
    // This is the point of the eighth-blocks: at width 24, 96 and 98 are the same whole cell.
    expect(stripAnsi(meter(96, 24))).not.toBe(stripAnsi(meter(98, 24)));
  });

  it('falls back to ASCII when the locale is not UTF-8', () => {
    process.env.LANG = 'C';
    expect(stripAnsi(meter(50, 10))).toBe('#####.....');
  });
});

describe('lockedMeter', () => {
  it('shows earned, locked and empty as three distinct runs', () => {
    const drawn = stripAnsi(lockedMeter(50, 25, 20));
    expect(drawn).toHaveLength(20);
    expect(drawn.startsWith('█'.repeat(10))).toBe(true);
    expect(drawn).toContain('▒');
    expect(drawn.endsWith('░')).toBe(true);
  });

  it('never overflows its width when earned and locked would sum past a hundred', () => {
    expect(visibleWidth(lockedMeter(80, 45, 20))).toBe(20);
  });
});

describe('sparkline', () => {
  it('draws one cell per value', () => {
    expect(stripAnsi(sparkline([1, 2, 3, 4]))).toHaveLength(4);
  });

  it('draws a flat run flat rather than dividing by zero', () => {
    expect(stripAnsi(sparkline([50, 50, 50]))).toBe('███');
  });
});

describe('box', () => {
  it('draws every row at the same width, title and tag included', () => {
    const drawn = box(['one', 'a much longer second line'], { title: 'OpenGEO', tag: 'v1.2.3', width: 40 });
    for (const line of drawn) expect(visibleWidth(line)).toBe(40);
  });

  it('clips a line that would otherwise push the right edge out', () => {
    const drawn = box(['x'.repeat(200)], { width: 30 });
    for (const line of drawn) expect(visibleWidth(line)).toBe(30);
  });
});

describe('listView', () => {
  it('marks exactly one row and leaves the rest unmarked', () => {
    const rows = listView(
      [
        { value: 'a', label: 'Test' },
        { value: 'b', label: 'Generate' },
      ],
      1,
    ).map(stripAnsi);
    expect(rows[0].trim().startsWith('Test')).toBe(true);
    expect(rows[1].trim().startsWith('▸')).toBe(true);
  });

  it('lines the notes up whatever the label lengths are', () => {
    const rows = listView(
      [
        { value: 'a', label: 'Test', note: 'score a URL' },
        { value: 'b', label: 'Prod check', note: 'probe the middleware' },
      ],
      0,
    ).map(stripAnsi);
    expect(rows[0].indexOf('score')).toBe(rows[1].indexOf('probe'));
  });
});

describe('textField', () => {
  it('shows the placeholder only while the value is empty', () => {
    expect(stripAnsi(textField('', 0, { placeholder: 'http://localhost:3000' }))).toBe('http://localhost:3000');
    expect(stripAnsi(textField('x', 1, { placeholder: 'http://localhost:3000' }))).toContain('x');
  });

  it('scrolls rather than overflowing once the value is longer than the box', () => {
    const long = 'https://example.com/a/deep/path/that/keeps/going';
    expect(visibleWidth(stripAnsi(textField(long, long.length, { width: 20 })))).toBeLessThanOrEqual(20);
  });
});

describe('key decoding', () => {
  it('reads the arrows in both the CSI and SS3 forms terminals actually send', () => {
    expect(decode(`${ESC}[A`).name).toBe('up');
    expect(decode(`${ESC}OB`).name).toBe('down');
  });

  it('reads enter, escape and the control keys a person will reach for', () => {
    expect(decode('\r').name).toBe('enter');
    expect(decode(ESC).name).toBe('escape');
    expect(decode('\x03').name).toBe('ctrl-c');
    expect(decode('\x7f').name).toBe('backspace');
  });

  it('gives a printable key back as its character', () => {
    expect(decode('q')).toEqual({ name: 'char', value: 'q' });
  });

  it('splits a chunk holding several keys, keeping each escape sequence whole', () => {
    expect(splitChunks(`a${ESC}[Bb`)).toEqual(['a', `${ESC}[B`, 'b']);
  });

  it('never reads a mouse report as typed text', () => {
    expect(decode(`${ESC}[<0;10;5M`).name).toBe('unknown');
  });
});

describe('the two score scales', () => {
  it('bands a structural score at 85 and 60', () => {
    expect(structuralBand(85)).toBe('good');
    expect(structuralBand(84)).toBe('fair');
    expect(structuralBand(59)).toBe('poor');
  });

  it('bands a content score lower, at 75 and 50, because a model rates prose lower', () => {
    expect(contentBand(75)).toBe('good');
    expect(contentBand(74)).toBe('fair');
    expect(contentBand(49)).toBe('poor');
  });
});

describe('colour helpers', () => {
  it('mixes towards the far end and stops there', () => {
    expect(mix(hex('#000000'), hex('#ffffff'), 0)).toEqual({ r: 0, g: 0, b: 0 });
    expect(mix(hex('#000000'), hex('#ffffff'), 1)).toEqual({ r: 255, g: 255, b: 255 });
    expect(mix(hex('#000000'), hex('#ffffff'), 2)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('expands a three-character hex the way CSS does', () => {
    expect(hex('#0f8')).toEqual(hex('#00ff88'));
  });
});

describe('terminalWidth', () => {
  it('stays inside its floor and its cap however wide the window is', () => {
    expect(terminalWidth()).toBeGreaterThanOrEqual(40);
    expect(terminalWidth()).toBeLessThanOrEqual(92);
  });
});
