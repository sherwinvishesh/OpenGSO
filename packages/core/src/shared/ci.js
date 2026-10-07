/**
 * The CI gate, on its own so the terminal code can ask it without importing env.js and, through it,
 * the provider catalogue. It reads only the environment.
 */

/**
 * Anything AI-touched is local-machine-only (§5, §6, §16). This is the enforcement point, not a
 * doc comment: generate's AI tier and `test --quality` both call it and refuse under CI.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isCI(env = process.env) {
  return [env.CI, env.CONTINUOUS_INTEGRATION, env.GITHUB_ACTIONS, env.GITLAB_CI, env.CIRCLECI, env.BUILDKITE].some(isSet);
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
