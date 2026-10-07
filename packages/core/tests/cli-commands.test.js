import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCommand } from '../src/cli/commands/generate.js';
import { testCommand } from '../src/cli/commands/test.js';
/** @import { Server } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */

/**
 * The command handlers themselves, driven the way the CLI drives them.
 *
 * The pillars under them have their own suites. What is checked here is the thin layer that turns
 * flags into options and decides what goes to stdout, which is where a unit mix-up or a stray banner
 * lives and where no pillar test can see it.
 */

/** Every options object the test pillar was handed, so a flag can be followed to where it lands. */
const seen = /** @type {{ testUrl: Array<{ timeoutMs?: number }>; runTestSuite: Array<{ timeoutMs?: number }> }} */ ({
  testUrl: [],
  runTestSuite: [],
});

vi.mock('../src/test/index.js', async (importOriginal) => {
  const original = /** @type {typeof import('../src/test/index.js')} */ (await importOriginal());
  return {
    ...original,
    /** @type {typeof original.testUrl} */
    testUrl: (url, options) => {
      seen.testUrl.push(options ?? {});
      return original.testUrl(url, options);
    },
    /** @type {typeof original.runTestSuite} */
    runTestSuite: (url, options) => {
      seen.runTestSuite.push(options ?? {});
      return original.runTestSuite(url, options);
    },
  };
});

/** @type {Server} */
let server;
/** @type {string} */
let site;
/** @type {string} */
let root;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><title>Home</title></head><body><main><h1>Home</h1></main></body></html>');
  });
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  site = `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`;
});

afterAll(async () => {
  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opengeo-cmd-'));
  seen.testUrl.length = 0;
  seen.runTestSuite.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/**
 * Run a handler with stdout and stderr captured.
 *
 * @param {(ctx: { argv: string[]; packageName: string; version: string }) => Promise<number>} command
 * @param {string[]} argv
 * @returns {Promise<{ code: number; stdout: string; stderr: string }>}
 */
async function run(command, argv) {
  let stdout = '';
  let stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const code = await command({ argv, packageName: 'opengeo', version: '0.0.0-test' });
    return { code, stdout, stderr };
  } finally {
    vi.restoreAllMocks();
  }
}

describe('opengeo test --timeout', () => {
  it('reads the value as seconds, the unit the help page and every other command use', async () => {
    await run(testCommand, [site, '--project', root, '--structure', '--json', '--timeout', '30']);

    expect(seen.runTestSuite).toHaveLength(1);
    expect(seen.runTestSuite[0]?.timeoutMs).toBe(30_000);
  });

  it('does the same for --prompt, which takes the other road through the pillar', async () => {
    await run(testCommand, [site, '--project', root, '--prompt', '--timeout', '2']);

    expect(seen.testUrl).toHaveLength(1);
    expect(seen.testUrl[0]?.timeoutMs).toBe(2_000);
  });

  it('leaves the pillar its own default when the flag is absent', async () => {
    await run(testCommand, [site, '--project', root, '--structure', '--json']);

    expect(seen.runTestSuite[0]?.timeoutMs).toBeUndefined();
  });
});

describe('opengeo generate --json', () => {
  it('writes nothing to stdout but the JSON, so it can be piped into jq', async () => {
    const { stdout } = await run(generateCommand, [site, '--project', root, '--json', '--single']);

    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(JSON.parse(stdout)).toMatchObject({ site });
  });
});
