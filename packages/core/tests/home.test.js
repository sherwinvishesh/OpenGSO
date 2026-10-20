import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homeEntries, homeHeader, plainStatus, readHomeStatus, runHome, statusRows } from '../src/cli/home.js';
import { createPrompter } from '../src/cli/prompt.js';
import { CI_VARIABLES } from '../src/shared/ci.js';
import { glyphs, stripAnsi, visibleWidth } from '../src/shared/render/paint.js';
/** @import { CommandHandler } from '@opengeo/core/cli' */
/** @import { CommandName } from '@opengeo/core/shared' */
/** @import { HomeStatus } from '../src/cli/home.js' */

/**
 * The home screen, read as text.
 *
 * Everything asserted here is a pure function over a project directory, which is the reason the
 * screen was split this way in the first place: the full-screen loop needs a real terminal and cannot
 * be tested without a pty, but what it says about a project can be, and that is the part that can be
 * wrong in a way a user would notice. The flat menu needs no terminal, so it is driven end to end.
 *
 * The rule the whole file is really guarding is at the bottom: the API key never reaches the screen.
 * The provider's name and the file it lives in are the most that may be shown.
 */

/** @type {string[]} */
const roots = [];

/**
 * @param {Record<string, string>} [files]
 * @returns {string}
 */
function project(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'opengeo-home-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return root;
}

const CONFIG = JSON.stringify({ site: 'https://example.com', webRoot: 'public' });

/**
 * @param {number} pages
 * @returns {string}
 */
function manifest(pages, generatedAt = new Date().toISOString()) {
  /** @type {Record<string, unknown>} */
  const entries = {};
  for (let index = 0; index < pages; index += 1) {
    entries[`/page-${index}`] = {
      route: `/page-${index}`,
      url: `https://example.com/page-${index}`,
      title: `Page ${index}`,
      file: `md/page-${index}.md`,
      tokens: 100,
      wordCount: 80,
      lastUpdated: generatedAt,
    };
  }
  return JSON.stringify({ version: 1, specVersion: '0.1', site: 'https://example.com', generatedAt, pages: entries });
}

/**
 * @param {Array<Record<string, unknown>>} entries
 * @returns {string}
 */
function history(entries) {
  return JSON.stringify({ version: 1, entries });
}

const NOW = new Date().toISOString();
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

/** @type {CommandHandler} */
const noop = async () => 0;
/** @type {Partial<Record<CommandName, CommandHandler>>} */
const ALL = {
  test: noop,
  generate: noop,
  'prod test': noop,
  settings: noop,
  start: noop,
};

/** @param {string[]} lines */
const text = (lines) => stripAnsi(lines.join('\n'));

afterEach(() => {
  roots.length = 0;
});

describe('reading a project', () => {
  it('reports an empty directory as unconfigured rather than throwing', () => {
    const root = project();
    const status = readHomeStatus(root);

    expect(status.configured).toBe(false);
    expect(status.project).toBe(basename(root));
    expect(status.site).toBeUndefined();
    expect(status.twins).toBe(0);
    expect(status.score).toBeUndefined();
  });

  it('picks up the site, the twins and the last score', () => {
    const root = project({
      'opengeo.config.json': CONFIG,
      '.opengeo/manifest.json': manifest(4, HOUR_AGO),
      '.opengeo/history.json': history([
        { at: HOUR_AGO, url: 'https://example.com/', mode: 'structure', score: 61 },
        { at: NOW, url: 'https://example.com/', mode: 'structure', score: 84, suggestions: { adopted: 3, count: 15 } },
      ]),
    });
    const status = readHomeStatus(root);

    expect(status.configured).toBe(true);
    expect(status.site).toBe('https://example.com/');
    expect(status.twins).toBe(4);
    expect(status.score?.value).toBe(84);
    expect(status.score?.delta).toBe(23);
    expect(status.score?.trend).toEqual([61, 84]);
    expect(status.score?.suggestions).toEqual({ adopted: 3, count: 15 });
  });

  it('shows the URL the score was actually taken from, not the one in the config', () => {
    const root = project({
      'opengeo.config.json': CONFIG,
      '.opengeo/history.json': history([{ at: NOW, url: 'http://localhost:3000/', mode: 'structure', score: 40 }]),
    });

    expect(readHomeStatus(root).site).toBe('http://localhost:3000/');
  });

  it('survives a corrupt manifest and a corrupt history', () => {
    const root = project({
      'opengeo.config.json': CONFIG,
      '.opengeo/manifest.json': '{ broken',
      '.opengeo/history.json': 'also broken',
    });
    const status = readHomeStatus(root);

    expect(status.configured).toBe(true);
    expect(status.twins).toBe(0);
    expect(status.score).toBeUndefined();
  });

  it('counts a model on this machine as ready, with no key to find', () => {
    const root = project({ 'opengeo.config.json': JSON.stringify({ site: 'https://example.com', ai: { provider: 'ollama', model: 'llama3.2' } }) });
    const status = readHomeStatus(root);

    expect(status.provider).toEqual({ id: 'ollama', source: 'opengeo.config.json', keyless: true });
    expect(text(statusRows(status, 80))).toContain('runs without a key');
    expect(plainStatus(status).join('\n')).toContain('ollama, no key needed');
  });

  it('counts no twins when generate has never run', () => {
    const root = project({ 'opengeo.config.json': CONFIG });
    const status = readHomeStatus(root);

    expect(status.twins).toBe(0);
    expect(status.generatedAt).toBeUndefined();
  });
});

describe('the status rows', () => {
  /**
   * @param {Partial<HomeStatus>} [over]
   * @returns {HomeStatus}
   */
  const configured = (over = {}) => ({
    project: 'demo',
    root: '/tmp/demo',
    configured: true,
    site: 'https://example.com/',
    twins: 0,
    ...over,
  });

  it('tells an unconfigured project what to press', () => {
    const rows = text(statusRows(configured({ configured: false }), 80));

    expect(rows).toContain('not configured');
    expect(rows).toContain('press s');
  });

  it('draws the score, the delta and the age together', () => {
    const rows = text(statusRows(configured({ score: { value: 84, at: HOUR_AGO, delta: 23, trend: [61, 84] } }), 100));

    expect(rows).toContain('84');
    expect(rows).toContain('+23');
    expect(rows).toContain('1h ago');
  });

  it('shows a drop as a negative rather than hiding it', () => {
    const rows = text(statusRows(configured({ score: { value: 61, at: NOW, delta: -23, trend: [84, 61] } }), 100));

    expect(rows).toContain('-23');
  });

  it('says never tested rather than showing a zero', () => {
    const rows = text(statusRows(configured(), 80));

    expect(rows).toContain('never tested');
    expect(rows).not.toMatch(/\b0\/100\b/);
  });

  it('counts one page as a page and two as pages', () => {
    expect(text(statusRows(configured({ twins: 1, generatedAt: NOW }), 80))).toContain('1 page ');
    expect(text(statusRows(configured({ twins: 6, generatedAt: NOW }), 80))).toContain('6 pages');
  });

  it('names the provider and where the key lives, and never the key', () => {
    const rows = text(statusRows(configured({ provider: { id: 'anthropic', source: '.env' } }), 80));

    expect(rows).toContain('anthropic');
    expect(rows).toContain('from .env');
    expect(rows).not.toMatch(/sk-|\*{4}/);
  });

  it('calls a missing key optional, because most of the product does not need one', () => {
    expect(text(statusRows(configured(), 80))).toContain('optional');
  });

  it('never draws wider than it was given', () => {
    const wide = configured({ score: { value: 84, at: NOW, delta: 23, trend: [1, 2, 3, 4] }, provider: { id: 'anthropic', source: '.env' } });
    for (const row of statusRows(wide, 40)) expect(stripAnsi(row).length).toBeLessThanOrEqual(40);
  });
});

describe('the header box', () => {
  /** @type {HomeStatus} */
  const status = {
    project: 'nextjs-demo',
    root: '/tmp/nextjs-demo',
    configured: true,
    site: 'https://example.com/',
    twins: 3,
    generatedAt: HOUR_AGO,
  };

  it('names the project, the site and the version', () => {
    const drawn = text(homeHeader(status, 'opengeo 0.1.0', 80));

    expect(drawn).toContain('nextjs-demo');
    expect(drawn).toContain('https://example.com/');
    expect(drawn).toContain('opengeo 0.1.0');
  });

  it('is a closed box at every width it will be drawn at', () => {
    for (const width of [40, 60, 80, 120, 200]) {
      const lines = homeHeader(status, 'opengeo 0.1.0', width).map(stripAnsi);
      const drawn = lines[0].length;
      expect(drawn).toBeLessThanOrEqual(Math.min(width, 96));
      for (const line of lines) expect(line.length).toBe(drawn);
    }
  });

  it('says so plainly when there is no site yet', () => {
    expect(text(homeHeader({ ...status, configured: false, site: undefined }, 'opengeo 0.1.0', 80))).toContain('no site configured yet');
  });
});

describe('the menu', () => {
  /** @type {HomeStatus} */
  const configured = { project: 'demo', root: '/tmp/demo', configured: true, twins: 0 };
  /** @type {HomeStatus} */
  const fresh = { project: 'demo', root: '/tmp/demo', configured: false, twins: 0 };

  it('offers every command a full install ships', () => {
    const values = homeEntries(ALL, configured).map((entry) => entry.value);

    expect(values).toEqual(['test', 'generate', 'prod', 'dashboard', 'settings', 'quit']);
    expect(homeEntries(ALL, configured).every((entry) => !entry.disabled)).toBe(true);
  });

  it('puts setup first on a directory that has never been configured', () => {
    expect(homeEntries(ALL, fresh)[0]?.value).toBe('setup');
  });

  it('dims what this install does not ship rather than hiding it', () => {
    const narrow = homeEntries({ test: noop }, configured);
    const byValue = new Map(narrow.map((entry) => [entry.value, entry]));

    expect(byValue.get('test')?.disabled).toBeFalsy();
    expect(byValue.get('generate')?.disabled).toBe(true);
    expect(byValue.get('dashboard')?.disabled).toBe(true);
    expect(byValue.get('quit')?.disabled).toBeFalsy();
  });

  it('always offers a way out', () => {
    expect(homeEntries({}, configured).at(-1)?.value).toBe('quit');
  });

  it('gives every entry a note saying what it does', () => {
    for (const entry of homeEntries(ALL, configured)) {
      if (entry.value === 'quit') continue;
      expect(entry.note && entry.note.length).toBeGreaterThan(4);
    }
  });
});

describe('the flat menu, for terminals that cannot do any of this', () => {
  it('says the same three things with no escape codes at all', () => {
    const rows = plainStatus({
      project: 'demo',
      root: '/tmp/demo',
      configured: true,
      twins: 3,
      score: { value: 84, at: NOW, trend: [] },
      provider: { id: 'groq', source: '.env' },
    });

    expect(rows.join('\n')).toBe(stripAnsi(rows.join('\n')));
    expect(rows.join('\n')).toContain('84/100');
    expect(rows.join('\n')).toContain('3 pages');
    expect(rows.join('\n')).toContain('groq');
    expect(rows.join('\n')).not.toContain('ideas');
  });

  it('counts the suggestions on a line of their own once a run has measured them', () => {
    const rows = plainStatus({
      project: 'demo',
      root: '/tmp/demo',
      configured: true,
      twins: 0,
      score: { value: 100, at: NOW, trend: [], suggestions: { adopted: 3, count: 15 } },
    });
    expect(rows).toContain('  ideas    3 of 15 suggestions adopted');
    expect(rows[0]).toContain('100/100');
  });

  it('has one line for an unconfigured directory', () => {
    expect(plainStatus({ project: 'demo', root: '/tmp/demo', configured: false, twins: 0 })).toEqual(['  not configured yet']);
  });
});

/**
 * The flat menu, driven as a person would drive it.
 *
 * The menu's own readline and the command it launches share one stdin. If the menu's is still
 * attached while `settings` asks for a key, it echoes every keystroke the masked prompt is hiding,
 * and a Ctrl-D meant for the command closes the menu's reader too.
 */
describe('the flat menu hands stdin to the command it runs', () => {
  // A real terminal on both ends, with colour switched off: the case the flat menu exists for.
  /** @type {string | undefined} */
  let noColor;
  beforeEach(() => {
    noColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
  });
  afterEach(() => {
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  });

  function terminal() {
    const input = /** @type {NodeJS.ReadStream} */ (/** @type {unknown} */ (Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input })));
    const output = /** @type {NodeJS.WriteStream} */ (/** @type {unknown} */ (Object.assign(new PassThrough(), { isTTY: true, columns: 100 })));
    let seen = '';
    output.on('data', (/** @type {Buffer} */ chunk) => {
      seen += chunk.toString();
    });
    const shown = () => stripAnsi(seen);
    /** @param {string} needle */
    const count = (needle) => shown().split(needle).length - 1;
    /** @param {string} needle */
    const waitFor = async (needle, times = 1) => {
      for (let tries = 0; count(needle) < times; tries += 1) {
        if (tries > 200) throw new Error(`never saw ${JSON.stringify(needle)} x${times}:\n${shown()}`);
        await new Promise((done) => setTimeout(done, 5));
      }
    };
    /** @param {string} label */
    const numberOf = (label) => new RegExp(`(\\d+)\\) ${label}`).exec(shown())?.[1] ?? '';
    return { input, output, shown, waitFor, numberOf };
  }

  /** @param {string} answer */
  async function drive(answer) {
    const term = terminal();
    /** @type {CommandHandler} */
    const settings = async () => {
      const prompter = createPrompter({ input: term.input, output: term.output });
      await prompter.secret('API key:');
      prompter.close();
      return 0;
    };
    const done = runHome({ packageName: 'opengeo', version: '0.0.0', commands: { settings }, root: project(), input: term.input, output: term.output });

    await term.waitFor('choose a number');
    term.input.write(`${term.numberOf('Settings')}\n`);
    await term.waitFor('API key:');
    term.input.write(answer);
    await term.waitFor('choose a number', 2);
    term.input.write(`${term.numberOf('Quit')}\n`);
    return { code: await done, shown: term.shown() };
  }

  it('shows nothing of a key but the asterisks', async () => {
    const { code, shown } = await drive('sk-ECHO\n');
    expect(code).toBe(0);
    const typed = shown.slice(shown.indexOf('API key:') + 'API key:'.length).split('\n')[0];
    expect(typed).toMatch(/^[\s*]*$/);
  });

  it('comes back to the menu after a Ctrl-D inside the command', async () => {
    const { code } = await drive('\u0004');
    expect(code).toBe(0);
  });
});

describe('the flat menu and a pipe', () => {
  it('prints nothing and hands back to the help page when stdout is not a terminal', async () => {
    const input = /** @type {NodeJS.ReadStream} */ (/** @type {unknown} */ (Object.assign(new PassThrough(), { isTTY: true })));
    const output = /** @type {NodeJS.WriteStream} */ (/** @type {unknown} */ (Object.assign(new PassThrough(), { isTTY: false })));
    let seen = '';
    output.on('data', (/** @type {Buffer} */ chunk) => {
      seen += chunk.toString();
    });

    const code = await runHome({ packageName: 'opengeo', version: '0.0.0', commands: ALL, root: project(), input, output });

    expect(code).toBe(-1);
    expect(seen).toBe('');
  });
});

describe('the full-screen menu after a command', () => {
  /** @type {NodeJS.ProcessEnv} */
  let saved;
  beforeEach(() => {
    saved = { ...process.env };
    process.env.FORCE_COLOR = '1';
    // The gate closes on any CI variable or OPENGEO_NO_TUI, and a runner sets several, so the suite
    // would test nothing there.
    for (const name of CI_VARIABLES) delete process.env[name];
    delete process.env.OPENGEO_NO_TUI;
  });
  afterEach(() => {
    process.env = saved;
  });

  it('quits cleanly when the input ends at the go-back prompt, rather than hanging', async () => {
    const input = /** @type {NodeJS.ReadStream} */ (
      /** @type {unknown} */ (Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: (/** @type {boolean} */ on) => ((input.isRaw = on), input) }))
    );
    const output = /** @type {NodeJS.WriteStream} */ (/** @type {unknown} */ (Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 })));
    let seen = '';
    output.on('data', (/** @type {Buffer} */ chunk) => {
      seen += chunk.toString();
    });
    /** @param {string} needle */
    const waitFor = async (needle) => {
      for (let tries = 0; !stripAnsi(seen).includes(needle); tries += 1) {
        if (tries > 200) throw new Error(`never saw ${JSON.stringify(needle)}`);
        await new Promise((done) => setTimeout(done, 5));
      }
    };
    let ran = 0;
    /** @type {CommandHandler} */
    const prod = async () => {
      ran += 1;
      return 0;
    };

    const done = runHome({ packageName: 'opengeo', version: '0.0.0', commands: { 'prod test': prod }, root: project({ 'opengeo.config.json': CONFIG }), input, output });
    await waitFor('Prod check');
    input.write('p');
    await waitFor('URL');
    input.write('\r');
    await waitFor('Press Enter');
    input.end();

    expect(await done).toBe(0);
    expect(ran).toBe(1);
  });

  it('redraws the menu at the new width when the terminal is resized', async () => {
    const input = /** @type {NodeJS.ReadStream} */ (
      /** @type {unknown} */ (Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: (/** @type {boolean} */ on) => ((input.isRaw = on), input) }))
    );
    const output = /** @type {NodeJS.WriteStream} */ (/** @type {unknown} */ (Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 })));
    let seen = '';
    output.on('data', (/** @type {Buffer} */ chunk) => {
      seen += chunk.toString();
    });
    /** @param {(text: string) => boolean} test */
    const waitUntil = async (test) => {
      for (let tries = 0; !test(seen); tries += 1) {
        if (tries > 200) throw new Error('the screen never got there');
        await new Promise((done) => setTimeout(done, 5));
      }
    };
    /** The width of the box the header is drawn in, in the most recent frame. */
    const boxWidth = () => {
      const top = stripAnsi(seen.slice(seen.lastIndexOf('\x1b[H')))
        .split('\n')
        // The corner the painter is using: a Windows console without Windows Terminal gets ASCII.
        .find((line) => line.startsWith(glyphs().topLeft));
      return visibleWidth(top ?? '');
    };

    const done = runHome({ packageName: 'opengeo', version: '0.0.0', commands: { test: async () => 0 }, root: project({ 'opengeo.config.json': CONFIG }), input, output });
    await waitUntil((text) => stripAnsi(text).includes('Quit'));
    expect(boxWidth()).toBeGreaterThan(50);

    const before = seen.length;
    Object.assign(output, { columns: 50 });
    output.emit('resize');
    await waitUntil((text) => text.length > before && stripAnsi(text.slice(before)).includes('Quit'));
    expect(boxWidth()).toBe(50);

    input.write('q');
    expect(await done).toBe(0);
  });
});
