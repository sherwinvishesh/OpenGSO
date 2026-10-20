import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCommand } from '../src/cli/commands/generate.js';
import { openBrowser, startCommand } from '../src/cli/commands/start.js';
import { prodTestCommand } from '../src/cli/commands/prod-test.js';
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

/**
 * `run` for a call that builds its own context, such as `runCli` with a command table.
 *
 * @param {() => Promise<number>} thunk
 */
const capture = (thunk) => run(() => thunk(), []);

/** @param {string[]} argv */
const ctx = (argv) => ({ argv, packageName: 'opengeo', version: '0.0.0-test' });

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

describe('opengeo generate, the first time', () => {
  it('says the twins are not served yet and what serves them, once', async () => {
    const first = await run(generateCommand, [site, '--project', root, '--single']);
    expect(first.code).toBe(0);
    const said = first.stdout.replace(/\s+/g, ' ');
    expect(said).toContain('agents still get HTML until your server serves these twins');
    expect(said).toContain('proxy.ts');
    expect(said).toContain(`opengeo test ${site}`);

    const again = await run(generateCommand, [site, '--project', root, '--single', '--force']);
    expect(again.stdout).not.toContain('agents still get HTML');
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

describe('opengeo help <command>', () => {
  /** @param {string[]} argv */
  const cli = (argv) => runCli({ packageName: 'opengeo', version: '0.0.0', commands: { test: testCommand }, argv });

  it('prints the same page as <command> --help', async () => {
    const asked = await capture(() => cli(['test', '--help']));
    for (const argv of [['help', 'test'], ['help', 'prod', 'test'], ['help', 'setup']]) {
      const { code, stdout } = await capture(() => cli(argv));
      expect(code, argv.join(' ')).toBe(0);
      expect(stdout, argv.join(' ')).not.toContain('Exit codes');
    }
    expect((await capture(() => cli(['help', 'test']))).stdout).toBe(asked.stdout);
    expect((await capture(() => cli(['help', 'prod', 'test']))).stdout).toContain('opengeo prod test');
  });

  it('says so when there is no such command to explain', async () => {
    const { code, stderr } = await capture(() => cli(['help', 'tset']));
    expect(code).toBe(2);
    expect(stderr).toContain('Unknown command: `opengeo tset`');
  });
});

describe('opengeo prod without test', () => {
  it('points at prod test, the one command under it', async () => {
    for (const argv of [['prod'], ['prod', site], ['help', 'prod']]) {
      const { code, stderr } = await capture(() =>
        runCli({ packageName: 'opengeo', version: '0.0.0', commands: { 'prod test': prodTestCommand }, argv }),
      );
      expect(code, argv.join(' ')).toBe(2);
      expect(stderr, argv.join(' ')).toContain('opengeo prod test <url>');
    }
  });

  it('says nothing about prod for any other unknown command', async () => {
    const { stderr } = await capture(() =>
      runCli({ packageName: 'opengeo', version: '0.0.0', commands: { 'prod test': prodTestCommand }, argv: ['tset'] }),
    );
    expect(stderr).not.toContain('<url>');
  });
});

describe('colour, on a terminal, for output that is not going to it', () => {
  const ESC = String.fromCharCode(27);
  const saved = { ...process.env };
  /** @type {boolean | undefined} */
  let tty;

  beforeEach(() => {
    delete process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    process.env.TERM = 'xterm-256color';
    tty = process.stdout.isTTY;
    process.stdout.isTTY = true;
  });

  afterEach(() => {
    process.env = { ...saved };
    process.stdout.isTTY = /** @type {true} */ (tty);
  });

  it('writes plain text to a --out file', async () => {
    const report = join(root, 'test.txt');
    const prod = join(root, 'prod.txt');
    await run(testCommand, [site, '--structure', '--out', report, '--project', root]);
    await run(prodTestCommand, [site, '--out', prod, '--project', root]);
    expect(readFileSync(report, 'utf8')).not.toContain(ESC);
    expect(readFileSync(prod, 'utf8')).toContain('/');
    expect(readFileSync(prod, 'utf8')).not.toContain(ESC);
  });

  it('writes plain text to a stderr that is a pipe', async () => {
    const { stderr } = await run(
      ({ argv }) => runCli({ packageName: 'opengeo', version: '0.0.0', commands: { test: testCommand }, argv }),
      ['test', '--project', root],
    );
    expect(stderr).toContain('Error');
    expect(stderr).not.toContain(ESC);
  });
});

describe('a run that throws while the spinner is up', () => {
  const saved = { ...process.env };
  /** @type {boolean | undefined} */
  let tty;

  beforeEach(() => {
    process.env.FORCE_COLOR = '1';
    delete process.env.NO_COLOR;
    tty = process.stdout.isTTY;
    process.stdout.isTTY = true;
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../src/test/index.js');
    vi.doUnmock('../src/generate/site.js');
    vi.resetModules();
    process.env = { ...saved };
    process.stdout.isTTY = /** @type {true} */ (tty);
  });

  /**
   * Run the command, let it fail, then let the spinner's timer run: nothing may be drawn after the
   * error, or the next frame erases it.
   *
   * @param {() => Promise<number>} run
   */
  const afterTheThrow = async (run) => {
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(run()).rejects.toThrow('the network went away');
    const settled = stdout.length;
    await vi.advanceTimersByTimeAsync(1000);
    vi.restoreAllMocks();
    return stdout.slice(settled);
  };

  it('stops the spinner in test', async () => {
    vi.doMock('../src/test/index.js', async (original) => ({
      .../** @type {object} */ (await original()),
      runTestSuite: async (/** @type {string} */ _url, /** @type {{ onProgress?: (event: object) => void }} */ options) => {
        options.onProgress?.({ phase: 'structure' });
        throw new Error('the network went away');
      },
    }));
    const { testCommand: fresh } = await import('../src/cli/commands/test.js');
    expect(await afterTheThrow(() => fresh(ctx([site, '--structure', '--project', root])))).toBe('');
  });

  it('stops the spinner in generate', async () => {
    vi.doMock('../src/generate/site.js', async (original) => ({
      .../** @type {object} */ (await original()),
      generateSite: async (/** @type {{ onProgress?: (event: object) => void }} */ options) => {
        options.onProgress?.({ phase: 'files' });
        throw new Error('the network went away');
      },
    }));
    const { generateCommand } = await import('../src/cli/commands/generate.js');
    expect(await afterTheThrow(() => generateCommand(ctx([site, '--project', root])))).toBe('');
  });
});
