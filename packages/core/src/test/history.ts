import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SuiteResult } from './suite.js';
import type { TestMode } from './suite.js';

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
 * never be able to stop a test from running.
 */

export const HISTORY_FILENAME = 'history.json';
export const HISTORY_VERSION = 1;

/** How many runs to keep. Enough for a sparkline and a week of work, small enough to stay hand-readable. */
export const HISTORY_LIMIT = 20;

export interface HistoryEntry {
  /** ISO timestamp of when the run finished. */
  at: string;
  url: string;
  mode: TestMode;
  /** The structural 0-100. Absent in `content` mode, which never runs the checks. */
  score?: number;
  /** The content 0-100, kept separate from the structural one exactly as §5 requires. */
  contentScore?: number;
  counts?: { pass: number; partial: number; fail: number; locked: number; na: number };
  /** Points sitting behind a locked check, so the home screen can price the next fix. */
  lockedPoints?: number;
  /** Ids of the checks that actually failed, so a delta can say what changed rather than only by how much. */
  failedIds?: string[];
}

export interface History {
  version: number;
  entries: HistoryEntry[];
}

export function historyPath(internalDir: string): string {
  return join(internalDir, HISTORY_FILENAME);
}

export function emptyHistory(): History {
  return { version: HISTORY_VERSION, entries: [] };
}

export function readHistory(internalDir: string): History {
  const path = historyPath(internalDir);
  if (!existsSync(path)) return emptyHistory();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<History>;
    if (!parsed || !Array.isArray(parsed.entries)) return emptyHistory();
    // A file written by a future version is read for what is recognisable rather than discarded:
    // the entries are additive, and losing a week of scores to a version bump would be rude.
    const entries = parsed.entries.filter((entry): entry is HistoryEntry => {
      return Boolean(entry) && typeof entry.at === 'string' && typeof entry.url === 'string';
    });
    return { version: HISTORY_VERSION, entries: entries.slice(-HISTORY_LIMIT) };
  } catch {
    return emptyHistory();
  }
}

export function writeHistory(internalDir: string, history: History): string {
  const path = historyPath(internalDir);
  mkdirSync(dirname(path), { recursive: true });
  const trimmed: History = { version: HISTORY_VERSION, entries: history.entries.slice(-HISTORY_LIMIT) };
  writeFileSync(path, `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8');
  return path;
}

/** Fold a finished suite into an entry. Pure, so the shape is testable without touching disk. */
export function entryFromSuite(result: SuiteResult, at = new Date()): HistoryEntry {
  const score = result.structure?.score;
  const entry: HistoryEntry = { at: at.toISOString(), url: result.url, mode: result.mode };
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
 * Append a run, best-effort.
 *
 * Recording a score is never worth failing a test run over, so every filesystem error here is
 * swallowed: a read-only checkout, a `.opengeo` owned by root from a container mount, a full disk.
 * The caller gets `undefined` and carries on printing the report.
 */
export function recordRun(internalDir: string, result: SuiteResult, at = new Date()): HistoryEntry | undefined {
  try {
    const history = readHistory(internalDir);
    const entry = entryFromSuite(result, at);
    history.entries.push(entry);
    writeHistory(internalDir, history);
    return entry;
  } catch {
    return undefined;
  }
}

/** The most recent entry that actually carries a structural score. */
export function lastScored(history: History): HistoryEntry | undefined {
  for (let index = history.entries.length - 1; index >= 0; index -= 1) {
    const entry = history.entries[index];
    if (entry && typeof entry.score === 'number') return entry;
  }
  return undefined;
}

export interface ScoreDelta {
  /** Points moved since the previous scored run of the same URL. */
  points: number;
  /** The run it is being compared against. */
  previous: HistoryEntry;
}

/**
 * How far the score moved since the last run of the same URL.
 *
 * Same URL matters: testing localhost and then production and calling the difference an improvement
 * would be a lie the report then repeats in bold. `current` is excluded by identity, so this works
 * whether it is called before or after the new entry is appended.
 */
export function deltaFor(history: History, current: HistoryEntry): ScoreDelta | undefined {
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

/** The structural scores for the same URL, oldest first, for a sparkline. */
export function scoreTrend(history: History, url?: string, limit = 12): number[] {
  const scores: number[] = [];
  for (const entry of history.entries) {
    if (typeof entry.score !== 'number') continue;
    if (url && entry.url !== url) continue;
    scores.push(entry.score);
  }
  return scores.slice(-limit);
}

/** "just now", "2h ago", "3d ago". Used by the home screen and the report headline. */
export function relativeAge(iso: string, now = new Date()): string {
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
