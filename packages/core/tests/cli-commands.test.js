import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCommand } from '../src/cli/commands/generate.js';
import { openBrowser, startCommand } from '../src/cli/commands/start.js';
import { testCommand } from '../src/cli/commands/test.js';
import { runOnboarding } from '../src/cli/onboarding.js';
import { runCli } from '../src/cli/index.js';
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

/** How many requests the site has had, so a test can show that a command made none. */
let requests = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    requests += 1;
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

describe('opengeo start, opening the browser', () => {
  it('survives a machine with no opener binary, which reports it as an asynchronous error event', async () => {
    // No error listener is attached here on purpose: if openBrowser does not attach one, the
    // ENOENT is an unhandled 'error' event and the run dies, as `opengeo start` did on headless Linux.
    const child = openBrowser('http://127.0.0.1:1/', 'opengeo-no-such-opener-binary');
    await new Promise((resolve) => child?.once('close', resolve));
    expect(child?.listenerCount('error')).toBeGreaterThan(0);
  });
});

describe('a first run with nobody at the keyboard', () => {
  it('neither probes nor tests the site, and records no run, even without --yes', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    // Readline drops a line that arrives before its question, so each answer is typed once its
    // question is on screen: the URL for the first, Enter for every default after it.
    output.on('data', (chunk) => {
      const text = String(chunk).replace(/\x1b\[[0-9;]*m/g, '');
      if (text.includes('Site URL')) input.write(`${site}\n`);
      else if (/\]\s*$/.test(text)) input.write('\n');
    });
    requests = 0;

    const result = await runOnboarding({
      root,
      mode: 'first-run',
      input: /** @type {NodeJS.ReadStream} */ (/** @type {unknown} */ (input)),
      output: /** @type {NodeJS.WriteStream} */ (/** @type {unknown} */ (output)),
    });

    expect(result.config.site).toBe(site);
    expect(requests).toBe(0);
    expect(existsSync(join(root, '.opengeo', 'history.json'))).toBe(false);
  });
});

describe('opengeo generate --json', () => {
  it('writes nothing to stdout but the JSON, so it can be piped into jq', async () => {
    const { stdout } = await run(generateCommand, [site, '--project', root, '--json', '--single']);

    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(JSON.parse(stdout)).toMatchObject({ site });
  });
});

describe('opengeo test --out', () => {
  it('writes the human report to the file instead of the terminal', async () => {
    const file = join(root, 'report.txt');
    const { stdout } = await run(testCommand, [site, '--structure', '--out', file, '--project', root]);
    const written = readFileSync(file, 'utf8');
    expect(written).toContain('OpenGEO test');
    expect(written).toContain('/100');
    expect(stdout).not.toContain('OpenGEO test');
    expect(stdout).toContain(`Wrote ${file}`);
  });
});

describe('a command line that cannot mean what it says', () => {
  it('refuses a bare --port instead of binding a random one', async () => {
    const { code, stderr } = await run(startCommand, ['--port', '--no-open', '--project', root]);
    expect(code).toBe(2);
    expect(stderr).toContain('--port needs a value');
  });

  it('refuses a port that is not a port', async () => {
    for (const port of ['abc', '70000', '0']) {
      const { code, stderr } = await run(startCommand, ['-p', port, '--no-open', '--project', root]);
      expect(code, port).toBe(2);
      expect(stderr, port).toContain('--port takes a whole number from 1 to 65535');
    }
  });

  it('refuses a non-numeric timeout rather than silently using the default', async () => {
    const { code, stderr } = await run(testCommand, [site, '--timeout', 'soon', '--project', root]);
    expect(code).toBe(2);
    expect(stderr).toContain('"soon"');
  });

  it('reads a URL given after --', async () => {
    const file = join(root, 'report.txt');
    const { code } = await run(testCommand, ['--structure', '--out', file, '--project', root, '--', site]);
    expect(code).not.toBe(2);
    expect(readFileSync(file, 'utf8')).toContain(site);
  });
});

describe('exit codes', () => {
  /** @param {{ argv: string[] }} ctx */
  const cli = ({ argv }) => runCli({ packageName: 'opengeo', version: '0.0.0', commands: { test: testCommand }, argv });

  it('exits 2 for a command line that cannot run, and 1 only for what the run found', async () => {
    expect((await run(cli, ['tset', site])).code).toBe(2);
    expect((await run(cli, ['generate', site])).code).toBe(2);
    expect((await run(cli, ['test', '--project', root])).code).toBe(2);
    expect((await run(cli, ['test', 'not a url', '--project', root])).code).toBe(2);
    expect((await run(cli, ['test', site, '--structure', '--content', '--project', root])).code).toBe(2);
    expect((await run(cli, ['test', site, '--provider', 'nobody', '--project', root])).code).toBe(2);
    expect((await run(cli, ['test', site, '--structure', '--project', root])).code).toBe(1);
  });
});
