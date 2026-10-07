/**
 * The CI gate, on its own so the terminal code can ask it without importing env.js and, through it,
 * the provider catalogue. It reads only the environment.
 */

/** Every variable a CI service is known to set. A test that wants a terminal has to clear all of them. */
export const CI_VARIABLES = ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'BUILDKITE'];

/**
 * Anything AI-touched is local-machine-only (§5, §6, §16). This is the enforcement point, not a
 * doc comment: generate's AI tier and `test --quality` both call it and refuse under CI.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isCI(env = process.env) {
  return CI_VARIABLES.some((name) => isSet(env[name]));
}

/**
 * `CI=false` and `CI=0` are how people switch CI detection off, for a local run of a CI script or
 * a container that sets it by default. Reading any non-empty string as true refused the AI tier
 * there.
 *
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isSet(value) {
  const normal = value?.trim().toLowerCase();
  return Boolean(normal) && normal !== 'false' && normal !== '0';
}
