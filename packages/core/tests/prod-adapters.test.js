import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MARKDOWN_CONTENT_TYPE } from '@opengso/core/prod';
import { createEdgeMiddleware, fetchMiddleware, mergeHeaderValue, withPassthroughHeaders } from '@opengso/core/prod/edge';
import { createFetchMiddleware } from '@opengso/core/prod/fetch';
import { createNodeMiddleware } from '@opengso/core/prod/node';
import viteDefault, { opengso as vitePlugin } from '@opengso/core/prod/vite';
import { prodDataCommand } from '../src/cli/commands/prod-data.js';
import { runCli } from '../src/cli/index.js';
import { buildEdgeData, refreshEdgeData, renderEdgeDataModule, writeEdgeData } from '../src/prod/edge-data.js';
import { loadConfig } from '../src/shared/config.js';
/** @import { Server, IncomingMessage, ServerResponse } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */

/**
 * The adapters that put prod in front of everything that is not Next: Node `(req, res, next)`
 * middleware, fetch-style middleware, the edge, and the Vite plugin. Each one is driven over real
 * HTTP where it can be, because the bugs worth catching here live in headers a mock would accept.
 */

const CLAUDE = 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/** @type {Server[]} */
const servers = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))),
  );
});

/**
 * A project with one twin, as `opengso generate` leaves it.
 *
 * @param {object} [config] Written as opengso.config.json when given.
 */
function project(config) {
  const root = mkdtempSync(join(tmpdir(), 'opengso-adapters-'));
  mkdirSync(join(root, 'public', 'md'), { recursive: true });
  mkdirSync(join(root, '.opengso'), { recursive: true });
  writeFileSync(join(root, 'public', 'md', 'resume.md'), '---\ntitle: "Resume"\ngenerated_by: opengso\n---\n# Resume\n\nTen years of fieldwork.\n');
  writeFileSync(
    join(root, '.opengso', 'manifest.json'),
    JSON.stringify({
      pages: {
        '/resume': {
          route: '/resume',
          title: 'Resume',
          file: 'md/resume.md',
          tokens: 9,
          lastUpdated: '2026-10-01T00:00:00.000Z',
          url: 'http://localhost:3000/resume',
          canonical: 'http://localhost:3000/resume',
          description: 'Bookkeeping the edge has no use for',
        },
      },
    }),
  );
  if (config) writeFileSync(join(root, 'opengso.config.json'), JSON.stringify(config));
  return root;
}

/** @param {Server} server */
async function listen(server) {
  servers.push(server);
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  return `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`;
}

/**
 * A Connect-style app: the middleware first, then a page that sets its own `Vary` the way
 * compression middleware does.
 *
 * @param {(req: IncomingMessage, res: ServerResponse, next: () => void) => unknown} middleware
 */
function connectApp(middleware) {
  return createServer((req, res) => {
    middleware(req, res, () => {
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<h1>Resume</h1>');
    });
  });
}

/**
 * A server that runs a fetch-style middleware in front of an app that answers in HTML.
 *
 * @param {(request: Request, next: () => Promise<Response>) => Promise<Response>} middleware
 * @param {() => Response} [app]
 */
function fetchApp(middleware, app = () => new Response('<h1>Resume</h1>', { headers: { 'content-type': 'text/html; charset=utf-8', vary: 'Accept-Encoding' } })) {
  return createServer((req, res) => {
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: /** @type {Record<string, string>} */ (req.headers),
    });
    void middleware(request, async () => app()).then(async (response) => {
      const body = req.method === 'HEAD' ? '' : await response.text();
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(body);
    });
  });
}

describe('mergeHeaderValue', () => {
  it('adds Accept to the Vary an application already set, once', () => {
    expect(mergeHeaderValue('Vary', 'Accept-Encoding', 'Accept')).toBe('Accept-Encoding, Accept');
    expect(mergeHeaderValue('vary', 'accept, Origin', 'Accept')).toBe('accept, Origin');
    expect(mergeHeaderValue('Vary', undefined, 'Accept')).toBe('Accept');
  });

  it('leaves Vary: * alone, since it already covers Accept', () => {
    expect(mergeHeaderValue('Vary', '*', 'Accept')).toBe('*');
  });

  it("keeps the application's Link entries and adds the twin once", () => {
    const twin = '</md/resume.md>; rel="alternate"; type="text/markdown"';
    expect(mergeHeaderValue('Link', '</app.css>; rel=preload', twin)).toBe(`</app.css>; rel=preload, ${twin}`);
    expect(mergeHeaderValue('Link', twin, twin)).toBe(twin);
  });

  it('replaces any other header, which is prod’s own', () => {
    expect(mergeHeaderValue('X-AEO-Version', 'old', 'opengso/1.0')).toBe('opengso/1.0');
  });
});

describe('withPassthroughHeaders', () => {
  it('copies a response whose headers cannot be changed', () => {
    const immutable = Response.redirect('https://example.com/', 302);
    const out = withPassthroughHeaders(immutable, { Vary: 'Accept' });
    expect(out).not.toBe(immutable);
    expect(out.status).toBe(302);
    expect(out.headers.get('vary')).toBe('Accept');
    expect(out.headers.get('location')).toBe('https://example.com/');
  });

  it('never touches a WebSocket upgrade', () => {
    const upgrade = /** @type {Response} */ ({ status: 101, headers: new Headers() });
    expect(withPassthroughHeaders(upgrade, { Vary: 'Accept' })).toBe(upgrade);
    expect(upgrade.headers.get('vary')).toBeNull();
  });
});

describe('fetchMiddleware', () => {
  it('sends a request it cannot decide to the app, and logs that once', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const middleware = fetchMiddleware(() => {
      throw new Error('boom');
    });
    for (let i = 0; i < 3; i += 1) {
      const response = await middleware(new Request('http://x/resume'), async () => new Response('page'));
      expect(await response.text()).toBe('page');
    }
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toMatch(/^\[opengso-prod\] .*boom$/);
  });

  it('calls next with no arguments', async () => {
    const next = vi.fn(async () => new Response('page'));
    await fetchMiddleware(() => ({ type: 'passthrough', headers: {}, classification: /** @type {any} */ ({}) }))(new Request('http://x/'), next);
    expect(next).toHaveBeenCalledWith();
  });
});

describe('createNodeMiddleware, in front of a Connect-style app', () => {
  it('serves the twin to an AI agent and the page to a browser, at the same URL', async () => {
    const site = await listen(connectApp(createNodeMiddleware({ root: project({}), logStartup: false })));

    const agent = await fetch(`${site}/resume`, { headers: { 'user-agent': CLAUDE } });
    expect(agent.status).toBe(200);
    expect(agent.headers.get('content-type')).toBe(MARKDOWN_CONTENT_TYPE);
    expect(await agent.text()).toBe('# Resume\n\nTen years of fieldwork.');

    const person = await fetch(`${site}/resume`, { headers: { 'user-agent': BROWSER, accept: BROWSER_ACCEPT } });
    expect(person.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await person.text()).toBe('<h1>Resume</h1>');
    // The app's own Vary survives, and the twin's Link is advertised on the HTML.
    expect(person.headers.get('vary')).toBe('Accept-Encoding');
    expect(person.headers.get('link')).toBe('</resume.md>; rel="alternate"; type="text/markdown"');
  });

  it('merges Vary when the app sets it before the middleware runs', async () => {
    const middleware = createNodeMiddleware({ root: project({}), logStartup: false });
    const site = await listen(
      createServer((req, res) => {
        res.setHeader('Vary', 'Accept-Encoding');
        middleware(req, res, () => res.end('<h1>Resume</h1>'));
      }),
    );
    const person = await fetch(`${site}/resume`, { headers: { 'user-agent': BROWSER, accept: BROWSER_ACCEPT } });
    expect(person.headers.get('vary')).toBe('Accept-Encoding, Accept');
  });

  it('answers Accept: text/markdown, HEAD, a revalidation and a 406 itself', async () => {
    const site = await listen(connectApp(createNodeMiddleware({ root: project({}), logStartup: false })));

    const asked = await fetch(`${site}/resume`, { headers: { accept: 'text/markdown' } });
    expect(asked.headers.get('content-type')).toBe(MARKDOWN_CONTENT_TYPE);
    const etag = asked.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);

    const head = await fetch(`${site}/resume`, { method: 'HEAD', headers: { accept: 'text/markdown' } });
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(etag);
    expect(await head.text()).toBe('');

    const again = await fetch(`${site}/resume`, { headers: { accept: 'text/markdown', 'if-none-match': /** @type {string} */ (etag) } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');

    const neither = await fetch(`${site}/resume`, { headers: { accept: 'application/pdf' } });
    expect(neither.status).toBe(406);
    expect(await neither.text()).toContain('text/markdown');
  });

  it('keys the twin by the full path when a router is mounted below /', () => {
    const middleware = createNodeMiddleware({ root: project({}), logStartup: false });
    const res = fakeResponse();
    const answered = middleware({ url: '/', originalUrl: '/resume', method: 'GET', headers: { 'user-agent': CLAUDE } }, res);
    expect(answered).toBe(true);
    expect(res.body).toContain('# Resume');
  });

  it('reads a path that starts with two slashes as a path, not a host', () => {
    const middleware = createNodeMiddleware({ root: project({}), logStartup: false });
    const res = fakeResponse();
    const next = vi.fn();
    expect(middleware({ url: '//evil.example/resume', method: 'GET', headers: { 'user-agent': CLAUDE } }, res, next)).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('works without next, for Koa, and returns true only when it answered', () => {
    const middleware = createNodeMiddleware({ root: project({}), logStartup: false });
    const res = fakeResponse();
    // Nothing rather than false: h3's fromNodeMiddleware sends any returned value as the body.
    expect(middleware({ url: '/about', method: 'GET', headers: { 'user-agent': CLAUDE } }, res)).toBeUndefined();
    expect(res.headers.vary).toBe('Accept');
    expect(middleware({ url: '/resume', method: 'GET', headers: { 'user-agent': CLAUDE } }, fakeResponse())).toBe(true);
  });

  it('leaves the headers alone once the app has sent them', () => {
    const middleware = createNodeMiddleware({ root: project({}), logStartup: false });
    const res = fakeResponse();
    res.headersSent = true;
    const next = vi.fn();
    middleware({ url: '/resume', method: 'GET', headers: { 'user-agent': BROWSER, accept: BROWSER_ACCEPT } }, res, next);
    expect(res.headers).toEqual({});
    expect(next).toHaveBeenCalledOnce();
  });

  it('fails open on a broken config: one log line, every page served', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = project();
    writeFileSync(join(root, 'opengso.config.json'), '{ "site": ');
    const site = await listen(connectApp(createNodeMiddleware({ root })));
    const agent = await fetch(`${site}/resume`, { headers: { 'user-agent': CLAUDE } });
    expect(agent.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('follows the configured routing and custom crawlers', async () => {
    const root = project({ bots: { markdownRouting: ['AcmeBot'], custom: [{ name: 'AcmeBot' }] } });
    const site = await listen(connectApp(createNodeMiddleware({ root, logStartup: false })));
    const acme = await fetch(`${site}/resume`, { headers: { 'user-agent': 'AcmeBot/2.0' } });
    expect(acme.headers.get('content-type')).toBe(MARKDOWN_CONTENT_TYPE);
    const claude = await fetch(`${site}/resume`, { headers: { 'user-agent': CLAUDE, accept: BROWSER_ACCEPT } });
    expect(claude.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });
});

describe('createFetchMiddleware', () => {
  it('serves the twin to an agent and adds the passthrough headers to the app’s response', async () => {
    const site = await listen(fetchApp(createFetchMiddleware({ root: project({}), logStartup: false })));

    const agent = await fetch(`${site}/resume`, { headers: { 'user-agent': CLAUDE } });
    expect(agent.headers.get('content-type')).toBe(MARKDOWN_CONTENT_TYPE);
    expect(await agent.text()).toContain('Ten years of fieldwork.');

    const person = await fetch(`${site}/resume`, { headers: { 'user-agent': BROWSER, accept: BROWSER_ACCEPT } });
    expect(await person.text()).toBe('<h1>Resume</h1>');
    expect(person.headers.get('vary')).toBe('Accept-Encoding, Accept');
    expect(person.headers.get('link')).toContain('</resume.md>');
  });

  it('copies an immutable response from the app rather than throwing', async () => {
    const middleware = createFetchMiddleware({ root: project({}), logStartup: false });
    const response = await middleware(new Request('http://x/resume', { headers: { 'user-agent': BROWSER, accept: BROWSER_ACCEPT } }), async () =>
      Response.redirect('http://x/login', 302),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('vary')).toBe('Accept');
  });
});

describe('createEdgeMiddleware, from the module `opengso prod data` writes', () => {
  it('decides exactly what the Node adapter decides for the same project', async () => {
    const root = project({ bots: { markdownRouting: ['AcmeBot'], custom: [{ name: 'AcmeBot' }] } });
    const { data } = buildEdgeData(loadConfig(root));
    const edge = createEdgeMiddleware({ data });
    const node = createFetchMiddleware({ root, logStartup: false });
    const app = async () => new Response('<h1>Resume</h1>', { headers: { 'content-type': 'text/html' } });

    /** @type {Record<string, string>[]} */
    const asks = [
      { 'user-agent': 'AcmeBot/2.0' },
      { 'user-agent': CLAUDE, accept: BROWSER_ACCEPT },
      { accept: 'text/markdown' },
      { accept: 'application/pdf' },
      { 'user-agent': BROWSER, accept: BROWSER_ACCEPT },
    ];
    for (const headers of asks) {
      const fromEdge = await edge(new Request('http://x/resume', { headers }), app);
      const fromNode = await node(new Request('http://x/resume', { headers }), app);
      expect(fromEdge.status).toBe(fromNode.status);
      expect(Object.fromEntries(fromEdge.headers)).toEqual(Object.fromEntries(fromNode.headers));
      expect(await fromEdge.text()).toBe(await fromNode.text());
    }
  });
});

describe('the Vite plugin', () => {
  it('adds the Node middleware to the dev and preview servers', () => {
    expect(viteDefault).toBe(vitePlugin);
    const root = project({});
    /** @type {unknown[]} */
    const used = [];
    const server = { config: { root }, middlewares: { use: (/** @type {unknown} */ fn) => used.push(fn) } };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const plugin = vitePlugin({ logStartup: false });
    expect(plugin.name).toBe('opengso');
    plugin.configureServer(server);
    plugin.configurePreviewServer(server);
    expect(used).toHaveLength(2);
    expect(typeof used[0]).toBe('function');
  });
});

describe('opengso prod data', () => {
  it('writes only what a store reads, with the routing and custom crawlers', () => {
    const root = project({ bots: { markdownRouting: ['AcmeBot'], custom: [{ name: 'AcmeBot' }] } });
    const { data, problems } = buildEdgeData(loadConfig(root));
    expect(problems).toEqual([]);
    expect(data.manifest.pages['/resume']).toEqual({
      route: '/resume',
      title: 'Resume',
      file: 'md/resume.md',
      tokens: 9,
      lastUpdated: '2026-10-01T00:00:00.000Z',
    });
    expect(Object.keys(data.contents)).toEqual(['md/resume.md']);
    expect(data.markdownRouting).toEqual(['AcmeBot']);
    expect(data.customBots).toEqual([{ name: 'AcmeBot' }]);
  });

  it('refuses a twin outside publicDir, exactly as the Node store does', () => {
    const root = project({});
    writeFileSync(join(root, 'secret.md'), 'DATABASE_PASSWORD=hunter2\n');
    writeFileSync(
      join(root, '.opengso', 'manifest.json'),
      JSON.stringify({
        pages: {
          '/resume': { route: '/resume', file: 'md/resume.md', tokens: 9 },
          '/leak': { route: '/leak', file: '../secret.md', tokens: 3 },
        },
      }),
    );
    const { data, problems } = buildEdgeData(loadConfig(root));
    expect(Object.keys(data.manifest.pages)).toEqual(['/resume']);
    expect(JSON.stringify(data)).not.toContain('hunter2');
    expect(problems.join('\n')).toContain('outside');
  });

  it('writes the same bytes for the same twins, in JavaScript or TypeScript', () => {
    const root = project({});
    const { data } = buildEdgeData(loadConfig(root));
    const js = renderEdgeDataModule(data, { typescript: false, importFrom: 'opengso-prod/edge' });
    expect(js).toBe(renderEdgeDataModule(data, { typescript: false, importFrom: 'opengso-prod/edge' }));
    expect(js.split('\n')[0]).toMatch(/^\/\/ Generated by OpenGSO \(opengso\/1\.0\)/);
    expect(js).toContain("/** @type {import('opengso-prod/edge').EdgeData} */");
    expect(js.trimEnd().endsWith('export default data;')).toBe(true);
    const ts = renderEdgeDataModule(data, { typescript: true, importFrom: 'opengso/prod/edge' });
    expect(ts).toContain("import type { EdgeData } from 'opengso/prod/edge';");
    expect(ts).toContain('const data: EdgeData = {');
  });

  it('imports into a working edge middleware', async () => {
    const root = project({});
    const result = writeEdgeData({ loaded: loadConfig(root) });
    expect(result.path).toBe(join(root, 'opengso-edge-data.js'));
    const { default: data } = await import(result.path);
    const edge = createEdgeMiddleware({ data });
    const response = await edge(new Request('http://x/resume', { headers: { 'user-agent': CLAUDE } }), async () => new Response('page'));
    expect(response.headers.get('content-type')).toBe(MARKDOWN_CONTENT_TYPE);
  });

  it('picks TypeScript in a TypeScript project, and names the package the project installed', () => {
    const root = project({});
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { opengso: '^0.1.0' } }));
    const result = writeEdgeData({ loaded: loadConfig(root) });
    expect(result.path).toBe(join(root, 'opengso-edge-data.ts'));
    expect(result.importFrom).toBe('opengso/prod/edge');
    expect(readFileSync(result.path, 'utf8')).toContain("from 'opengso/prod/edge'");
  });

  it('never overwrites a file of the same name it did not write', () => {
    const root = project({});
    writeFileSync(join(root, 'opengso-edge-data.js'), 'export default { mine: true };\n');
    const result = writeEdgeData({ loaded: loadConfig(root) });
    expect(result.proposed).toBe(true);
    expect(result.path).toBe(join(root, 'opengso-edge-data.js.opengso-proposed'));
    expect(readFileSync(join(root, 'opengso-edge-data.js'), 'utf8')).toBe('export default { mine: true };\n');
    const forced = writeEdgeData({ loaded: loadConfig(root), force: true });
    expect(forced.proposed).toBe(false);
    expect(readFileSync(join(root, 'opengso-edge-data.js'), 'utf8')).toContain('Generated by OpenGSO');
  });

  it('reports an unchanged module rather than rewriting it', () => {
    const root = project({});
    expect(writeEdgeData({ loaded: loadConfig(root) })).toMatchObject({ written: true, unchanged: false });
    expect(writeEdgeData({ loaded: loadConfig(root) })).toMatchObject({ written: false, unchanged: true });
  });

  it('keeps the module it has when a later read finds no twins', () => {
    const root = project({});
    writeEdgeData({ loaded: loadConfig(root) });
    const before = readFileSync(join(root, 'opengso-edge-data.js'), 'utf8');
    writeFileSync(join(root, '.opengso', 'manifest.json'), JSON.stringify({ pages: {} }));
    expect(writeEdgeData({ loaded: loadConfig(root) })).toMatchObject({ written: false, pages: 0 });
    expect(refreshEdgeData(loadConfig(root))).toEqual({ notes: [], warnings: [] });
    expect(readFileSync(join(root, 'opengso-edge-data.js'), 'utf8')).toBe(before);
  });

  it('is refreshed after generate only when OpenGSO wrote it', () => {
    const root = project({});
    expect(refreshEdgeData(loadConfig(root))).toEqual({ notes: [], warnings: [] });
    expect(existsSync(join(root, 'opengso-edge-data.js'))).toBe(false);

    writeEdgeData({ loaded: loadConfig(root) });
    writeFileSync(join(root, 'public', 'md', 'resume.md'), '# Resume\n\nEleven years now.\n');
    const refreshed = refreshEdgeData(loadConfig(root));
    expect(refreshed.notes).toEqual([expect.stringContaining('Refreshed opengso-edge-data.js with 1 twin')]);
    expect(readFileSync(join(root, 'opengso-edge-data.js'), 'utf8')).toContain('Eleven years now.');

    writeFileSync(join(root, 'opengso-edge-data.ts'), 'export default {};\n');
    refreshEdgeData(loadConfig(root));
    expect(readFileSync(join(root, 'opengso-edge-data.ts'), 'utf8')).toBe('export default {};\n');
  });

  it('writes nothing and exits 1 when there are no twins', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opengso-adapters-empty-'));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await prodDataCommand({ argv: ['--project', root], packageName: 'opengso', version: '0.0.0' })).toBe(1);
    expect(existsSync(join(root, 'opengso-edge-data.js'))).toBe(false);
    expect(existsSync(join(root, 'opengso-edge-data.ts'))).toBe(false);
    expect(String(err.mock.calls.map((call) => call[0]).join(''))).toContain('No twins to bundle');
  });

  it('runs as `opengso prod data`, prints the import, and exits 0', async () => {
    const root = project({});
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runCli({
      packageName: 'opengso',
      version: '0.0.0',
      commands: { 'prod data': prodDataCommand },
      argv: ['prod', 'data', '--project', root],
    });
    expect(code).toBe(0);
    const printed = out.mock.calls.map((call) => String(call[0])).join('');
    expect(printed).toContain('1 twin');
    expect(printed).toContain("import data from './opengso-edge-data';");
    expect(printed).toContain("import { createEdgeMiddleware } from 'opengso-prod/edge';");
  });

  it('takes no URL', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await prodDataCommand({ argv: ['https://example.com'], packageName: 'opengso', version: '0.0.0' })).toBe(2);
    expect(String(err.mock.calls[0]?.[0])).toContain('takes no URL');
  });
});

/**
 * Just enough of a Node response to watch what the middleware does with it.
 */
function fakeResponse() {
  /** @type {Record<string, string>} */
  const headers = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    headers,
    /** @type {string | undefined} */
    body: undefined,
    /** @param {string} name @param {string} value */
    setHeader: (name, value) => {
      headers[name.toLowerCase()] = value;
    },
    /** @param {string} name */
    getHeader: (name) => headers[name.toLowerCase()],
    /** @param {string} [body] */
    end: (body) => {
      res.body = body;
    },
  };
  return res;
}
