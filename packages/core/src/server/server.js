import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ConfigError } from '../shared/config.js';
import { ERRORS } from '../shared/errors.js';
import { handleApi } from './api.js';

/**
 * @import { IncomingMessage, Server, ServerResponse } from 'node:http'
 * @import { ApiOptions, ApiProgress } from './api.js'
 */

/**
 * The `opengeo start` server (§8).
 *
 * `node:http` and nothing else. The dashboard is a pile of static files plus a JSON API that calls
 * the same core functions the CLI calls, so shipping it costs the published package no runtime
 * dependency at all.
 *
 * It binds to 127.0.0.1 by design. A dashboard that can write an API key to disk should not be
 * reachable from the network the laptop happens to be on. `--host` can still put it there, for the
 * container case, and then every request has to carry a token minted for that launch.
 */

/**
 * @typedef {ApiOptions & {
 *   port: number;
 *   host?: string;
 *   webRoot: string; // Directory of built dashboard assets.
 *   token?: string; // Required on every request when set. Defaults to `launchToken(host)`.
 * }} StartOptions
 */

/**
 * @typedef {object} RunningServer
 * @property {string} url What to open. Carries `?token=` when there is one, so it is the only URL
 *   that gets in.
 * @property {number} port
 * @property {string} [token]
 * @property {Server} server
 * @property {() => Promise<void>} close
 */

/** @type {Record<string, string>} */
const MIME = {
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
 * and so walks straight past `crossOriginDenial`. Every API POST must carry `application/json`,
 * which `handle` checks before reading the body: a plain form can only send `text/plain` and
 * friends, and a script on another origin that asks for JSON needs a preflight this server never
 * grants. The wire format is still SSE, so `curl -N` reads it as text.
 */
const STREAM_PATHS = new Set(['/api/test/stream', '/api/generate/stream']);

/**
 * Sent on every response, page and API alike. The dashboard is one script and one stylesheet from
 * this server, so `'self'` is the whole policy; it must not be framed, since it has buttons that
 * write to disk; and nothing it links to needs to learn the local port it was opened on.
 */
const SECURITY_HEADERS = /** @type {const} */ ({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
});

/** Long enough to stay out of the way, short enough that no idle timer sees a dead connection. */
const HEARTBEAT_MS = 15_000;

/**
 * @param {StartOptions} options
 * @returns {Promise<RunningServer>}
 */
export async function startServer(options) {
  const host = options.host ?? '127.0.0.1';
  const token = options.token ?? launchToken(host);
  // The real port is only known once listening, and `--port 0` is legal. Nothing is served before
  // `listen` resolves, so the handler never reads the placeholder.
  const bound = { host, port: options.port };
  const server = createServer((request, response) => {
    const api = (request.url ?? '').startsWith('/api/');
    /**
     * @param {number} status
     * @param {string} message
     */
    const refuse = (status, message) =>
      api
        ? send(response, status, 'application/json; charset=utf-8', JSON.stringify({ error: message }))
        : send(response, status, 'text/plain; charset=utf-8', message);

    const denial = hostDenial(request.headers.host, bound, token !== undefined);
    if (denial) return refuse(403, denial);
    if (token !== undefined) {
      const verdict = tokenVerdict(request, token, tokenCookie(bound.port));
      if (verdict === 'refused') return refuse(401, ERRORS.tokenRequired());
      if (verdict !== 'ok') {
        response.writeHead(303, { ...SECURITY_HEADERS, Location: verdict.location, 'Set-Cookie': verdict.cookie, 'Content-Length': 0 });
        return response.end();
      }
    }
    handle(request, response, options, host).catch((error) => {
      const reply = errorReply(error);
      if (!(error instanceof ConfigError)) console.error(error);
      send(response, reply.status, 'application/json; charset=utf-8', JSON.stringify(reply.body));
    });
  });

  const port = await listen(server, options.port, host);
  bound.port = port;
  const base = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
  return {
    url: token === undefined ? base : `${base}/?token=${token}`,
    port,
    token,
    server,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

/**
 * @param {IncomingMessage} request
 * @param {ServerResponse} response
 * @param {StartOptions} options
 * @param {string} host
 * @returns {Promise<void>}
 */
async function handle(request, response, options, host) {
  /** @type {URL} */
  let url;
  try {
    url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
  } catch {
    // An absolute-form target such as `http://x:99999/` passes the Host check and then fails here.
    // Not `URL.parse`, which Node 20 does not have.
    return send(response, 400, 'text/plain; charset=utf-8', ERRORS.badRequestTarget());
  }

  if (url.pathname.startsWith('/api/')) {
    // Any page on the internet can POST to a localhost port. This server can write an API key to
    // disk, so a cross-origin request has to be refused before it is parsed, not after.
    const denial = crossOriginDenial(request);
    if (denial) return send(response, 403, 'application/json; charset=utf-8', JSON.stringify({ error: denial }));
    if (request.method === 'POST' && !isJson(request.headers['content-type'])) {
      return send(response, 415, 'application/json; charset=utf-8', JSON.stringify({ error: ERRORS.jsonRequired() }));
    }

    /** @type {unknown} */
    let body;
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

  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return send(response, 405, 'text/plain; charset=utf-8', ERRORS.staticMethod(method));
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
 *
 * @param {IncomingMessage} request
 * @param {ServerResponse} response
 * @param {{ method: string; path: string; body: unknown }} api
 * @param {StartOptions} options
 * @returns {Promise<void>}
 */
async function streamApi(request, response, api, options) {
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // For the day somebody puts this behind a proxy. Buffering an event stream defeats it entirely.
    'X-Accel-Buffering': 'no',
  });
  // A comment before any work starts, so `fetch` resolves its promise and the client can begin
  // reading rather than sitting on an empty body for as long as the first phase takes.
  response.write(': open\n\n');

  // The response, not the request: the body was read to the end before the run started, and a
  // finished request has already emitted its `close`, so listening there never heard the browser
  // leave. A closed tab stops writing to a dead socket and aborts the run itself, which is what
  // stops it paying for AI calls nobody will read.
  let open = true;
  const controller = new AbortController();
  response.on('close', () => {
    open = false;
    if (!response.writableFinished) controller.abort();
  });
  /**
   * @param {string} event
   * @param {unknown} data
   * @returns {void}
   */
  const write = (event, data) => {
    if (!open || response.writableEnded) return;
    response.write(sseFrame(event, data));
  };

  const heartbeat = setInterval(() => {
    if (open && !response.writableEnded) response.write(': ping\n\n');
  }, HEARTBEAT_MS);
  // Node keeps the process alive for a pending timer, and this one outlives nothing.
  heartbeat.unref?.();

  try {
    /** @param {ApiProgress} event */
    const onProgress = (event) => write('progress', event);
    const result = await handleApi(api, { ...options, onProgress, signal: controller.signal });
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
 *
 * @param {string} event
 * @param {unknown} data
 * @returns {string}
 */
export function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * What a request that threw sends back. A `ConfigError` was written for the user and says which file
 * to fix, so it goes through, flagged so the dashboard stops blaming the network. Anything else is a
 * bug, and its text can carry absolute paths and stack frames: that stays in the terminal.
 *
 * @param {unknown} error
 * @returns {{ status: number; body: { error: string; configBroken?: true } }}
 */
export function errorReply(error) {
  if (error instanceof ConfigError) return { status: 500, body: { error: error.message, configBroken: true } };
  return { status: 500, body: { error: ERRORS.serverFailed() } };
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
 *
 * A wildcard bind has no such name: a machine on the network reaches it by whatever address that
 * machine knows it by. It only ever runs with a launch token, and the token is what a rebound page
 * cannot have, since the cookie that carries it belongs to the name it was set under. So there, and
 * only while a token is in force, any name on the right port is let through to the token check.
 *
 * @param {string | undefined} hostHeader
 * @param {{ host: string; port: number }} bound
 * @param {boolean} [tokenGated]
 * @returns {string | undefined}
 */
export function hostDenial(hostHeader, bound, tokenGated = false) {
  if (!hostHeader) return ERRORS.hostRefused(undefined);
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(`http://${hostHeader}`);
  } catch {
    return ERRORS.hostRefused(hostHeader);
  }
  const boundName = bound.host.includes(':') ? `[${bound.host}]` : bound.host;
  const nameOk =
    LOOPBACK_NAMES.has(parsed.hostname) ||
    (WILDCARD_BINDS.has(boundName) ? tokenGated : parsed.hostname === boundName);
  // `URL` drops the default port, so a server on 80 is addressed with an empty one.
  const portOk = (parsed.port || '80') === String(bound.port);
  return nameOk && portOk ? undefined : ERRORS.hostRefused(hostHeader);
}

/**
 * Whether a bind address is the loopback interface, which nothing on the network can reach.
 *
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackBind(host) {
  const name = host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return name === 'localhost' || name === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/**
 * The token a launch on `host` needs, or none for loopback. A new one every launch, so a URL left in
 * a shell history or a screenshot stops working the moment that dashboard is stopped.
 *
 * @param {string} host
 * @returns {string | undefined}
 */
export function launchToken(host) {
  return isLoopbackBind(host) ? undefined : randomBytes(24).toString('base64url');
}

/**
 * Per port, so two dashboards open on one machine do not log each other out.
 *
 * @param {number} port
 * @returns {string}
 */
function tokenCookie(port) {
  return `opengeo_token_${port}`;
}

/**
 * Whether a request carries the launch token, and what to do about it.
 *
 * The printed URL carries it in the query once. That request is answered with a cookie and a
 * redirect to the same address without it, so the token does not sit in the address bar, the
 * history or a `Referer`. The cookie is HttpOnly, so the page's own script never holds it, and
 * SameSite=Strict, so no other site's request ever arrives with it. A bearer header is accepted too,
 * for curl and scripts.
 *
 * @param {IncomingMessage} request
 * @param {string} token
 * @param {string} cookieName
 * @returns {'ok' | 'refused' | { location: string; cookie: string }}
 */
function tokenVerdict(request, token, cookieName) {
  const url = new URL(request.url ?? '/', 'http://placeholder');
  const offered = url.searchParams.get('token');
  if (offered !== null) {
    if (!sameSecret(offered, token)) return 'refused';
    url.searchParams.delete('token');
    return {
      location: url.pathname + url.search,
      cookie: `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict`,
    };
  }

  const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
  if (bearer !== undefined && sameSecret(bearer, token)) return 'ok';
  const cookie = (request.headers.cookie ?? '')
    .split(';')
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  return cookie !== undefined && sameSecret(cookie, token) ? 'ok' : 'refused';
}

/**
 * Compared in constant time, so a guess cannot be refined by how long the refusal took.
 *
 * @param {string} offered
 * @param {string} expected
 * @returns {boolean}
 */
function sameSecret(offered, expected) {
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Same-origin enforcement for a local server. A browser always sends `Origin` on a cross-origin
 * fetch, so an absent Origin means a same-origin request or a non-browser client such as curl, and
 * a present one has to match the host we are serving from.
 *
 * @param {Pick<IncomingMessage, 'headers'>} request
 * @returns {string | undefined}
 */
export function crossOriginDenial(request) {
  const origin = request.headers.origin;
  if (!origin) return undefined;
  const host = request.headers.host;
  if (!host) return 'Refused: the request has an Origin but no Host.';
  /** @type {URL} */
  let parsed;
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

/**
 * @param {string} pathname
 * @param {ServerResponse} response
 * @param {string} webRoot
 * @returns {void}
 */
function serveStatic(pathname, response, webRoot) {
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
  // The dashboard reads live project state, so a cached index.html would show a stale project. The
  // modules keep the same names from one release to the next, so they are revalidated every time:
  // otherwise an upgrade could run last version's app.js against this version's screens.
  send(response, 200, type, readFileSync(file), file.endsWith('.html') ? 'no-store' : 'no-cache');
}

/**
 * Resolve a URL path inside the web root, refusing anything that escapes it.
 *
 * @param {string} pathname
 * @param {string} webRoot
 * @returns {string | undefined}
 */
export function resolveStaticPath(pathname, webRoot) {
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

/**
 * @param {string} value
 * @returns {string | undefined}
 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * @param {IncomingMessage} request
 * @returns {Promise<unknown>}
 */
function readJsonBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return Promise.resolve(undefined);
  return new Promise((resolveBody, rejectBody) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    request.on('data', (/** @type {Buffer} */ chunk) => {
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

/**
 * @param {string | undefined} contentType
 * @returns {boolean}
 */
function isJson(contentType) {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/**
 * @param {ServerResponse} response
 * @param {number} status
 * @param {string} type
 * @param {string | Buffer} body
 * @param {string} [cacheControl]
 * @returns {void}
 */
function send(response, status, type, body, cacheControl) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
  });
  response.end(body);
}

/**
 * Port 0 means "any free port", which is what the tests use.
 *
 * @param {Server} server
 * @param {number} port
 * @param {string} host
 * @returns {Promise<number>}
 */
function listen(server, port, host) {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      const address = server.address();
      server.removeListener('error', rejectListen);
      resolveListen(typeof address === 'object' && address ? address.port : port);
    });
  });
}
