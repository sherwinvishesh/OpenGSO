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
  error?: string;
}

export interface ProbeOptions {
  headers?: Record<string, string>;
  method?: string;
  timeoutMs?: number;
  /** Skip reading the body - used by header-only checks. */
  headOnly?: boolean;
  redirect?: RequestRedirect;
}

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export const OPENGEO_UA = 'OpenGEO/1.0 (+https://github.com/sherwinvishesh/OpenGEO)';

export async function probe(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const { headers = {}, method = 'GET', timeoutMs = 15_000, headOnly = false, redirect = 'follow' } = options;
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
    const body = headOnly ? '' : await response.text();
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
