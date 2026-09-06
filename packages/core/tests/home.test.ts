import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandHandler } from '@opengeo/core/cli';
import type { CommandName } from '@opengeo/core/shared';
import type { HomeStatus } from '../src/cli/home.js';
import { homeEntries, homeHeader, plainStatus, readHomeStatus, statusRows } from '../src/cli/home.js';
import { stripAnsi } from '../src/cli/tui/paint.js';

/**
 * The home screen, read as text.
 *
 * Everything asserted here is a pure function over a project directory, which is the reason the
 * screen was split this way in the first place: the loop needs a real terminal and cannot be tested
 * without a pty, but what it says about a project can be, and that is the part that can be wrong in
 * a way a user would notice.
 *
 * The rule the whole file is really guarding is at the bottom: the API key never reaches the screen.
 * The provider's name and the file it lives in are the most that may be shown.
 */

const roots: string[] = [];

function project(files: Record<string, string> = {}): string {
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

function manifest(pages: number, generatedAt = new Date().toISOString()): string {
  const entries: Record<string, unknown> = {};
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

function history(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({ version: 1, entries });
}

const NOW = new Date().toISOString();
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

const noop: CommandHandler = async () => 0;
const ALL: Partial<Record<CommandName, CommandHandler>> = {
  test: noop,
  generate: noop,
  'prod test': noop,
  settings: noop,
  start: noop,
};

const text = (lines: string[]) => stripAnsi(lines.join('\n'));

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
        { at: NOW, url: 'https://example.com/', mode: 'structure', score: 84, lockedPoints: 0 },
      ]),
    });
    const status = readHomeStatus(root);

    expect(status.configured).toBe(true);
    expect(status.site).toBe('https://example.com/');
    expect(status.twins).toBe(4);
    expect(status.score?.value).toBe(84);
    expect(status.score?.delta).toBe(23);
    expect(status.score?.trend).toEqual([61, 84]);
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

  it('counts no twins when generate has never run', () => {
    const root = project({ 'opengeo.config.json': CONFIG });
    const status = readHomeStatus(root);

    expect(status.twins).toBe(0);
    expect(status.generatedAt).toBeUndefined();
  });
});

describe('the status rows', () => {
  const configured = (over: Partial<HomeStatus> = {}): HomeStatus => ({
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
  const status: HomeStatus = {
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
      const drawn = lines[0]!.length;
      expect(drawn).toBeLessThanOrEqual(Math.min(width, 96));
      for (const line of lines) expect(line.length).toBe(drawn);
    }
  });

  it('says so plainly when there is no site yet', () => {
    expect(text(homeHeader({ ...status, configured: false, site: undefined }, 'opengeo 0.1.0', 80))).toContain('no site configured yet');
  });
});

describe('the menu', () => {
  const configured: HomeStatus = { project: 'demo', root: '/tmp/demo', configured: true, twins: 0 };
  const fresh: HomeStatus = { project: 'demo', root: '/tmp/demo', configured: false, twins: 0 };

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
  });

  it('has one line for an unconfigured directory', () => {
    expect(plainStatus({ project: 'demo', root: '/tmp/demo', configured: false, twins: 0 })).toEqual(['  not configured yet']);
  });
});
