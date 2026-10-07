import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROGRESS_METER_WIDTH, canRedraw, createProgress, progressLineWidth } from '../src/cli/progress.js';
import { stripAnsi, visibleWidth } from '../src/cli/tui/paint.js';

/**
 * The live progress block, and the plain transcript it falls back to.
 *
 * The thing worth guarding is not how pretty the block is: it is that a pipe, a CI log and
 * `NO_COLOR` get no escape codes at all. Progress output that corrupts a log file is worse than no
 * progress output, and the only way to be sure is to assert on the bytes.
 */

const ESC = String.fromCharCode(27);

/**
 * The most recent frame drawn, with the escapes taken out: what the eye would actually see.
 * @param {string} text
 * @returns {string[]}
 */
function lastFrame(text) {
  return stripAnsi(text).split('\n').filter((line) => line.trim().length > 0);
}

/**
 * A writable that records what was written and can claim to be a terminal, or not.
 * @param {boolean} isTTY
 * @param {number} [columns]
 * @returns {NodeJS.WriteStream & { text: () => string; chunks: string[] }}
 */
function fakeStream(isTTY, columns = 80) {
  /** @type {string[]} */
  const chunks = [];
  const stream = {
    isTTY,
    columns,
    rows: 24,
    /** @param {string} chunk */
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    chunks,
    text: () => chunks.join(''),
  };
  return /** @type {NodeJS.WriteStream & { text: () => string; chunks: string[] }} */ (/** @type {unknown} */ (stream));
}

const ENV = { ...process.env };

beforeEach(() => {
  delete process.env.CI;
  delete process.env.OPENGEO_NO_TUI;
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = '3';
  process.env.LANG = 'en_US.UTF-8';
  delete process.env.LC_ALL;
  delete process.env.LC_CTYPE;
  // Windows decides by terminal rather than by locale.
  process.env.WT_SESSION = 'test';
  delete process.env.OPENGEO_ASCII;
});

afterEach(() => {
  process.env = { ...ENV };
  vi.useRealTimers();
});

describe('choosing a mode', () => {
  it('redraws on a colour terminal', () => {
    expect(canRedraw(fakeStream(true))).toBe(true);
  });

  it('does not redraw into a pipe', () => {
    expect(canRedraw(fakeStream(false))).toBe(false);
  });

  it('does not redraw in CI, whatever the terminal claims', () => {
    process.env.CI = '1';
    expect(canRedraw(fakeStream(true))).toBe(false);
  });

  it('does not redraw when colour is off, because NO_COLOR usually means "I am capturing this"', () => {
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = '1';
    expect(canRedraw(fakeStream(true))).toBe(false);
  });

  it('takes OPENGEO_NO_TUI as the escape hatch', () => {
    process.env.OPENGEO_NO_TUI = '1';
    expect(canRedraw(fakeStream(true))).toBe(false);
  });
});

describe('the plain transcript', () => {
  it('writes no escape codes at all when colour is off, which is what a log file gets', () => {
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = '1';
    const out = fakeStream(false);
    const progress = createProgress({ output: out });
    progress.phase('Converting pages');
    progress.step(1, 4, '/about');
    progress.step(2, 4, '/pricing');
    progress.note('A warning that has to survive.');
    progress.done('Done.');
    expect(out.text()).not.toContain(ESC);
  });

  it('keeps the [done/total] route shape the CLI has always printed', () => {
    const out = fakeStream(false);
    const progress = createProgress({ output: out });
    progress.phase('Converting pages');
    progress.step(3, 10, '/docs/install');
    expect(stripAnsi(out.text())).toContain('\n  Converting pages\n');
    expect(stripAnsi(out.text())).toContain('  [3/10] /docs/install\n');
  });

  it('never moves the cursor, whatever the colour setting, because a log is not a screen', () => {
    const out = fakeStream(false);
    const progress = createProgress({ output: out });
    progress.phase('Converting pages');
    progress.step(1, 4, '/about');
    progress.note('Something happened.');
    progress.finish();
    progress.done('Done.');
    // Colour is allowed here (the caller forced it); cursor movement and erasure are not.
    expect(out.text()).not.toMatch(/\u001b\[\d*[ABCDJK]/);
  });

  it('drops the total when the size is not known yet', () => {
    const out = fakeStream(false);
    const progress = createProgress({ output: out });
    progress.phase('Crawling');
    progress.step(7, 0);
    expect(stripAnsi(out.text())).toContain('  [7]\n');
  });

  it('can be forced even on a terminal, so a caller can opt out', () => {
    const out = fakeStream(true);
    createProgress({ output: out, plain: true }).phase('Auditing');
    expect(out.text()).not.toMatch(/\u001b\[\d*[ABCDJK]/);
  });
});

describe('the live block', () => {
  it('paints a spinner, the phase, a meter and the counter', () => {
    const out = fakeStream(true);
    const progress = createProgress({ output: out });
    progress.phase('Converting pages');
    progress.step(3, 12, '/docs/install');
    const plain = stripAnsi(out.text());
    expect(plain).toContain('Converting pages');
    expect(plain).toContain('3/12');
    expect(plain).toContain('/docs/install');
    progress.done();
  });

  it('moves the cursor back over its own block rather than appending', () => {
    const out = fakeStream(true);
    const progress = createProgress({ output: out });
    progress.phase('Crawling');
    progress.step(1, 4, '/a');
    out.chunks.length = 0;
    progress.step(2, 4, '/b');
    // Two lines up and erase down: the previous frame is overwritten, not scrolled past.
    expect(out.text()).toContain(`${ESC}[2A${ESC}[0J`);
    progress.done();
  });

  it('never draws wider than the terminal', () => {
    const out = fakeStream(true, 40);
    const progress = createProgress({ output: out });
    progress.phase('Converting a page with a very long name indeed');
    progress.step(1, 3, '/an/extremely/long/route/that/will/not/fit/in/forty/columns');
    for (const line of lastFrame(out.text())) expect(line.length).toBeLessThanOrEqual(40);
    progress.done();
  });

  it('leaves a note in scrollback and redraws the block under it', () => {
    const out = fakeStream(true);
    const progress = createProgress({ output: out });
    progress.phase('Crawling');
    progress.step(1, 4, '/a');
    out.chunks.length = 0;
    progress.note('Skipped /private: robots.txt disallows it.');
    const plain = stripAnsi(out.text());
    expect(plain).toContain('Skipped /private');
    // The block comes back after the note, so the run does not look like it stopped.
    expect(plain).toContain('Crawling');
    progress.done();
  });

  it('clears the block on finish, so the report is not printed under a spinner', () => {
    const out = fakeStream(true);
    const progress = createProgress({ output: out });
    progress.phase('Auditing the live URL');
    out.chunks.length = 0;
    progress.finish();
    expect(out.text()).toBe(`${ESC}[1A${ESC}[0J`);
    progress.done();
  });

  it('goes quiet between phases instead of redrawing a finished one', () => {
    vi.useFakeTimers();
    const out = fakeStream(true);
    const progress = createProgress({ output: out });
    progress.phase('Auditing the live URL');
    progress.finish();
    out.chunks.length = 0;
    vi.advanceTimersByTime(1000);
    expect(out.text()).toBe('');
    progress.done();
  });

  it('stops painting for good once done', () => {
    vi.useFakeTimers();
    const out = fakeStream(true);
    const progress = createProgress({ output: out });
    progress.phase('Crawling');
    progress.done('Wrote 12 files.');
    out.chunks.length = 0;
    progress.step(9, 9, '/late');
    vi.advanceTimersByTime(1000);
    expect(out.text()).toBe('');
  });

  it('writes its summary after clearing, not over the top of the block', () => {
    const out = fakeStream(true);
    const progress = createProgress({ output: out });
    progress.phase('Crawling');
    out.chunks.length = 0;
    progress.done('Found 12 routes.');
    expect(out.text()).toBe(`${ESC}[1A${ESC}[0J` + 'Found 12 routes.\n');
  });
});

describe('the frame itself', () => {
  it('measures printable width, not byte length', () => {
    const out = fakeStream(true, 60);
    const progress = createProgress({ output: out });
    progress.phase('Crawling');
    progress.step(2, 8, '/a');
    const rendered = /** @type {string} */ (out.text().split('\n').at(-2));
    expect(progressLineWidth(rendered)).toBe(visibleWidth(rendered));
    expect(progressLineWidth(rendered)).toBeLessThan(rendered.length);
    progress.done();
  });

  it('draws the meter at the width it advertises', () => {
    const out = fakeStream(true, 120);
    const progress = createProgress({ output: out });
    progress.phase('X');
    progress.step(0, 10, '');
    // At zero the meter is all empty cells, so counting them counts the whole bar.
    const line = /** @type {string} */ (lastFrame(out.text()).at(-1));
    expect([...line].filter((glyph) => glyph === '░').length).toBe(PROGRESS_METER_WIDTH);
    progress.done();
  });
});
