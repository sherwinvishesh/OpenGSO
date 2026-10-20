import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MARKDOWN_CONTENT_TYPE, createFsStore } from '@opengeo/core/prod';
import { createNextMiddleware } from '@opengeo/core/prod/next';
/** @import { Server } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */
/** @import { NextMiddlewareResult } from '@opengeo/core/prod/next' */

/**
 * The Next adapter is built at module scope in the user's proxy.ts, so anything it throws while
 * loading the project takes down every request the site serves, pages included. A config file it
 * cannot use has to cost the site its markdown, never its HTML.
 */

/** @type {Server[]} */
const servers = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))),
  );
});

/**
 * A project directory with one generated twin and the given config file text.
 *
 * @param {string | undefined} configText
 */
function project(configText) {
  const root = mkdtempSync(join(tmpdir(), 'opengeo-next-'));
  mkdirSync(join(root, 'public', 'md'), { recursive: true });
  mkdirSync(join(root, '.opengeo'), { recursive: true });
  writeFileSync(join(root, 'public', 'md', 'resume.md'), '---\ntitle: "Resume"\n---\n# Resume\n');
  writeFileSync(
    join(root, '.opengeo', 'manifest.json'),
    JSON.stringify({ pages: { '/resume': { route: '/resume', file: 'md/resume.md', tokens: 3 } } }),
  );
  if (configText !== undefined) writeFileSync(join(root, 'opengeo.config.json'), configText);
  return root;
}

/**
 * The adapter in front of a one-page app, over real HTTP.
 *
 * @param {(request: Request) => NextMiddlewareResult} middleware
 */
async function listen(middleware) {
  const server = createServer((req, res) => {
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: /** @type {Record<string, string>} */ (req.headers),
    });
    const { response, headers } = middleware(request);
    if (response) {
      void response.text().then((body) => {
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(body);
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end('<h1>Resume</h1>');
  });
  servers.push(server);
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  return `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`;
}

describe('a config file the adapter cannot use', () => {
  it.each([
    ['malformed JSON', '{ "site": "http://x", '],
    ['a wrongly typed bots.markdownRouting', '{ "bots": { "markdownRouting": "GPTBot" } }'],
    ['a publicDir outside the project', '{ "publicDir": "/etc" }'],
  ])('fails open on %s: one log line, and every request reaches the site', async (_label, text) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const middleware = createNextMiddleware({ root: project(text) });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toMatch(/^\[opengeo-prod\] .*opengeo\.config\.json/);
    expect(String(errors.mock.calls[0]?.[0])).not.toContain('\n');
    expect(log).not.toHaveBeenCalled();

    const site = await listen(middleware);
    for (const accept of ['text/markdown', 'application/pdf', 'text/html']) {
      const response = await fetch(`${site}/resume`, { headers: { accept } });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    }
  });

  it('serves the twin as usual when the config is fine', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const site = await listen(createNextMiddleware({ root: project('{ "site": "http://localhost:3000" }'), logStartup: false }));
    const response = await fetch(`${site}/resume`, { headers: { accept: 'text/markdown' } });
    expect(response.headers.get('content-type')).toBe(MARKDOWN_CONTENT_TYPE);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('a manifest entry that points outside publicDir', () => {
  it('is skipped and reported, and never served', async () => {
    const root = project(undefined);
    writeFileSync(join(root, 'secret.md'), '# DATABASE_PASSWORD=hunter2\n');
    writeFileSync(
      join(root, '.opengeo', 'manifest.json'),
      JSON.stringify({
        pages: {
          '/resume': { route: '/resume', file: 'md/resume.md', tokens: 3 },
          '/leak': { route: '/leak', file: '../secret.md', tokens: 3 },
          '/deep': { route: '/deep', file: 'md/../../secret.md', tokens: 3 },
        },
      }),
    );

    const store = createFsStore({ root });
    expect(store.routes()).toEqual(['/resume']);
    expect(store.problems).toHaveLength(2);
    expect(store.problems.join('\n')).toMatch(/\/leak.*outside/);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const site = await listen(createNextMiddleware({ root, store, logStartup: false }));
    const leak = await fetch(`${site}/leak`, { headers: { accept: 'text/markdown' } });
    expect(await leak.text()).not.toContain('hunter2');
  });

  it('still loads a file whose name merely starts with two dots', () => {
    const root = project(undefined);
    writeFileSync(join(root, 'public', 'md', '..notes.md'), '# Notes\n');
    writeFileSync(
      join(root, '.opengeo', 'manifest.json'),
      JSON.stringify({ pages: { '/notes': { route: '/notes', file: 'md/..notes.md', tokens: 1 } } }),
    );
    expect(createFsStore({ root }).routes()).toEqual(['/notes']);
  });
});

describe('reloading on a development server', () => {
  let tick = 0;
  /**
   * Rewrite a file and move its modification time on, so the change is visible to a stat even
   * when the write lands in the same millisecond as the last one.
   *
   * @param {string} file
   * @param {string} text
   */
  function rewrite(file, text) {
    writeFileSync(file, text);
    tick += 10;
    const when = new Date(Date.UTC(2030, 0, 1) + tick * 1000);
    utimesSync(file, when, when);
  }

  /** The adapter's clock, moved by hand so a test does not sleep through the one-second check. */
  let now = 0;
  /** @param {number} ms */
  const advance = (ms) => {
    now += ms;
  };

  /**
   * @param {(request: Request) => NextMiddlewareResult} middleware
   * @param {string} path
   */
  async function twin(middleware, path = '/resume') {
    const result = middleware(new Request(`http://localhost:3000${path}`, { headers: { accept: 'text/markdown' } }));
    return result.response ? await result.response.text() : null;
  }

  /** @param {string} root */
  function regenerate(root, body = '# Resume\n\nUpdated.\n') {
    rewrite(join(root, 'public', 'md', 'resume.md'), `---\ntitle: "Resume"\n---\n${body}`);
  }

  /** @param {string} root */
  function quiet(root) {
    now = Date.UTC(2030, 0, 1);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    return { root, log, errors };
  }

  it('serves a regenerated twin after the next check, and says it reloaded', async () => {
    const { root, log } = quiet(project('{}'));
    const middleware = createNextMiddleware({ root, reload: true });
    expect(await twin(middleware)).toBe('# Resume');
    expect(String(log.mock.calls[0]?.[0])).toContain('startup check');

    regenerate(root);
    expect(await twin(middleware)).not.toContain('Updated.');
    advance(1000);
    expect(await twin(middleware)).toContain('Updated.');
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain('reloaded after a change on disk');
  });

  it('checks at most once a second, and does not reload when nothing changed', async () => {
    const { root, log } = quiet(project('{}'));
    const middleware = createNextMiddleware({ root, reload: true });
    const boot = log.mock.calls.length;
    advance(5000);
    await twin(middleware);
    expect(log.mock.calls.length).toBe(boot);

    regenerate(root);
    advance(999);
    expect(await twin(middleware)).not.toContain('Updated.');
    advance(1);
    expect(await twin(middleware)).toContain('Updated.');
  });

  it('picks up a page the new manifest adds, and drops one it removes', async () => {
    const { root } = quiet(project('{}'));
    const middleware = createNextMiddleware({ root, reload: true, logStartup: false });
    writeFileSync(join(root, 'public', 'md', 'about.md'), '---\ntitle: "About"\n---\n# About\n');
    rewrite(
      join(root, '.opengeo', 'manifest.json'),
      JSON.stringify({ pages: { '/about': { route: '/about', file: 'md/about.md', tokens: 2 } } }),
    );
    advance(1000);
    expect(await twin(middleware, '/about')).toContain('# About');
    expect(await twin(middleware, '/resume')).toBeNull();
  });

  it('notices the first generate on a server started before there was a manifest', async () => {
    const { root } = quiet(project('{}'));
    rmSync(join(root, '.opengeo', 'manifest.json'));
    const middleware = createNextMiddleware({ root, reload: true, logStartup: false });
    expect(await twin(middleware)).toBeNull();
    rewrite(
      join(root, '.opengeo', 'manifest.json'),
      JSON.stringify({ pages: { '/resume': { route: '/resume', file: 'md/resume.md', tokens: 3 } } }),
    );
    advance(1000);
    expect(await twin(middleware)).toContain('# Resume');
  });

  it('notices a twin the manifest already listed when it finally appears', async () => {
    const { root } = quiet(project('{}'));
    rmSync(join(root, 'public', 'md', 'resume.md'));
    const middleware = createNextMiddleware({ root, reload: true, logStartup: false });
    expect(await twin(middleware)).toBeNull();
    regenerate(root);
    advance(1000);
    expect(await twin(middleware)).toContain('Updated.');
  });

  it('fails open when the config breaks mid-session, and recovers when it is fixed', async () => {
    const { root, errors } = quiet(project('{}'));
    const middleware = createNextMiddleware({ root, reload: true, logStartup: false });
    const config = join(root, 'opengeo.config.json');

    rewrite(config, '{ "site": ');
    advance(1000);
    expect(await twin(middleware)).toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toMatch(/^\[opengeo-prod\] markdown is off/);

    advance(1000);
    await twin(middleware);
    expect(errors).toHaveBeenCalledTimes(1);

    rewrite(config, '{}');
    advance(1000);
    expect(await twin(middleware)).toContain('# Resume');
  });

  it('notices a config file created after boot', async () => {
    const { root } = quiet(project(undefined));
    const middleware = createNextMiddleware({ root, reload: true, logStartup: false });
    expect(await twin(middleware)).toContain('# Resume');
    rewrite(join(root, 'opengeo.config.json'), '{ "publicDir": "site" }');
    advance(1000);
    expect(await twin(middleware)).toBeNull();
  });

  it('keeps serving the previous twins when a reload fails for another reason', async () => {
    const { root, log, errors } = quiet(project('{}'));
    const middleware = createNextMiddleware({ root, reload: true });
    log.mockImplementation(() => {
      throw new Error('EPIPE: the terminal went away\nsecond line');
    });
    regenerate(root);
    advance(1000);
    expect(await twin(middleware)).toBe('# Resume');
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toBe(
      '[opengeo-prod] the files changed on disk but could not be reloaded, so the previous twins are still being served: EPIPE: the terminal went away',
    );

    advance(1000);
    await twin(middleware);
    expect(errors).toHaveBeenCalledTimes(1);

    log.mockImplementation(() => {});
    regenerate(root, '# Resume\n\nSecond try.\n');
    advance(1000);
    expect(await twin(middleware)).toContain('Second try.');
  });

  it('is off in production, when asked, and for a store the caller built', async () => {
    const { root } = quiet(project('{}'));
    vi.stubEnv('NODE_ENV', 'production');
    const production = createNextMiddleware({ root, logStartup: false });
    vi.unstubAllEnvs();
    const asked = createNextMiddleware({ root, reload: false, logStartup: false });
    const given = createNextMiddleware({ root, reload: true, store: createFsStore({ root }), logStartup: false });
    regenerate(root);
    advance(1000);
    for (const middleware of [production, asked, given]) expect(await twin(middleware)).not.toContain('Updated.');
  });

  it('is on by default outside production', async () => {
    const { root } = quiet(project('{}'));
    vi.stubEnv('NODE_ENV', 'development');
    const middleware = createNextMiddleware({ root, logStartup: false });
    vi.unstubAllEnvs();
    regenerate(root);
    advance(1000);
    expect(await twin(middleware)).toContain('Updated.');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a twin it cannot read instead of failing to boot',
    async () => {
      const { root } = quiet(project('{}'));
      chmodSync(join(root, 'public', 'md', 'resume.md'), 0o000);
      try {
        const store = createFsStore({ root });
        expect(store.routes()).toEqual([]);
        expect(store.problems.join('\n')).toMatch(/\/resume but .*resume\.md could not be read/);
      } finally {
        chmodSync(join(root, 'public', 'md', 'resume.md'), 0o644);
      }
    },
  );
});
