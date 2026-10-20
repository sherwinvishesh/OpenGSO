import { resolveAiCall } from '../shared/ai-call.js';
import { isCI } from '../shared/env.js';
import { ERRORS } from '../shared/errors.js';

/**
 * @import { OmniGeoConfig } from '../shared/config.js'
 * @import { SuiteAi } from '../test/index.js'
 * @import { ApiProgress } from '../shared/api-types.js'
 */

/**
 * What every route of the local API shares: the request and response shapes, the two reply
 * helpers, and the one answer to whether an AI call can be made.
 */

/**
 * @typedef {object} ApiRequest
 * @property {string} method
 * @property {string} path
 * @property {unknown} body
 */

/**
 * @typedef {object} ApiResponse
 * @property {number} status
 * @property {unknown} body
 */

/**
 * @typedef {object} ApiOptions
 * @property {string} root Project root. Fixed for the lifetime of the server: the browser cannot ask
 *   for another.
 * @property {string} version
 * @property {string} packageName
 * @property {(event: ApiProgress) => void} [onProgress] Set by the transport for the `/stream`
 *   routes, absent everywhere else.
 *
 *   An endpoint that takes minutes has to be able to say so while it is still working, and the two
 *   that do already accept an `onProgress` from the CLI. This is the same callback, one hop further
 *   out, so the dashboard watches exactly what the terminal watches.
 * @property {AbortSignal} [signal] Aborted by the transport when the browser that asked goes away,
 *   so a closed tab stops the crawl and the paid calls instead of finishing for nobody.
 */

/**
 * @param {unknown} body
 * @returns {ApiResponse}
 */
export const ok = (body) => ({ status: 200, body });
/**
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 * @returns {ApiResponse}
 */
export const bad = (message, extra = {}) => ({
  status: 400,
  body: { error: message, ...extra },
});

/**
 * One place that answers "can we make an AI call, and to what".
 *
 * The endpoint overrides travel with the credentials because they are half the address: a key
 * without the gateway it belongs to points at the wrong host, which is the one failure mode §11
 * cares about most.
 *
 * @param {string} root
 * @param {OmniGeoConfig} config
 * @param {string} feature
 * @returns {SuiteAi | { error: string }}
 */
export function resolveCredentials(root, config, feature) {
  if (isCI()) return { error: ERRORS.ciBlocked(feature) };
  const resolved = resolveAiCall(root, config);
  if ('error' in resolved) return resolved;
  if ('missing' in resolved) return { error: ERRORS.noApiKey(feature, resolved.lookalikes) };
  const { keySource: _source, ...ai } = resolved.call;
  return ai;
}
