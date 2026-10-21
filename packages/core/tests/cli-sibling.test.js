import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_USAGE } from '../src/cli/args.js';
import { runCli } from '../src/cli/index.js';
import { DELEGATED_VARIABLE, defaultSiblingRoots, findSibling, runSibling } from '../src/cli/sibling.js';

/**
 * Two OpenGSO packages installed side by side share one `opengso` bin, and npm links whichever it
 * installed last. The bin that lost the link still has to answer every command the other ships.
 *
 * Each test builds a fake install tree in a temp dir: a `node_modules/<name>` with a package.json
 * and a bin script, nothing else. The bin scripts here write what they were given to a file and
 * exit with a code of their own, so the handover is observed from outside the process.
 */

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opengso-sibling-'));
  delete process.env[DELEGATED_VARIABLE];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env[DELEGATED_VARIABLE];
  vi.restoreAllMocks();
});

/**
 * @param {string} tree The directory that holds `node_modules`.
 * @param {string} name
 * @param {object} [options]
 * @param {string | Record<string, string>} [options.bin]
 * @param {boolean} [options.withScript]
 * @param {string} [options.script]
 * @returns {string} The bin script's path.
 */
function install(tree, name, { bin = { opengso: 'dist/cli.js' }, withScript = true, script = '' } = {}) {
  const dir = join(tree, 'node_modules', name);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', type: 'module', bin }));
  const file = join(dir, typeof bin === 'string' ? bin : bin.opengso);
  if (withScript) writeFileSync(file, script);
  return file;
}

/**
 * A bin that records its argv and its environment, then exits with `code`.
 *
 * @param {string} record
 * @param {number} code
 */
const recorder = (record, code) =>
  `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), delegated: process.env.${DELEGATED_VARIABLE} ?? null }));
process.exit(${code});
`;

describe('findSibling', () => {
  it('finds a package that ships the command by walking up from the asking bin', () => {
    const bin = install(root, 'opengso-cli');
    const from = join(root, 'node_modules', 'opengso-prod', 'dist');
    mkdirSync(from, { recursive: true });
    expect(findSibling('test', { roots: [from], self: 'opengso-prod' })).toEqual({
      name: 'opengso-cli',
      version: '1.2.3',
      bin,
    });
  });

  it('looks only in the trees it is given, never in a project it was not installed into', () => {
    install(root, 'opengso-testing');
    const elsewhere = mkdtempSync(join(tmpdir(), 'opengso-global-'));
    try {
      expect(findSibling('test', { roots: [elsewhere], self: 'opengso-prod' })).toBeUndefined();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses a bin that points outside its package', () => {
    install(root, 'opengso-cli', { bin: '../../escape.js' });
    expect(existsSync(join(root, 'escape.js'))).toBe(true);
    expect(findSibling('test', { roots: [root], self: 'opengso-prod' })).toBeUndefined();
  });

  it('returns nothing when no installed package ships the command', () => {
    install(root, 'opengso-generate');
    expect(findSibling('test', { roots: [root], self: 'opengso-prod' })).toBeUndefined();
  });

  it('never picks the package that is asking, nor one whose bin script is missing', () => {
    install(root, 'opengso-prod');
    install(root, 'opengso-cli', { withScript: false });
    expect(findSibling('prod test', { roots: [root], self: 'opengso-prod' })).toBeUndefined();
    expect(findSibling('test', { roots: [root], self: 'opengso-prod' })).toBeUndefined();
  });

  it('prefers the nearer tree, and within it the widest package', () => {
    const near = join(root, 'app');
    const nearBin = install(near, 'opengso-testing');
    install(root, 'opengso');
    expect(findSibling('test', { roots: [join(near, 'src')], self: 'opengso-prod' })?.bin).toBe(nearBin);
    const wide = install(near, 'opengso');
    expect(findSibling('test', { roots: [join(near, 'src')], self: 'opengso-prod' })?.bin).toBe(wide);
  });

  it('accepts a string bin and a package.json it cannot parse', () => {
    const bin = install(root, 'opengso-cli', { bin: 'cli.js' });
    expect(findSibling('generate', { roots: [root], self: 'opengso-prod' })?.bin).toBe(bin);
    writeFileSync(join(root, 'node_modules', 'opengso-cli', 'package.json'), '{not json');
    expect(findSibling('generate', { roots: [root], self: 'opengso-prod' })).toBeUndefined();
  });

  it('starts from where the running bin lives, and not from the current directory', () => {
    const roots = defaultSiblingRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatch(/[\\/]cli$/);
    expect(roots).not.toContain(process.cwd());
  });
});

describe('the handover', () => {
  it('runs the sibling bin with the whole command line and answers with its exit code', () => {
    const record = join(root, 'record.json');
    const bin = install(root, 'opengso-cli', { script: recorder(record, 7) });
    const code = runSibling({ name: 'opengso-cli', version: '1.2.3', bin }, ['test', 'http://x', '--json']);
    expect(code).toBe(7);
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({
      argv: ['test', 'http://x', '--json'],
      delegated: '1',
    });
  });

  it('is what runCli does for a command this package does not ship when a sibling does', async () => {
    const record = join(root, 'record.json');
    install(root, 'opengso-cli', { script: recorder(record, 3) });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runCli({
      packageName: 'opengso-prod',
      version: '0.0.0',
      commands: {},
      argv: ['test', 'http://localhost:1/', '--structure'],
      siblingRoots: [root],
    });
    expect(code).toBe(3);
    expect(stderr).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(record, 'utf8')).argv).toEqual(['test', 'http://localhost:1/', '--structure']);
  });

  it('still prints the install message when no sibling ships the command', async () => {
    install(root, 'opengso-generate');
    let text = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      text += String(chunk);
      return true;
    });
    const code = await runCli({ packageName: 'opengso-prod', version: '0.0.0', commands: {}, argv: ['test', 'http://x'], siblingRoots: [root] });
    expect(code).toBe(EXIT_USAGE);
    expect(text).toContain("`opengso test` isn't part of opengso-prod.");
    expect(text).toContain('npm install -D opengso-testing');
  });

  it('never hands a command back once it has been handed over', async () => {
    const record = join(root, 'record.json');
    install(root, 'opengso-cli', { script: recorder(record, 3) });
    process.env[DELEGATED_VARIABLE] = '1';
    let text = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      text += String(chunk);
      return true;
    });
    const code = await runCli({ packageName: 'opengso-prod', version: '0.0.0', commands: {}, argv: ['test', 'http://x'], siblingRoots: [root] });
    expect(code).toBe(EXIT_USAGE);
    expect(text).toContain("isn't part of opengso-prod");
  });
});
