import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HISTORY_LIMIT,
  deltaFor,
  emptyHistory,
  entryFromSuite,
  historyPath,
  lastScored,
  locked,
  fail,
  pass,
  partial,
  readHistory,
  recordRun,
  relativeAge,
  scoreChecks,
  scoreTrend,
  writeHistory,
} from '@opengso/core/test';

// Windows has no POSIX permission bits: Node reports 0o666 for any writable file whatever was asked.
const posixModes = process.platform !== 'win32';

/** @import { CheckResult, ContentReview, Evidence, History, HistoryEntry, SuiteResult, TestMode, TestResult } from '@opengso/core/test' */

/**
 * The run history, which is a cache and must behave like one.
 *
 * Two properties matter more than the rest and are pinned hardest below. A delta is only ever drawn
 * between two runs of the same URL, because "+40 since this morning" when the morning run was
 * localhost and this one is production is a lie the report would then repeat in bold. And every
 * read and write is best-effort: a corrupt, truncated or unwritable file yields an empty history
 * rather than an exception, because a broken cache must never be able to stop a test from running.
 */

/** @type {Array<() => void>} */
const cleanups = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** @returns {string} */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'opengso-history-'));
}

/** History never reads evidence, so an empty stand-in keeps these fixtures about scores. */
const EVIDENCE = /** @type {Evidence} */ ({});

/**
 * @typedef {object} SuiteShape
 * @property {string} [url]
 * @property {TestMode} [mode]
 * @property {CheckResult[]} [checks]
 * @property {number} [contentScore]
 */

/**
 * @param {SuiteShape} [shape]
 * @returns {SuiteResult}
 */
function suite(shape = {}) {
  const url = shape.url ?? 'https://example.com/';
  const mode = shape.mode ?? 'structure';
  const checks = shape.checks ?? [pass('A1', 'robots.txt allows every AI agent.')];
  /** @type {TestResult} */
  const structure = { url, twinUrl: `${url}index.md`, checks, score: scoreChecks(checks), evidence: EVIDENCE };
  /** @type {SuiteResult} */
  const result = { mode, url, structure: mode === 'content' ? undefined : structure };
  if (typeof shape.contentScore === 'number') {
    result.content = /** @type {ContentReview} */ ({ score: shape.contentScore });
  }
  return result;
}

/**
 * @param {Partial<HistoryEntry>} [overrides]
 * @returns {HistoryEntry}
 */
function entry(overrides = {}) {
  return { at: '2026-01-01T00:00:00.000Z', url: 'https://example.com/', mode: 'structure', score: 50, ...overrides };
}

describe('folding a run into an entry', () => {
  it('records the structural score, the counts and the ids that failed', () => {
    const checks = [pass('A1', 'allowed'), fail('A2', 'no llms.txt'), partial('B7', 2, 'on one response of two')];
    const folded = entryFromSuite(suite({ checks }), new Date('2026-03-01T12:00:00.000Z'));

    expect(folded.at).toBe('2026-03-01T12:00:00.000Z');
    expect(folded.url).toBe('https://example.com/');
    expect(folded.mode).toBe('structure');
    expect(folded.score).toBe(scoreChecks(checks).value);
    expect(folded.counts).toEqual({ pass: 1, partial: 1, fail: 1, locked: 0, na: 0 });
    // A partial is not a failure, so it must not appear here: the home screen prices the next fix
    // off this list, and B7 already earned half its points.
    expect(folded.failedIds).toEqual(['A2']);
  });

  it('records how many suggestions the site has adopted, locked ones counted as not yet', () => {
    const checks = [pass('A2', 'llms.txt'), fail('B1', 'no twin'), locked('B2', 'B1', 'nothing to inspect'), locked('B3', 'B1', 'nothing to inspect')];
    const folded = entryFromSuite(suite({ checks }));

    expect(folded.counts?.locked).toBe(2);
    expect(folded.suggestions).toEqual({ adopted: 1, count: 4 });
  });

  it('leaves the optional fields off a clean run rather than writing zeroes', () => {
    const folded = entryFromSuite(suite({ checks: [pass('A1', 'allowed')] }));

    expect(folded.failedIds).toBeUndefined();
    expect(folded.suggestions).toBeUndefined();
    expect(folded.contentScore).toBeUndefined();
  });

  it('keeps the content score as its own number', () => {
    const folded = entryFromSuite(suite({ mode: 'full', contentScore: 71 }));

    expect(folded.contentScore).toBe(71);
    expect(folded.score).not.toBe(71);
  });

  it('has no structural score in content mode, which never runs the checks', () => {
    const folded = entryFromSuite(suite({ mode: 'content', contentScore: 64 }));

    expect(folded.score).toBeUndefined();
    expect(folded.counts).toBeUndefined();
    expect(folded.contentScore).toBe(64);
  });
});

describe('reading and writing', () => {
  it('reads an empty history from a directory that does not exist yet', () => {
    expect(readHistory(join(scratch(), 'nope', '.opengso'))).toEqual(emptyHistory());
  });

  it('round-trips through the file it says it writes', () => {
    const dir = scratch();
    const written = writeHistory(dir, { version: 1, entries: [entry()] });

    expect(written).toBe(historyPath(dir));
    expect(readHistory(dir).entries).toEqual([entry()]);
  });

  it('keeps the file hand-readable, which is the reason it is JSON at all', () => {
    const dir = scratch();
    writeHistory(dir, { version: 1, entries: [entry()] });
    const raw = readFileSync(historyPath(dir), 'utf8');

    expect(raw).toContain('\n  "entries"');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('creates the internal directory on the way', () => {
    const dir = join(scratch(), 'nested', '.opengso');
    writeHistory(dir, { version: 1, entries: [entry()] });

    expect(readHistory(dir).entries).toHaveLength(1);
  });

  it(`caps the file at ${HISTORY_LIMIT} runs, keeping the newest`, () => {
    const dir = scratch();
    const many = Array.from({ length: HISTORY_LIMIT + 7 }, (_, index) => entry({ score: index }));
    writeHistory(dir, { version: 1, entries: many });

    const back = readHistory(dir);
    expect(back.entries).toHaveLength(HISTORY_LIMIT);
    expect(back.entries[0]?.score).toBe(7);
    expect(back.entries.at(-1)?.score).toBe(HISTORY_LIMIT + 6);
  });

  it('yields an empty history for a corrupt file instead of throwing', () => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    writeFileSync(historyPath(dir), '{ this is not json', 'utf8');

    expect(readHistory(dir)).toEqual(emptyHistory());
  });

  it('yields an empty history when the file is the wrong shape', () => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    writeFileSync(historyPath(dir), '{"version":1,"entries":"nope"}', 'utf8');

    expect(readHistory(dir)).toEqual(emptyHistory());
  });

  it('drops junk entries but keeps the readable ones around them', () => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      historyPath(dir),
      JSON.stringify({ version: 1, entries: [entry(), null, { score: 12 }, entry({ score: 90 })] }),
      'utf8',
    );

    expect(readHistory(dir).entries.map((item) => item.score)).toEqual([50, 90]);
  });

  it('reads a file written by a later version for what it recognises', () => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    writeFileSync(historyPath(dir), JSON.stringify({ version: 99, entries: [entry({ score: 77 })] }), 'utf8');

    const back = readHistory(dir);
    expect(back.version).toBe(1);
    expect(back.entries[0]?.score).toBe(77);
  });
});

describe('recording a run', () => {
  it('appends to what is already there', () => {
    const dir = scratch();
    recordRun(dir, suite({ checks: [fail('A2', 'missing')] }), { at: new Date('2026-01-01T00:00:00.000Z') });
    const second = recordRun(dir, suite({ checks: [pass('A2', 'there')] }), { at: new Date('2026-01-02T00:00:00.000Z') });

    const entries = readHistory(dir).entries;
    expect(entries).toHaveLength(2);
    expect(entries.at(-1)).toEqual(second);
  });

  it('sets a file it cannot read aside instead of writing over it, and says where', () => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    // What a crash in the middle of a non-atomic write, or a hand edit gone wrong, leaves behind.
    const truncated = JSON.stringify({ version: 1, entries: [entry(), entry({ score: 60 })] }).slice(0, 70);
    writeFileSync(historyPath(dir), truncated, 'utf8');

    /** @type {string[]} */
    const warnings = [];
    const recorded = recordRun(dir, suite(), { onWarning: (message) => warnings.push(message) });

    expect(recorded).toBeDefined();
    expect(readHistory(dir).entries).toEqual([recorded]);
    const aside = readdirSync(dir).filter((name) => name.startsWith('history.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, /** @type {string} */ (aside[0])), 'utf8')).toBe(truncated);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(/** @type {string} */ (aside[0]));
  });

  it('says nothing when there was simply no file yet', () => {
    const dir = scratch();
    /** @type {string[]} */
    const warnings = [];
    recordRun(dir, suite(), { onWarning: (message) => warnings.push(message) });

    expect(warnings).toEqual([]);
    expect(readdirSync(dir)).toEqual(['history.json']);
  });

  it(`keeps ${HISTORY_LIMIT} runs per URL, so testing production does not evict localhost's trend`, () => {
    const dir = scratch();
    const local = Array.from({ length: 5 }, (_, index) => entry({ url: 'http://localhost:3000/', score: index }));
    const prod = Array.from({ length: HISTORY_LIMIT + 3 }, (_, index) => entry({ url: 'https://example.com/', score: 50 + index }));
    writeHistory(dir, { version: 1, entries: [...local, ...prod] });

    const back = readHistory(dir);
    expect(scoreTrend(back, 'http://localhost:3000/', 99)).toEqual([0, 1, 2, 3, 4]);
    expect(scoreTrend(back, 'https://example.com/', 99)).toHaveLength(HISTORY_LIMIT);
    expect(scoreTrend(back, 'https://example.com/', 99).at(-1)).toBe(50 + HISTORY_LIMIT + 2);
  });

  // A read-only folder is how this test breaks the cache, and Windows ignores the mode bits.
  it.runIf(posixModes)('never lets a broken cache stop a test run', () => {
    const dir = scratch();
    const blocked = join(dir, 'locked');
    mkdirSync(blocked, { recursive: true });
    chmodSync(blocked, 0o500);
    cleanups.push(() => chmodSync(blocked, 0o700));

    expect(recordRun(join(blocked, '.opengso'), suite())).toBeUndefined();
  });
});

describe('the delta between two runs', () => {
  it('compares against the previous run of the same URL', () => {
    /** @type {History} */
    const history = {
      version: 1,
      entries: [entry({ score: 40, at: '2026-01-01T00:00:00.000Z' }), entry({ score: 62, at: '2026-01-02T00:00:00.000Z' })],
    };
    const current = entry({ score: 85, at: '2026-01-03T00:00:00.000Z' });

    const delta = deltaFor(history, current);
    expect(delta?.points).toBe(23);
    expect(delta?.previous.score).toBe(62);
  });

  it('reports a drop as a negative number rather than hiding it', () => {
    /** @type {History} */
    const history = { version: 1, entries: [entry({ score: 90 })] };

    expect(deltaFor(history, entry({ score: 74 }))?.points).toBe(-16);
  });

  it('will not compare across URLs, because that difference is not an improvement', () => {
    /** @type {History} */
    const history = { version: 1, entries: [entry({ url: 'http://localhost:3000/', score: 30 })] };

    expect(deltaFor(history, entry({ url: 'https://example.com/', score: 95 }))).toBeUndefined();
  });

  it('skips runs of other URLs to find the right one to compare against', () => {
    /** @type {History} */
    const history = {
      version: 1,
      entries: [entry({ score: 55 }), entry({ url: 'http://localhost:3000/', score: 12 })],
    };

    expect(deltaFor(history, entry({ score: 60 }))?.points).toBe(5);
  });

  it('gives the same answer whether the new entry has been appended or not', () => {
    const current = entry({ score: 85 });
    /** @type {History} */
    const before = { version: 1, entries: [entry({ score: 62 })] };
    /** @type {History} */
    const after = { version: 1, entries: [entry({ score: 62 }), current] };

    expect(deltaFor(after, current)?.points).toBe(deltaFor(before, current)?.points);
  });

  it('has nothing to say about the first run, or about a content-only one', () => {
    expect(deltaFor(emptyHistory(), entry())).toBeUndefined();
    expect(deltaFor({ version: 1, entries: [entry()] }, entry({ score: undefined }))).toBeUndefined();
  });

  it('ignores entries that carry no structural score', () => {
    /** @type {History} */
    const history = { version: 1, entries: [entry({ score: 44 }), entry({ score: undefined, mode: 'content' })] };

    expect(deltaFor(history, entry({ score: 50 }))?.previous.score).toBe(44);
  });
});

describe('the trend and the last score', () => {
  it('returns the scores oldest first, so a sparkline reads left to right', () => {
    /** @type {History} */
    const history = { version: 1, entries: [entry({ score: 20 }), entry({ score: 55 }), entry({ score: 91 })] };

    expect(scoreTrend(history)).toEqual([20, 55, 91]);
  });

  it('filters to one URL when asked', () => {
    /** @type {History} */
    const history = {
      version: 1,
      entries: [entry({ score: 20 }), entry({ url: 'http://localhost:3000/', score: 99 }), entry({ score: 55 })],
    };

    expect(scoreTrend(history, 'https://example.com/')).toEqual([20, 55]);
    expect(scoreTrend(history, 'https://nothing.example/')).toEqual([]);
  });

  it('keeps the most recent runs when there are more than the limit', () => {
    /** @type {History} */
    const history = { version: 1, entries: Array.from({ length: 30 }, (_, index) => entry({ score: index })) };

    expect(scoreTrend(history, undefined, 12)).toHaveLength(12);
    expect(scoreTrend(history, undefined, 12).at(-1)).toBe(29);
    expect(scoreTrend(history, undefined, 3)).toEqual([27, 28, 29]);
  });

  it('finds the last run that actually scored, past any content-only ones', () => {
    /** @type {History} */
    const history = {
      version: 1,
      entries: [entry({ score: 81 }), entry({ score: undefined, mode: 'content' }), entry({ score: undefined, mode: 'content' })],
    };

    expect(lastScored(history)?.score).toBe(81);
    expect(lastScored(emptyHistory())).toBeUndefined();
  });
});

describe('relative age', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  /** @param {number} ms */
  const ago = (ms) => relativeAge(new Date(now.getTime() - ms).toISOString(), now);

  it('says "just now" under a minute', () => {
    expect(ago(0)).toBe('just now');
    expect(ago(59_000)).toBe('just now');
  });

  it('counts minutes, then hours, then days, then months', () => {
    expect(ago(60_000)).toBe('1m ago');
    expect(ago(45 * 60_000)).toBe('45m ago');
    expect(ago(2 * 3_600_000)).toBe('2h ago');
    expect(ago(3 * 86_400_000)).toBe('3d ago');
    expect(ago(120 * 86_400_000)).toBe('4mo ago');
  });

  it('never reads as being in the future when a clock has drifted', () => {
    expect(relativeAge(new Date(now.getTime() + 90_000).toISOString(), now)).toBe('just now');
  });

  it('says "unknown" for a timestamp it cannot parse', () => {
    expect(relativeAge('not a date')).toBe('unknown');
  });
});
