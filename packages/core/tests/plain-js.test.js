import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The source is the program. Vitest loads it through Vite and every published CLI is a bundle, so
 * neither would notice a module that only works once esbuild has been over it: a missing extension,
 * a directory import, a build-time constant. Running each entry with plain `node` is what does.
 */

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACKAGES = ['testing', 'generate', 'prod', 'cli', 'opengso'];

describe('every entry file runs from source with plain node', () => {
  for (const dir of PACKAGES) {
    const entry = join(repo, 'packages', dir, 'src/cli.js');
    const pkg = /** @type {{ name: string; version: string }} */ (
      JSON.parse(readFileSync(join(repo, 'packages', dir, 'package.json'), 'utf8'))
    );
    /** @param {string} flag */
    const run = (flag) => spawnSync(process.execPath, [entry, flag], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

    it(`${pkg.name} --version`, () => {
      const result = run('--version');
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(`${pkg.name} ${pkg.version}`);
    });

    it(`${pkg.name} --help`, () => {
      const result = run('--help');
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`OpenGSO ${pkg.name} ${pkg.version}`);
    });
  }
});

describe('no TypeScript source is tracked', () => {
  it('outside the dashboard and the examples', () => {
    const tracked = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mts', '*.cts'], { cwd: repo, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      // The dashboard is rewritten in plain JavaScript separately, and examples/ stays TypeScript
      // on purpose: it shows a TypeScript user what wiring OpenGSO into their app looks like.
      .filter((path) => !path.startsWith('packages/opengso/web/') && !path.startsWith('examples/'));
    expect(tracked).toEqual([]);
  });
});
