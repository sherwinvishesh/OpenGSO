import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testUrl } from '@opengeo/core/test';
/** @import { IncomingMessage, Server, ServerResponse } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */
/** @import { TestResult } from '@opengeo/core/test' */

/**
 * Sites that answer in ways a well-behaved one would not, run through the real probe and the real
 * checks over loopback. Each test installs its own handler, so every case is one site's behaviour.
 */

/** @typedef {(req: IncomingMessage, res: ServerResponse, path: string) => void} Handler */

/** @type {Handler} */
let handler = (_req, res) => {
  res.end();
};

/** @type {Server} */
let server;
/** @type {string} */
let site;

const PAGE = `<!doctype html><html><head><title>Docs</title></head><body><main><h1>Docs</h1>
<p>Shipped four projects in 2024 across three teams, including a platform migration that moved
forty-two services onto a shared runtime, and a pricing change worth twelve thousand five hundred
dollars a month to the business. Earlier work covered data pipelines and developer tooling, with a
long stretch owning the build system and the release process for a codebase of roughly two hundred
thousand lines.</p></main></body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res, new URL(req.url ?? '/', 'http://localhost').pathname));
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  site = `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`;
});

afterAll(async () => {
  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
});

beforeEach(() => {
  handler = (_req, res) => {
    res.end();
  };
});

/**
 * @param {TestResult} result
 * @param {string} id
 */
function check(result, id) {
  const found = result.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
}

describe('a single-page app that answers 200 with its shell for every path', () => {
  beforeEach(() => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    };
  });

  it('does not credit robots.txt, llms.txt or a twin it does not have', async () => {
    const result = await testUrl(`${site}/docs/page`);
    expect(check(result, 'A1').status).toBe('fail');
    expect(check(result, 'A1').reason).toContain('HTML');
    expect(check(result, 'A2').status).toBe('fail');
    expect(check(result, 'A2').reason).toContain('HTML');
    expect(check(result, 'B1').status).toBe('fail');
    expect(check(result, 'B1').reason).toContain('HTML');
  });

  it('locks the twin cascade behind B1, since the HTML shell is not a twin', async () => {
    const result = await testUrl(`${site}/docs/page`);
    for (const id of ['B2', 'B3', 'B4', 'B5', 'B6', 'B12', 'B14']) {
      expect(check(result, id).status, id).toBe('locked');
    }
  });
});
