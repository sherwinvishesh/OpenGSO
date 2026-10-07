import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callProvider, readManifestChecked } from '@opengeo/core/generate';
import { createFsStore } from '@opengeo/core/prod';
import { handleApi } from '../src/server/api.js';
/** @import { IncomingMessage, ServerResponse } from 'node:http' */

/**
 * JSON that parses is not JSON of the right shape.
 *
 * Every file and response below is read with a JSDoc cast that tells the type checker what it is.
 * The cast is a promise about the input, and these inputs come from a disk anybody can edit or a
 * server somebody else runs, so each one is checked where it comes in. A bad one becomes a reason
 * the user can act on, never a TypeError from three calls further in.
 */

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opengeo-malformed-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * @param {(req: IncomingMessage, res: ServerResponse) => void} handler
 * @returns {Promise<{ base: string; close: () => Promise<void> }>}
 */
async function serve(handler) {
  const server = createServer(handler);
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => /** @type {Promise<void>} */ (new Promise((resolve) => server.close(() => resolve()))),
  };
}

describe("prod's manifest", () => {
  /** @param {string} text */
  function writeManifestText(text) {
    mkdirSync(join(root, '.opengeo'), { recursive: true });
    writeFileSync(join(root, '.opengeo', 'manifest.json'), text);
  }

  it('starts with no twins and a reason, rather than throwing, when the file is valid JSON but not a manifest', () => {
    for (const text of ['null', '7', '"pages"', '{"pages":null}', '{"pages":"md/a.md"}']) {
      writeManifestText(text);
      const store = createFsStore({ root });
      expect(store.size).toBe(0);
      expect(store.problems.join('\n')).toContain('manifest.json');
    }
  });

  it('loads the entries that make sense and names the ones that do not', () => {
    mkdirSync(join(root, 'public', 'md'), { recursive: true });
    writeFileSync(join(root, 'public', 'md', 'ok.md'), '# Ok\n');
    writeManifestText(
      JSON.stringify({
        pages: {
          '/ok': { route: '/ok', file: 'md/ok.md', tokens: 2 },
          '/null': null,
          '/no-file': { route: '/no-file', file: 5, tokens: 2 },
          '/no-route': { file: 'md/ok.md', tokens: 2 },
        },
      }),
    );
    const store = createFsStore({ root });
    expect(store.routes()).toEqual(['/ok']);
    const problems = store.problems.join('\n');
    for (const key of ['/null', '/no-file', '/no-route']) expect(problems).toContain(key);
  });
});

describe("generate's manifest", () => {
  it('is set aside with a reason when a page entry has no route, url or file', () => {
    for (const entry of [null, 'md/a.md', { route: '/', url: 'https://e.com/', file: 7 }, { url: 'https://e.com/', file: 'md/index.md' }]) {
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({ version: 1, pages: { '/': entry } }));
      const read = readManifestChecked(root, 'https://e.com');
      expect(read.manifest.pages).toEqual({});
      expect(read.problem).toContain(join(root, 'manifest.json'));
    }
  });
});

describe('a provider reply that is not the shape it should be', () => {
  /**
   * @param {'anthropic' | 'openai' | 'gemini'} api
   * @param {string} body What the provider answers, with a 200.
   */
  async function ask(api, body) {
    const server = await serve((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(body));
    try {
      return await callProvider({
        provider: 'custom',
        model: 'm',
        apiKey: 'sk-test-not-a-real-key',
        system: 's',
        prompt: 'p',
        overrides: { baseUrl: `${server.base}/v1`, api, auth: 'bearer' },
      });
    } finally {
      await server.close();
    }
  }

  it('says the answer was not JSON, rather than surfacing a parser error', async () => {
    await expect(ask('openai', '<html>Bad gateway</html>')).rejects.toThrow(/not with JSON[\s\S]*Bad gateway/);
  });

  it('says the same about JSON that is not an object', async () => {
    for (const body of ['null', '42', '"text"']) {
      await expect(ask('anthropic', body)).rejects.toThrow(/not with JSON/);
    }
  });

  it('reports no content when the content is in the wrong place, for each wire format', async () => {
    await expect(ask('anthropic', JSON.stringify({ content: { text: 'x' } }))).rejects.toThrow(/returned no text content/);
    await expect(ask('anthropic', JSON.stringify({ content: [null] }))).rejects.toThrow(/returned no text content/);
    await expect(ask('openai', JSON.stringify({ choices: [{ message: { content: [{ text: 'x' }] } }] }))).rejects.toThrow(
      /returned no message content/,
    );
    await expect(ask('gemini', JSON.stringify({ candidates: [{ content: { parts: { text: 'x' } } }] }))).rejects.toThrow(
      /returned no candidate content/,
    );
    await expect(ask('gemini', JSON.stringify({ candidates: [{ content: { parts: [null] } }] }))).rejects.toThrow(
      /returned no candidate content/,
    );
  });
});

describe('a dashboard API body that is not the shape it should be', () => {
  const OPTIONS = { version: '0.0.0-test', packageName: 'opengeo' };
  /**
   * @param {string} path
   * @param {unknown} body
   */
  const post = (path, body) => handleApi({ method: 'POST', path, body }, { ...OPTIONS, root });

  it('is a 400 naming the field, not a 500', async () => {
    const cases = /** @type {Array<[string, unknown, string]>} */ ([
      ['/api/file', { path: 5 }, 'path'],
      ['/api/preview', { url: 5 }, 'url'],
      ['/api/key', { provider: 'anthropic', apiKey: 5 }, 'apiKey'],
      ['/api/test', { url: 'http://127.0.0.1:9/', maxDocs: '3' }, 'maxDocs'],
      ['/api/prod-test', { url: 'http://127.0.0.1:9/', timeoutMs: '1' }, 'timeoutMs'],
    ]);
    for (const [path, body, field] of cases) {
      const reply = await post(path, body);
      expect(reply.status, path).toBe(400);
      expect(/** @type {{ error: string }} */ (reply.body).error, path).toContain(field);
    }
  });

  it('is a 400 when the body is not an object at all', async () => {
    for (const body of ['md/index.md', 5, [1]]) {
      const reply = await post('/api/file', body);
      expect(reply.status).toBe(400);
    }
  });

  it('refuses a crawl limit that is not a number before anything is fetched', async () => {
    let requests = 0;
    const site = await serve((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body><a href="/a">a</a></body></html>');
    });
    try {
      const reply = await post('/api/generate', { url: site.base, single: true, maxPages: 'lots' });
      expect(reply.status).toBe(400);
      expect(/** @type {{ error: string }} */ (reply.body).error).toContain('maxPages');
      expect(requests).toBe(0);
    } finally {
      await site.close();
    }
  });

  it('still treats a null field as absent, the way the handlers always have', async () => {
    const reply = await post('/api/file', { path: null });
    expect(reply.status).toBe(400);
    expect(/** @type {{ error: string }} */ (reply.body).error).toMatch(/Expected a path/);
  });
});
