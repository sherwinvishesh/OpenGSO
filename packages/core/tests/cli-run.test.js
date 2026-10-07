import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCommand } from '../src/cli/commands/generate.js';
import { prodTestCommand } from '../src/cli/commands/prod-test.js';
import { settingsCommand } from '../src/cli/commands/settings.js';
import { testCommand } from '../src/cli/commands/test.js';
import { runHome } from '../src/cli/home.js';
import { EXIT_USAGE } from '../src/cli/args.js';
import { runCli } from '../src/cli/index.js';
import { ERRORS } from '../src/shared/errors.js';
/** @import { Server } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */
/** @import { CommandHandler } from '../src/cli/index.js' */

/**
 * The CLI as a script sees it: `runCli` and the command handlers, run against a real loopback
 * site, with nothing but the exit code, stdout and stderr to go on.
 *
 * Every run names its URL and its `--project`, so nothing here ever falls back to the configured
 * default of localhost:3000 or writes into the checkout.
 */

/** When set, every structural failure is reported as a pass, so the success exit can be seen. */
let passEverything = false;

vi.mock('../src/test/index.js', async (importOriginal) => {
  const original = /** @type {typeof import('../src/test/index.js')} */ (await importOriginal());
  return {
    ...original,
    /** @type {typeof original.runTestSuite} */
    runTestSuite: async (url, options) => {
      const result = await original.runTestSuite(url, options);
      if (passEverything && result.structure) {
        const { counts } = result.structure.score;
        counts.pass += counts.fail;
        counts.fail = 0;
        for (const check of result.structure.checks) if (check.status === 'fail') check.status = 'pass';
      }
      return result;
    },
  };
});

/** @type {Server} */
let server;
/** @type {string} */
let site;
/** @type {string} */
let root;

const ENV_KEYS = ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'BUILDKITE', 'OPENGEO_NO_TUI'];
/** @type {Record<string, string | undefined>} */
const savedEnv = {};

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1><p>Hello.</p></main></body></html>');
  });
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  site = `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`;
});

afterAll(async () => {
  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opengeo-run-'));
  passEverything = false;
  // The runner's own CI variable must not decide which branch these tests take.
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
});

/**
 * Capture stdout and stderr around a call.
 *
 * @param {() => Promise<number>} action
 * @returns {Promise<{ code: number; stdout: string; stderr: string }>}
 */
async function captured(action) {
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
    const code = await action();
    return { code, stdout, stderr };
  } finally {
    vi.restoreAllMocks();
  }
}

/**
 * @param {CommandHandler} command
 * @param {string[]} argv
 */
function run(command, argv) {
  return captured(() => command({ argv, packageName: 'opengeo', version: '0.0.0-test' }));
}

/**
 * @param {string[]} argv
 * @param {Partial<Record<import('../src/shared/errors.js').CommandName, CommandHandler>>} [commands]
 */
function cli(argv, commands = { test: testCommand, generate: generateCommand, 'prod test': prodTestCommand }) {
  return captured(() => runCli({ packageName: 'opengeo-cli', version: '9.9.9', commands, argv }));
}

/** @param {string} text */
const plain = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

describe('runCli, before any command runs', () => {
  it('prints the version and nothing else for --version and -v', async () => {
    for (const flag of ['--version', '-v']) {
      const { code, stdout, stderr } = await cli([flag]);
      expect(code).toBe(0);
      expect(stdout).toBe('opengeo-cli 9.9.9\n');
      expect(stderr).toBe('');
    }
  });

  it('prints help to stdout and exits 0 for --help, -h and help', async () => {
    for (const flag of ['--help', '-h', 'help']) {
      const { code, stdout, stderr } = await cli([flag]);
      expect(code).toBe(0);
      expect(plain(stdout)).toContain('opengeo-cli');
      expect(stderr).toBe('');
    }
  });

  it('prints the providers page for both spellings', async () => {
    const one = await cli(['providers']);
    const two = await cli(['help', 'providers']);
    expect(one.code).toBe(0);
    expect(two.code).toBe(0);
    expect(one.stdout).toBe(two.stdout);
    expect(plain(one.stdout)).toMatch(/anthropic/i);
  });

  it('answers a command --help without running the command, even one this install lacks', async () => {
    const handler = vi.fn(async () => 0);
    const shipped = await cli(['test', '--help'], { test: handler });
    const missing = await cli(['start', '--help'], { test: handler });
    expect(shipped.code).toBe(0);
    expect(missing.code).toBe(0);
    expect(plain(missing.stdout)).toContain('start');
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses an unknown command on stderr with a nonzero exit and an empty stdout', async () => {
    const { code, stdout, stderr } = await cli(['frobnicate', '--json']);
    expect(code).not.toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('Unknown command');
  });

  it('names the package to install for a command this one does not ship', async () => {
    const { code, stdout, stderr } = await cli(['settings'], { test: testCommand });
    expect(code).toBe(EXIT_USAGE);
    expect(stdout).toBe('');
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('turns a thrown handler error into "Error <message>" on stderr and exit 1', async () => {
    const boom = async () => {
      throw new Error('kaboom');
    };
    const { code, stdout, stderr } = await cli(['test', site], { test: boom });
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(plain(stderr)).toBe('Error kaboom\n');
  });

  it('routes `prod test` and the `setup` alias to the right handlers with the rest of argv', async () => {
    /** @type {Array<[string, string[]]>} */
    const calls = [];
    /** @param {string} name */
    const spy = (name) => /** @type {CommandHandler} */ (async (ctx) => (calls.push([name, ctx.argv]), 7));
    const commands = { 'prod test': spy('prod'), settings: spy('settings') };
    expect((await cli(['prod', 'test', site, '--json'], commands)).code).toBe(7);
    expect((await cli(['setup', '--yes'], commands)).code).toBe(7);
    expect(calls).toEqual([
      ['prod', [site, '--json']],
      ['settings', ['--yes']],
    ]);
  });

  it('prints the help page for a bare invocation with nobody at the keyboard', async () => {
    const had = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const bare = await cli([]);
      const help = await cli(['--help']);
      expect(bare.code).toBe(0);
      expect(bare.stdout).toBe(help.stdout);
    } finally {
      if (had) Object.defineProperty(process.stdin, 'isTTY', had);
      else delete (/** @type {{ isTTY?: boolean }} */ (process.stdin)).isTTY;
    }
  });
});

describe('opengeo test, as a script sees it', () => {
  it('puts only the JSON on stdout with --json, and exits 1 because checks fail', async () => {
    const { code, stdout } = await cli(['test', site, '--project', root, '--structure', '--json']);
    const json = JSON.parse(stdout);
    expect(stdout.trim().startsWith('{')).toBe(true);
    expect(json.checks.some((/** @type {{ status: string }} */ check) => check.status === 'fail')).toBe(true);
    expect(code).toBe(1);
  });

  it('exits 0 when no check fails', async () => {
    passEverything = true;
    const { code, stdout } = await cli(['test', site, '--project', root, '--structure', '--json']);
    expect(JSON.parse(stdout).checks.every((/** @type {{ status: string }} */ check) => check.status !== 'fail')).toBe(true);
    expect(code).toBe(0);
  });

  it('writes the JSON to --out and says so on stdout instead of printing it', async () => {
    const out = join(root, 'report.json');
    const { code, stdout } = await run(testCommand, [site, '--project', root, '--structure', '--json', '--out', out]);
    expect(code).toBe(1);
    expect(plain(stdout)).toBe(`Wrote ${out}\n`);
    expect(JSON.parse(readFileSync(out, 'utf8')).checks.length).toBeGreaterThan(0);
  });

  it('writes the fix prompt to --out with the same exit code as the run', async () => {
    const out = join(root, 'prompt.md');
    const { code, stdout } = await run(testCommand, [site, '--project', root, '--prompt', '--out', out]);
    expect(code).toBe(1);
    expect(plain(stdout)).toBe(`Wrote ${out}\n`);
    expect(readFileSync(out, 'utf8')).toContain(site);
  });

  it('records the run in history even with --json, without a word on stdout about it', async () => {
    const { stdout } = await run(testCommand, [site, '--project', root, '--structure', '--json']);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(existsSync(join(root, '.opengeo', 'history.json'))).toBe(true);
  });

  it('refuses an unknown option before fetching anything', async () => {
    const { code, stdout, stderr } = await run(testCommand, [site, '--project', root, '--bogus']);
    expect(code).toBe(EXIT_USAGE);
    expect(stdout).toBe('');
    expect(stderr).toContain('--bogus');
  });

  it('refuses --structure with --content', async () => {
    const { code, stdout, stderr } = await run(testCommand, [site, '--project', root, '--structure', '--content']);
    expect(code).toBe(EXIT_USAGE);
    expect(stdout).toBe('');
    expect(stderr).toContain('--structure');
  });

  it('refuses a missing URL in an unconfigured project, through runCli, with the shared error', async () => {
    const { code, stdout, stderr } = await cli(['test', '--project', root, '--json']);
    expect(code).toBe(EXIT_USAGE);
    expect(stdout).toBe('');
    expect(plain(stderr)).toContain(ERRORS.missingUrl('test').split('\n')[0]);
  });

  it('refuses a URL it cannot fetch, through runCli, with the shared error', async () => {
    const { code, stdout, stderr } = await cli(['test', 'ftp://example.invalid', '--project', root, '--json']);
    expect(code).toBe(EXIT_USAGE);
    expect(stdout).toBe('');
    expect(plain(stderr)).toContain(ERRORS.invalidUrl('ftp://example.invalid'));
  });
});

describe('opengeo generate, as a script sees it', () => {
  it('exits 0 for a site whose every page was written, and --json stays pure', async () => {
    const { code, stdout } = await cli(['generate', site, '--project', root, '--single', '--json']);
    expect(code).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.site).toBe(site);
  });

  it('refuses a tier that does not exist', async () => {
    const { code, stdout, stderr } = await run(generateCommand, [site, '--project', root, '--tier', 'premium']);
    expect(code).toBe(EXIT_USAGE);
    expect(stdout).toBe('');
    expect(stderr).toContain('premium');
    expect(existsSync(join(root, '.opengeo'))).toBe(false);
  });

  it('refuses the AI tier under CI before crawling, with the shared error', async () => {
    process.env.CI = 'true';
    const { code, stderr } = await run(generateCommand, [site, '--project', root, '--tier', 'ai']);
    expect(code).toBe(1);
    expect(plain(stderr)).toContain(ERRORS.ciBlocked("generate's AI tier").split('\n')[0]);
    expect(existsSync(join(root, '.opengeo'))).toBe(false);
  });

});

describe('opengeo prod test, as a script sees it', () => {
  it('puts only the JSON on stdout with --json, and its exit code follows ok', async () => {
    const { code, stdout } = await cli(['prod', 'test', site, '--project', root, '--json']);
    const json = JSON.parse(stdout);
    expect(typeof json.ok).toBe('boolean');
    expect(code).toBe(json.ok ? 0 : 1);
    // A plain HTML site with no middleware is not serving markdown.
    expect(json.ok).toBe(false);
  });

  it('writes the report to --out and says so on stdout', async () => {
    const out = join(root, 'prod.json');
    const { code, stdout } = await run(prodTestCommand, [site, '--project', root, '--json', '--out', out]);
    expect(code).toBe(1);
    expect(plain(stdout)).toBe(`Wrote ${out}\n`);
    expect(JSON.parse(readFileSync(out, 'utf8')).ok).toBe(false);
  });

  it('refuses an unknown option before probing', async () => {
    const { code, stdout, stderr } = await run(prodTestCommand, [site, '--project', root, '--structure']);
    expect(code).toBe(EXIT_USAGE);
    expect(stdout).toBe('');
    expect(stderr).toContain('--structure');
  });
});

describe('opengeo settings with nobody at the keyboard', () => {
  it('takes every default with --yes, writes a config and exits 0', async () => {
    const { code } = await run(settingsCommand, ['--yes', '--project', root]);
    expect(code).toBe(0);
    expect(existsSync(join(root, 'opengeo.config.json'))).toBe(true);
    // No probe and no closing test, so no run was recorded.
    expect(existsSync(join(root, '.opengeo', 'history.json'))).toBe(false);
  });

  it('refuses an unknown option without writing anything', async () => {
    const { code } = await run(settingsCommand, ['--yes', '--project', root, '--colour']);
    expect(code).toBe(EXIT_USAGE);
    expect(existsSync(join(root, 'opengeo.config.json'))).toBe(false);
  });
});

describe('runHome off the alternate screen', () => {
  function terminal() {
    const input = /** @type {NodeJS.ReadStream} */ (/** @type {unknown} */ (Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input })));
    const output = /** @type {NodeJS.WriteStream} */ (/** @type {unknown} */ (Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 40 })));
    let seen = '';
    output.on('data', (/** @type {Buffer} */ chunk) => {
      seen += chunk.toString();
    });
    /** @param {string} needle */
    const count = (needle) => plain(seen).split(needle).length - 1;
    /** @param {string} needle */
    const waitFor = async (needle, times = 1) => {
      for (let tries = 0; count(needle) < times; tries += 1) {
        if (tries > 400) throw new Error(`never saw ${JSON.stringify(needle)} x${times}:\n${plain(seen)}`);
        await new Promise((done) => setImmediate(done));
      }
    };
    /** @param {string} label */
    const numberOf = (label) => new RegExp(`(\\d+)\\) ${label}`).exec(plain(seen))?.[1] ?? '';
    return { input, output, raw: () => seen, waitFor, numberOf };
  }

  it('returns -1 and writes nothing when stdin is not a terminal', async () => {
    const output = Object.assign(new PassThrough(), { isTTY: true });
    let written = '';
    output.on('data', (/** @type {Buffer} */ chunk) => (written += chunk.toString()));
    const code = await runHome({
      packageName: 'opengeo',
      version: '0.0.0',
      commands: { test: testCommand },
      root,
      input: /** @type {NodeJS.ReadStream} */ (/** @type {unknown} */ (Object.assign(new PassThrough(), { isTTY: false }))),
      output: /** @type {NodeJS.WriteStream} */ (/** @type {unknown} */ (output)),
    });
    expect(code).toBe(-1);
    expect(written).toBe('');
  });

  it('uses the numbered menu under CI even on a real terminal, and exits 0 whatever the command returned', async () => {
    process.env.CI = '1';
    const term = terminal();
    /** @type {string[][]} */
    const ran = [];
    /** @type {CommandHandler} */
    const test = async (ctx) => {
      ran.push(ctx.argv);
      return 1;
    };
    const done = runHome({ packageName: 'opengeo', version: '0.0.0', commands: { test }, root, input: term.input, output: term.output });

    await term.waitFor('choose a number');
    term.input.write(`${term.numberOf('Test')}\n`);
    await term.waitFor('choose a number', 2);
    term.input.write(`${term.numberOf('Quit')}\n`);

    expect(await done).toBe(0);
    // An unconfigured project has no site, so the flat menu passes no URL and the command asks.
    expect(ran).toEqual([[]]);
    // \x1b[?1049h is the alternate screen. CI must never see it.
    expect(term.raw()).not.toContain('\x1b[?1049h');
  });
});
