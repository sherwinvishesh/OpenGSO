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

  it('stops parsing at --', () => {
    const args = parseArgs(['test', '--', '--not-mine'], SPEC);
    expect(args.positionals).toEqual(['test']);
    expect(args.rest).toEqual(['--not-mine']);
  });

  it('parses numbers when asked, and undefined when the value is not one', () => {
    const args = parseArgs(['--tier=3'], SPEC);
    expect(args.num('tier')).toBe(3);
    expect(parseArgs(['--tier=x'], SPEC).num('tier')).toBeUndefined();
  });
});
