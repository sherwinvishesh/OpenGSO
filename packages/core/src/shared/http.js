/**
 * A single fetch wrapper for every HTTP call OpenGEO makes.
 *
 * It records TTFB because `test` scores it (§5A), and it never throws on a non-2xx: check code
 * wants the failing status and headers, not an exception.
 */

/**
 * @typedef {object} ProbeResult
 * @property {string} url
 * @property {boolean} ok
 * @property {number} status
 * @property {Headers} headers
 * @property {string} body
 * @property {number} ttfbMs Milliseconds from request start to first byte of the response head.
 * @property {number} totalMs Milliseconds to a fully-read body.
 * @property {boolean} redirected
 * @property {string} finalUrl
 * @property {boolean} [truncated] The body stopped at `maxBytes`. What is in `body` is the start of
 *   it, not all of it.
 * @property {string} [error]
 */

/**
 * @typedef {object} ProbeOptions
 * @property {Record<string, string>} [headers]
 * @property {string} [method]
 * @property {number} [timeoutMs]
 * @property {boolean} [headOnly] Skip reading the body - used by header-only checks.
 * @property {RequestRedirect} [redirect]
 * @property {number} [maxBytes] Stop reading after this many bytes. Defaults to
 *   {@link MAX_PROBE_BYTES}.
 * @property {(headers: Headers) => boolean} [readBody] Decide from the headers whether the body is
 *   worth downloading at all.
 */

/**
 * The most of any one response OpenGEO will hold in memory.
 *
 * A tested page is somebody else's server, and it can send a body that never ends. Real pages are
 * a few hundred kilobytes; this is far past any of them and far short of hurting the process.
 */
export const MAX_PROBE_BYTES = 8 * 1024 * 1024;

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export const OPENGEO_UA = 'OpenGEO/1.0 (+https://github.com/sherwinvishesh/OpenGEO)';

/**
 * @param {string} url
 * @param {ProbeOptions} [options]
 * @returns {Promise<ProbeResult>}
 */
export async function probe(url, options = {}) {
  const { headers = {}, method = 'GET', timeoutMs = 15_000, headOnly = false, redirect = 'follow', maxBytes = MAX_PROBE_BYTES } = options;
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      redirect,
      headers: { 'User-Agent': OPENGEO_UA, ...headers },
      signal: controller.signal,
    });
    const ttfbMs = performance.now() - started;
    const wanted = !headOnly && (options.readBody?.(response.headers) ?? true);
    const { body, truncated } = wanted ? await readCapped(response, maxBytes) : await discard(response);
    return {
      url,
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      body,
      ttfbMs: Math.round(ttfbMs),
      totalMs: Math.round(performance.now() - started),
      redirected: response.redirected,
      finalUrl: response.url || url,
      ...(truncated ? { truncated } : {}),
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: 0,
      headers: new Headers(),
      body: '',
      ttfbMs: Math.round(performance.now() - started),
      totalMs: Math.round(performance.now() - started),
      redirected: false,
      finalUrl: url,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The body as text, up to `maxBytes`. The rest is never downloaded.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<{ body: string; truncated: boolean }>}
 */
async function readCapped(response, maxBytes) {
  if (!response.body) return { body: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { body: body + decoder.decode(), truncated: false };
    const room = maxBytes - size;
    if (value.byteLength > room) {
      body += decoder.decode(value.subarray(0, room));
      await reader.cancel().catch(() => {});
      return { body, truncated: true };
    }
    size += value.byteLength;
    body += decoder.decode(value, { stream: true });
  }
}

/**
 * Close the connection without reading what is on it.
 *
 * @param {Response} response
 * @returns {Promise<{ body: string; truncated: boolean }>}
 */
async function discard(response) {
  await response.body?.cancel().catch(() => {});
  return { body: '', truncated: false };
}

/**
 * @param {string} value
 * @returns {URL | undefined}
 */
export function parseUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u;
  } catch {
    return undefined;
  }
}

/**
 * Absolute origin + path, no query/hash - the form every route key uses.
 *
 * @param {URL | string} input
 * @returns {string}
 */
export function cleanUrl(input) {
  const u = typeof input === 'string' ? new URL(input) : input;
  const out = new URL(u.toString());
  out.search = '';
  out.hash = '';
  if (out.pathname.length > 1 && out.pathname.endsWith('/')) out.pathname = out.pathname.slice(0, -1);
  return out.toString();
}
