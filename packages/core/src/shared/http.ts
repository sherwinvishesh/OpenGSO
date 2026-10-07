/**
 * A single fetch wrapper for every HTTP call OpenGEO makes.
 *
 * It records TTFB because `test` scores it (§5A), and it never throws on a non-2xx: check code
 * wants the failing status and headers, not an exception.
 */
export interface ProbeResult {
  url: string;
  ok: boolean;
  status: number;
  headers: Headers;
  body: string;
  /** Milliseconds from request start to first byte of the response head. */
  ttfbMs: number;
  /** Milliseconds to a fully-read body. */
  totalMs: number;
  redirected: boolean;
  finalUrl: string;
  /** The body stopped at `maxBytes`. What is in `body` is the start of it, not all of it. */
  truncated?: boolean;
  error?: string;
}

export interface ProbeOptions {
  headers?: Record<string, string>;
  method?: string;
  timeoutMs?: number;
  /** Skip reading the body - used by header-only checks. */
  headOnly?: boolean;
  redirect?: RequestRedirect;
  /** Stop reading after this many bytes. Defaults to {@link MAX_PROBE_BYTES}. */
  maxBytes?: number;
  /** Decide from the headers whether the body is worth downloading at all. */
  readBody?: (headers: Headers) => boolean;
}

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

export async function probe(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
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

/** The body as text, up to `maxBytes`. The rest is never downloaded. */
async function readCapped(response: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
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

/** Close the connection without reading what is on it. */
async function discard(response: Response): Promise<{ body: string; truncated: boolean }> {
  await response.body?.cancel().catch(() => {});
  return { body: '', truncated: false };
}

export function parseUrl(value: string): URL | undefined {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u;
  } catch {
    return undefined;
  }
}

/** Absolute origin + path, no query/hash - the form every route key uses. */
export function cleanUrl(input: URL | string): string {
  const u = typeof input === 'string' ? new URL(input) : input;
  const out = new URL(u.toString());
  out.search = '';
  out.hash = '';
  if (out.pathname.length > 1 && out.pathname.endsWith('/')) out.pathname = out.pathname.slice(0, -1);
  return out.toString();
}
