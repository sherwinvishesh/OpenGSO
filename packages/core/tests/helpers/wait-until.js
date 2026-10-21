/**
 * Polls until `condition` holds, or the deadline passes.
 *
 * The terminal tests used to wait with a fixed try count, 200 turns of 5 ms, which is a one-second
 * budget in disguise. A loaded CI runner spends that on startup alone: the home screen's copy test
 * took 1086 ms on ubuntu and failed with "never saw". A deadline in wall-clock time says what the
 * test means, and the message carries what the screen did show so a real failure can be read.
 *
 * @param {() => boolean} condition
 * @param {string | (() => string)} because What to say if it never happens.
 * @param {{ timeoutMs?: number; intervalMs?: number }} [options]
 * @returns {Promise<void>}
 */
export async function waitUntil(condition, because, options = {}) {
  const { timeoutMs = 4_000, intervalMs = 5 } = options;
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(typeof because === 'function' ? because() : because);
    await new Promise((done) => setTimeout(done, intervalMs));
  }
}
