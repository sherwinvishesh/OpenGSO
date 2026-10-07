/**
 * The long-running work in flight, by kind.
 *
 * A run belongs to the page, not to the screen that started it. Screens stay alive when hidden, so
 * leaving the Test tab mid-run and coming back finds the same run with its progress. This module
 * adds the two things a screen cannot do alone: a second start while one is live joins it rather
 * than paying for an overlapping content review, and closing the page aborts everything, which
 * closes the connection so the server stops too.
 */

/** @typedef {'test' | 'generate' | 'prod'} RunKind */

/** @type {Map<RunKind, { controller: AbortController; promise: Promise<unknown> }>} */
const live = new Map();

/**
 * @template T
 * @param {RunKind} kind
 * @param {(signal: AbortSignal) => Promise<T>} task
 * @returns {Promise<T>}
 */
export function startRun(kind, task) {
  const existing = live.get(kind);
  if (existing) return /** @type {Promise<T>} */ (existing.promise);
  const controller = new AbortController();
  const promise = task(controller.signal).finally(() => {
    if (live.get(kind)?.controller === controller) live.delete(kind);
  });
  live.set(kind, { controller, promise });
  return promise;
}

/** @param {RunKind} kind */
export function isRunning(kind) {
  return live.has(kind);
}

export function abortAll() {
  for (const { controller } of live.values()) controller.abort();
  live.clear();
}

/** @param {unknown} error */
export function isAbort(error) {
  return error instanceof Error && error.name === 'AbortError';
}
