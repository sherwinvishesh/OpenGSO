import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ERRORS } from '../shared/errors.js';
import { handleApi, type ApiOptions, type ApiProgress } from './api.js';

/**
 * The `opengeo start` server (§8).
 *
 * `node:http` and nothing else. The dashboard is a pile of static files plus a JSON API that calls
 * the same core functions the CLI calls, so shipping it costs the published package no runtime
 * dependency at all.
 *
 * It binds to 127.0.0.1 by design. A dashboard that can write an API key to disk should not be
 * reachable from the network the laptop happens to be on.
 */

export interface StartOptions extends ApiOptions {
  port: number;
  host?: string;
  /** Directory of built dashboard assets. */
  webRoot: string;
}

export interface RunningServer {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * The two endpoints that answer as a stream of server-sent events instead of one JSON object.
 *
 * Test and generate are the only two routes here that can run for minutes, and both already report
 * progress to the CLI. Everything else answers in one round trip and has nothing to narrate.
 *
 * They are POST, not GET, which means the browser cannot use `EventSource`. That is the trade taken
 * deliberately: `EventSource` only issues a GET, and a GET that runs a test or writes files is
 * reachable from any page on the internet through an `<img>` tag, which sends no `Origin` header
 * and so walks straight past `crossOriginDenial`. A POST carrying a JSON content type cannot be
 * forged that way. The wire format is still SSE, so `curl -N` reads it as text.
 */
const STREAM_PATHS = new Set(['/api/test/stream', '/api/generate/stream']);

/** Long enough to stay out of the way, short enough that no idle timer sees a dead connection. */
const HEARTBEAT_MS = 15_000;

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  // The real port is only known once listening, and `--port 0` is legal. Nothing is served before
  // `listen` resolves, so the handler never reads the placeholder.
  const bound = { host, port: options.port };
  const server = createServer((request, response) => {
    const denial = hostDenial(request.headers.host, bound);
    if (denial) {
      const api = (request.url ?? '').startsWith('/api/');
      return api
        ? send(response, 403, 'application/json; charset=utf-8', JSON.stringify({ error: denial }))
        : send(response, 403, 'text/plain; charset=utf-8', denial);
    }
    handle(request, response, options, host).catch((error) => {
      send(response, 500, 'application/json; charset=utf-8', JSON.stringify({ error: String(error) }));
    });
  });

  const port = await listen(server, options.port, host);
  bound.port = port;
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
  return {
    url,
    port,
    server,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

async function handle(request: IncomingMessage, response: ServerResponse, options: StartOptions, host: string): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);

  if (url.pathname.startsWith('/api/')) {
    // Any page on the internet can POST to a localhost port. This server can write an API key to
    // disk, so a cross-origin request has to be refused before it is parsed, not after.
    const denial = crossOriginDenial(request);
    if (denial) return send(response, 403, 'application/json; charset=utf-8', JSON.stringify({ error: denial }));

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      return send(response, 400, 'application/json; charset=utf-8', JSON.stringify({ error: String(error) }));
    }
    const method = request.method ?? 'GET';
    if (method === 'POST' && STREAM_PATHS.has(url.pathname)) {
      return await streamApi(request, response, { method, path: url.pathname, body }, options);
    }
    const result = await handleApi({ method, path: url.pathname, body }, options);
    return send(response, result.status, 'application/json; charset=utf-8', JSON.stringify(result.body));
  }

  serveStatic(url.pathname, response, options.webRoot);
}

/**
 * Run one endpoint with the response held open, narrating as it goes.
 *
 * Two frame types and no more. `progress` is whatever the pillar reported, verbatim; `done` is the
 * `ApiResponse` the handler returned, status included, so the client's success and failure paths are
 * the same two lines they are on every other route. A thrown error becomes a `done` with a 500,
 * because by this point the status line has already gone out and cannot be changed.
 */
async function streamApi(
  request: IncomingMessage,
  response: ServerResponse,
  api: { method: string; path: string; body: unknown },
  options: StartOptions,
): Promise<void> {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // For the day somebody puts this behind a proxy. Buffering an event stream defeats it entirely.
    'X-Accel-Buffering': 'no',
  });
  // A comment before any work starts, so `fetch` resolves its promise and the client can begin
  // reading rather than sitting on an empty body for as long as the first phase takes.
  response.write(': open\n\n');

  // The run cannot be cancelled once started, so a browser that navigates away only stops us
  // writing to a socket that is gone. Without this every frame after it throws EPIPE.
  let open = true;
  request.on('close', () => {
    open = false;
  });
  const write = (event: string, data: unknown): void => {
    if (!open || response.writableEnded) return;
    response.write(sseFrame(event, data));
  };

  const heartbeat = setInterval(() => {
    if (open && !response.writableEnded) response.write(': ping\n\n');
  }, HEARTBEAT_MS);
  // Node keeps the process alive for a pending timer, and this one outlives nothing.
  heartbeat.unref?.();

  try {
    const onProgress = (event: ApiProgress) => write('progress', event);
    const result = await handleApi(api, { ...options, onProgress });
    write('done', result);
  } catch (error) {
    write('done', { status: 500, body: { error: error instanceof Error ? error.message : String(error) } });
  } finally {
    clearInterval(heartbeat);
    if (!response.writableEnded) response.end();
  }
}

/**
 * One server-sent event.
 *
 * `JSON.stringify` never emits a raw newline, so the payload is always one `data:` line and the
 * multi-line form of the format never comes up. The blank line at the end is what marks the frame
 * complete; without it a client waits for the next one before delivering this one.
 */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Every name that reaches this machine's loopback interface without asking DNS. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Binding addresses that mean "every interface". They are not a name anybody can be addressed by. */
const WILDCARD_BINDS = new Set(['0.0.0.0', '[::]']);

/**
 * The gate in front of everything, API and static alike.
 *
 * `crossOriginDenial` alone cannot stop DNS rebinding: the attacker's page loads from
 * `evil.example`, the name is then re-pointed at 127.0.0.1, and from that moment its requests carry
 * `Host: evil.example` and a matching `Origin`. Same-origin by every rule the browser knows. The one
 * thing the attacker cannot choose is the name this server was started on, so the Host header has to
 * be one of those, on this port, or nothing is answered.
 */
export function hostDenial(hostHeader: string | undefined, bound: { host: string; port: number }): string | undefined {
  if (!hostHeader) return ERRORS.hostRefused(undefined);
  let parsed: URL;
  try {
    parsed = new URL(`http://${hostHeader}`);
  } catch {
    return ERRORS.hostRefused(hostHeader);
  }
  const boundName = bound.host.includes(':') ? `[${bound.host}]` : bound.host;
  const nameOk = LOOPBACK_NAMES.has(parsed.hostname) || (!WILDCARD_BINDS.has(boundName) && parsed.hostname === boundName);
  // `URL` drops the default port, so a server on 80 is addressed with an empty one.
  const portOk = (parsed.port || '80') === String(bound.port);
  return nameOk && portOk ? undefined : ERRORS.hostRefused(hostHeader);
}

/**
 * Same-origin enforcement for a local server. A browser always sends `Origin` on a cross-origin
 * fetch, so an absent Origin means a same-origin request or a non-browser client such as curl, and
 * a present one has to match the host we are serving from.
 */
export function crossOriginDenial(request: Pick<IncomingMessage, 'headers'>): string | undefined {
  const origin = request.headers.origin;
  if (!origin) return undefined;
  const host = request.headers.host;
  if (!host) return 'Refused: the request has an Origin but no Host.';
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return `Refused: "${origin}" is not a valid Origin.`;
  }
  if (parsed.host !== host) {
    return `Refused: this API only answers same-origin requests. Origin was ${origin}, host is ${host}.`;
  }
  return undefined;
}

function serveStatic(pathname: string, response: ServerResponse, webRoot: string): void {
  if (!existsSync(webRoot)) {
    return send(
      response,
      500,
      'text/plain; charset=utf-8',
      [
        'The dashboard assets are missing.',
        '',
        `Expected them at: ${webRoot}`,
        '',
        'If you are running from a clone, build them first:',
        '  npm run build -w packages/opengeo',
      ].join('\n'),
    );
  }

  const file = resolveStaticPath(pathname, webRoot);
  if (!file) return send(response, 404, 'text/plain; charset=utf-8', 'Not found');

  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  // The dashboard reads live project state, so a cached index.html would show a stale project.
  send(response, 200, type, readFileSync(file), file.endsWith('.html') ? 'no-store' : undefined);
}

/** Resolve a URL path inside the web root, refusing anything that escapes it. */
export function resolveStaticPath(pathname: string, webRoot: string): string | undefined {
  const decoded = safeDecode(pathname);
  if (decoded === undefined) return undefined;
  const relative = normalize(decoded).replace(/^([/\\.]+)/, '');
  const root = resolve(webRoot);
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(root + sep)) return undefined;

  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  // Single-page app: unknown paths fall through to index.html rather than 404ing, but only for
  // paths that do not look like a missing asset.
  if (extname(candidate)) return undefined;
  const index = join(root, 'index.html');
  return existsSync(index) ? index : undefined;
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return Promise.resolve(undefined);
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error('Request body too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolveBody(undefined);
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        rejectBody(new Error('Request body was not valid JSON.'));
      }
    });
    request.on('error', rejectBody);
  });
}

function send(response: ServerResponse, status: number, type: string, body: string | Buffer, cacheControl?: string): void {
  response.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
  });
  response.end(body);
}

/** Port 0 means "any free port", which is what the tests use. */
function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      const address = server.address();
      server.removeListener('error', rejectListen);
      resolveListen(typeof address === 'object' && address ? address.port : port);
    });
  });
}
