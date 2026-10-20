import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
/** @import { Server } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */

/**
 * Edge runtimes have no filesystem, and their bundlers refuse a `node:` import outright rather than
 * tree-shaking it away. So the edge entry has to be fs-free all the way down, and the only honest
 * way to know is to bundle it the way an edge bundler would.
 */

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** @type {Server[]} */
const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))),
  );
});

describe('the edge entry', () => {
  it('bundles for a runtime with no Node builtins', async () => {
    const result = await build({
      stdin: {
        contents: `export * from '@omnigeo/core/prod/edge';`,
        resolveDir: repo,
        loader: 'js',
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      logLevel: 'silent',
    });
    expect(result.errors).toEqual([]);
    expect(result.outputFiles[0]?.text).not.toMatch(/["']node:/);
  });

  it('leaves out everything that reads the disk', async () => {
    const entry = Object.keys(await import('@omnigeo/core/prod/edge'));
    expect(entry).toEqual(
      expect.arrayContaining(['createManifestStore', 'createMemoryStore', 'handleRequest', 'createEdgeMiddleware', 'fetchMiddleware']),
    );
    for (const name of ['createFsStore', 'readTwins', 'createNodeMiddleware', 'logStartupStatus', 'buildStartupStatus']) {
      expect(entry).not.toContain(name);
    }
  });

  it('serves a twin from an inlined manifest, as a generic fetch handler', async () => {
    const { createManifestStore, createProdHandler, MARKDOWN_CONTENT_TYPE } = await import('@omnigeo/core/prod/edge');
    const handle = createProdHandler({
      store: createManifestStore({
        manifest: { pages: { '/resume': { route: '/resume', file: 'md/resume.md', tokens: 3 } } },
        contents: { 'md/resume.md': '---\ntitle: "Resume"\n---\n# Resume\n' },
      }),
      markdownRouting: ['ClaudeBot'],
    });
    const server = createServer((req, res) => {
      const decision = handle(
        new Request(`http://${req.headers.host}${req.url}`, {
          headers: /** @type {Record<string, string>} */ (req.headers),
        }),
      );
      if (decision.type === 'passthrough') {
        res.writeHead(200, { 'content-type': 'text/html', ...decision.headers });
        res.end('<h1>Resume</h1>');
        return;
      }
      void decision.response.text().then((body) => {
        res.writeHead(decision.response.status, Object.fromEntries(decision.response.headers.entries()));
        res.end(body);
      });
    });
    servers.push(server);
    await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
    const site = `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`;

    const markdown = await fetch(`${site}/resume`, { headers: { accept: 'text/markdown' } });
    expect(markdown.headers.get('content-type')).toBe(MARKDOWN_CONTENT_TYPE);
    expect(await markdown.text()).toBe('# Resume');

    const html = await fetch(`${site}/resume`, { headers: { accept: 'text/html' } });
    expect(html.headers.get('content-type')).toBe('text/html');
  });
});
