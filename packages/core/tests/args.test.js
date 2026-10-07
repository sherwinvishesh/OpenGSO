import { describe, expect, it } from 'vitest';
import { parseArgs } from '@opengeo/core/cli';

const SPEC = /** @type {const} */ ({ booleans: ['json', 'force'], strings: ['project', 'tier'], alias: { p: 'project' } });

describe('parseArgs', () => {
  it('separates positionals from options', () => {
    const args = parseArgs(['http://localhost:3000', '--json'], SPEC);
    expect(args.positionals).toEqual(['http://localhost:3000']);
    expect(args.bool('json')).toBe(true);
  });

  it('accepts both --key value and --key=value', () => {
    expect(parseArgs(['--tier', 'ai'], SPEC).str('tier')).toBe('ai');
    expect(parseArgs(['--tier=ai'], SPEC).str('tier')).toBe('ai');
  });

  it('does not swallow the next positional as a boolean flag value', () => {
    const args = parseArgs(['--force', 'http://localhost:3000'], SPEC);
    expect(args.bool('force')).toBe(true);
    expect(args.positionals).toEqual(['http://localhost:3000']);
  });

  it('resolves short aliases to their long names', () => {
    expect(parseArgs(['-p', './site'], SPEC).str('project')).toBe('./site');
  });

  it('reports options the command never declared', () => {
    expect(parseArgs(['--jsno'], SPEC).unknown()).toEqual(['jsno']);
    expect(parseArgs(['--json'], SPEC).unknown()).toEqual([]);
  });

  it('records a value-taking option given no value, so the command can complain specifically', () => {
    const args = parseArgs(['--tier'], SPEC);
    expect(args.has('tier')).toBe(true);
    expect(args.str('tier')).toBe('');
  });

  it('stops parsing at --, and keeps what follows as positionals', () => {
    const args = parseArgs(['test', '--', '--not-mine'], SPEC);
    expect(args.positionals).toEqual(['test', '--not-mine']);
    expect(args.rest).toEqual(['--not-mine']);
    expect(args.unknown()).toEqual([]);
  });

  it('parses numbers when asked, and undefined when the value is not one', () => {
    const args = parseArgs(['--tier=3'], SPEC);
    expect(args.num('tier')).toBe(3);
    expect(parseArgs(['--tier=x'], SPEC).num('tier')).toBeUndefined();
  });
});

describe('usage problems', () => {
  const NUMERIC = /** @type {const} */ ({
    booleans: ['json'],
    strings: ['project'],
    numbers: { port: { min: 1, max: 65535, integer: true }, timeout: { min: 0, exclusive: true } },
    alias: { p: 'port' },
  });

  it('has nothing to say about a valid command line', () => {
    expect(parseArgs(['--port', '8080', '--timeout=2.5', '--json'], NUMERIC).problem()).toBeUndefined();
    expect(parseArgs(['--port', '8080'], NUMERIC).num('port')).toBe(8080);
  });

  it('refuses a value-taking option given no value, rather than reading it as 0', () => {
    const args = parseArgs(['--port'], NUMERIC);
    expect(args.problem()).toContain('--port');
    expect(args.num('port')).toBeUndefined();
    expect(parseArgs(['--project'], NUMERIC).problem()).toContain('--project');
    expect(parseArgs(['-p', '--json'], NUMERIC).problem()).toContain('--port');
  });

  it('refuses a number that is not one, instead of silently using the default', () => {
    expect(parseArgs(['--port', 'abc'], NUMERIC).problem()).toContain('"abc"');
    expect(parseArgs(['--port=0x50'], NUMERIC).problem()).toContain('"0x50"');
    expect(parseArgs(['--port='], NUMERIC).problem()).toContain('--port');
  });

  it('refuses a number outside the range the option means', () => {
    expect(parseArgs(['--port', '70000'], NUMERIC).problem()).toContain('65535');
    expect(parseArgs(['--port', '0'], NUMERIC).problem()).toContain('--port');
    expect(parseArgs(['--port', '80.5'], NUMERIC).problem()).toContain('--port');
    expect(parseArgs(['--timeout', '0'], NUMERIC).problem()).toContain('--timeout');
  });

  it('names options the command never declared', () => {
    expect(parseArgs(['--jsno'], NUMERIC).problem()).toBe('Unknown option: --jsno');
    expect(parseArgs(['--a', '--b'], NUMERIC).problem()).toBe('Unknown options: --a, --b');
  });
});
