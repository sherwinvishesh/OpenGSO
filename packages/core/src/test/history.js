import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ERRORS } from '../shared/errors.js';
import { writeFileAtomic } from '../shared/fs.js';

/** @import { SuiteResult, TestMode } from './suite.js' */

/**
 * Defined in `api-types.js` with every other shape the dashboard reads, and re-exported here.
 *
 * @typedef {import('../shared/api-types.js').HistoryEntry} HistoryEntry
 * @typedef {import('../shared/api-types.js').History} History
 */

/**
 * A short local record of what the score has been (§5).
 *
 * Nothing on disk recorded a test until this file existed, which had two visible costs: the
 * dashboard's staleness banner could only reach its strongest verdict in the session where a test
 * happened to run, and any home screen would have had nothing to show but the word "unknown".
 *
 * It lives in `internalDir` beside `manifest.json` on purpose. That directory is the one place the
 * generator guarantees is not web-served, and a public history of a site's own audit failures is
 * exactly the file an attacker would enjoy. `opengeo-prod` never reads it.
 *
 * It is a convenience, never a source of truth. Every read is best-effort: a corrupt or
 * hand-edited file yields an empty history rather than an exception, because a broken cache must
 * never be able to stop a test from running. Writing is not that relaxed: a file that cannot be
 * read is moved aside before a new one is written, so a bad read never turns into lost data.
 */

export const HISTORY_FILENAME = 'history.json';
export const HISTORY_VERSION = 1;

/**
 * How many runs to keep per URL. Enough for a sparkline and a week of work. Per URL because a
 * global cap let twenty runs against production evict every run of localhost, and with it the
 * trend the project was watching.
 */
export const HISTORY_LIMIT = 20;

/** A ceiling across every URL, so a script that tests a thousand pages cannot grow the file without bound. */
export const HISTORY_TOTAL_LIMIT = HISTORY_LIMIT * 10;

/**
 * @param {string} internalDir
 * @returns {string}
 */
export function historyPath(internalDir) {
  return join(internalDir, HISTORY_FILENAME);
}

/**
 * @returns {History}
 */
export function emptyHistory() {
  return { version: HISTORY_VERSION, entries: [] };
}

/**
 * @param {string} internalDir
 * @returns {History}
 */
export function readHistory(internalDir) {
  return loadHistory(internalDir).history;
}

/**
 * @param {string} internalDir
 * @returns {{ history: History; unreadable: boolean }} `unreadable` means a file is there and is not a history.
 */
function loadHistory(internalDir) {
  const path = historyPath(internalDir);
  if (!existsSync(path)) return { history: emptyHistory(), unreadable: false };
  try {
    const parsed = /** @type {Partial<History>} */ (JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed || !Array.isArray(parsed.entries)) return { history: emptyHistory(), unreadable: true };
    // A file written by a future version is read for what is recognisable rather than discarded:
    // the entries are additive, and losing a week of scores to a version bump would be rude.
    const entries = parsed.entries.filter(
      /**
       * @param {HistoryEntry} entry
       * @returns {entry is HistoryEntry}
       */
      (entry) => {
        return Boolean(entry) && typeof entry.at === 'string' && typeof entry.url === 'string';
      },
    );
    return { history: { version: HISTORY_VERSION, entries: trimEntries(entries) }, unreadable: false };
  } catch {
    return { history: emptyHistory(), unreadable: true };
  }
}

/**
 * The newest `HISTORY_LIMIT` runs of each URL, in their original order, within the overall ceiling.
 *
 * @param {HistoryEntry[]} entries
 * @returns {HistoryEntry[]}
 */
function trimEntries(entries) {
  /** @type {Map<string, number>} */
  const perUrl = new Map();
  /** @type {HistoryEntry[]} */
  const kept = [];
  for (let index = entries.length - 1; index >= 0 && kept.length < HISTORY_TOTAL_LIMIT; index -= 1) {
    const entry = /** @type {HistoryEntry} */ (entries[index]);
    const seen = perUrl.get(entry.url) ?? 0;
    if (seen >= HISTORY_LIMIT) continue;
    perUrl.set(entry.url, seen + 1);
    kept.push(entry);
  }
  return kept.reverse();
}

/**
 * @param {string} internalDir
 * @param {History} history
 * @returns {string}
 */
export function writeHistory(internalDir, history) {
  const path = historyPath(internalDir);
  /** @type {History} */
  const trimmed = { version: HISTORY_VERSION, entries: trimEntries(history.entries) };
  writeFileAtomic(path, `${JSON.stringify(trimmed, null, 2)}\n`);
  return path;
}

/**
 * Fold a finished suite into an entry. Pure, so the shape is testable without touching disk.
 *
 * @param {SuiteResult} result
 * @param {Date} [at]
 * @returns {HistoryEntry}
 */
export function entryFromSuite(result, at = new Date()) {
  const score = result.structure?.score;
  /** @type {HistoryEntry} */
  const entry = { at: at.toISOString(), url: result.url, mode: result.mode };
  if (score) {
    entry.score = score.value;
    entry.counts = { ...score.counts };
    if (score.locked && score.locked.points > 0) entry.lockedPoints = score.locked.points;
    const failed = result.structure?.checks.filter((check) => check.status === 'fail').map((check) => check.id) ?? [];
    if (failed.length > 0) entry.failedIds = failed;
  }
  if (result.content) entry.contentScore = result.content.score;
  return entry;
}

/**
 * @typedef {object} RecordOptions
 * @property {Date} [at]
 * @property {(message: string) => void} [onWarning] Told when an unreadable file was moved aside, so the user knows where it went.
 */

/**
 * Append a run, best-effort.
 *
 * Recording a score is never worth failing a test run over, so every filesystem error here is
 * swallowed: a read-only checkout, a `.opengeo` owned by root from a container mount, a full disk.
 * The caller gets `undefined` and carries on printing the report.
 *
 * A file that is there but cannot be read is renamed to `history.corrupt-<time>.json` first. If
 * that rename fails, nothing is written, so the file is never replaced by a history of one run.
 *
 * @param {string} internalDir
 * @param {SuiteResult} result
 * @param {RecordOptions} [options]
 * @returns {HistoryEntry | undefined}
 */
export function recordRun(internalDir, result, options = {}) {
  try {
    const { history, unreadable } = loadHistory(internalDir);
    if (unreadable) {
      const path = historyPath(internalDir);
      const aside = join(internalDir, `history.corrupt-${Date.now()}.json`);
      renameSync(path, aside);
      options.onWarning?.(ERRORS.historySetAside(path, aside));
    }
    const entry = entryFromSuite(result, options.at);
    history.entries.push(entry);
    writeHistory(internalDir, history);
    return entry;
  } catch {
    return undefined;
  }
}

/**
 * The most recent entry that actually carries a structural score.
 *
 * @param {History} history
 * @returns {HistoryEntry | undefined}
 */
export function lastScored(history) {
  for (let index = history.entries.length - 1; index >= 0; index -= 1) {
    const entry = history.entries[index];
    if (entry && typeof entry.score === 'number') return entry;
  }
  return undefined;
}

/**
 * @typedef {object} ScoreDelta
 * @property {number} points Points moved since the previous scored run of the same URL.
 * @property {HistoryEntry} previous The run it is being compared against.
 */

/**
 * How far the score moved since the last run of the same URL.
 *
 * Same URL matters: testing localhost and then production and calling the difference an improvement
 * would be a lie the report then repeats in bold. `current` is excluded by identity, so this works
 * whether it is called before or after the new entry is appended.
 *
 * @param {History} history
 * @param {HistoryEntry} current
 * @returns {ScoreDelta | undefined}
 */
export function deltaFor(history, current) {
  if (typeof current.score !== 'number') return undefined;
  for (let index = history.entries.length - 1; index >= 0; index -= 1) {
    const entry = history.entries[index];
    if (!entry || entry === current) continue;
    if (entry.url !== current.url) continue;
    if (typeof entry.score !== 'number') continue;
    return { points: current.score - entry.score, previous: entry };
  }
  return undefined;
}

/**
 * The structural scores for the same URL, oldest first, for a sparkline.
 *
 * @param {History} history
 * @param {string} [url]
 * @param {number} [limit]
 * @returns {number[]}
 */
export function scoreTrend(history, url, limit = 12) {
  /** @type {number[]} */
  const scores = [];
  for (const entry of history.entries) {
    if (typeof entry.score !== 'number') continue;
    if (url && entry.url !== url) continue;
    scores.push(entry.score);
  }
  return scores.slice(-limit);
}

/**
 * "just now", "2h ago", "3d ago". Used by the home screen and the report headline.
 *
 * @param {string} iso
 * @param {Date} [now]
 * @returns {string}
 */
export function relativeAge(iso, now = new Date()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}
