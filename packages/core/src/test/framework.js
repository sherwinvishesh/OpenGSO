import { detectFramework } from '../shared/framework.js';

/** @import { ProbeResult } from '../shared/http.js' */

/**
 * Framework detection for the report and the fix prompt. The table itself is in
 * `shared/framework.js`, which setup's site preview reads too.
 *
 * @typedef {import('../shared/framework.js').Framework} Framework
 * @typedef {import('../shared/framework.js').FrameworkId} FrameworkId
 */

export { detectFramework };

/**
 * Convenience for the report and the prompt, which both work from gathered evidence.
 *
 * @param {ProbeResult} html
 * @returns {Framework | undefined}
 */
export function detectFrameworkFrom(html) {
  if (!html.body) return undefined;
  return detectFramework(html.body, html.headers);
}
