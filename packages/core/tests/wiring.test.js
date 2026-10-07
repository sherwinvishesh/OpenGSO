import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMAND_PACKAGES, NARROWEST_PACKAGE } from '../src/shared/errors.js';

/**
 * Adding an export to core takes three places: core's `exports`, the matching `paths` entry in
 * `tsconfig.base.json`, and the consuming package's entry file. Each of the three can drift alone
 * and nothing else notices until a declaration build or a user's import breaks, so this compares
 * them against each other. The command table that names which package ships which command is held
 * to what each package's entry actually wires up, for the same reason.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** @param {string} relative */
const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');
/** @param {string} relative */
const readJson = (relative) => JSON.parse(read(relative));

const coreExports = /** @type {Record<string, string>} */ (readJson('packages/core/package.json').exports);
const paths = /** @type {Record<string, string[]> | undefined} */ (readJson('tsconfig.base.json').compilerOptions.paths);

/** `./src/x.js` in core's exports, as a path from the repo root. */
const coreTarget = (/** @type {string} */ target) => join('packages/core', target).replace(/\\/g, '/');
const strip = (/** @type {string} */ path) => path.replace(/^\.\//, '');

/**
 * The file a `@opengeo/core...` specifier resolves to through core's exports, or nothing.
 *
 * @param {string} specifier
 * @returns {string | undefined}
 */
function resolveCore(specifier) {
  const subpath = `.${specifier.slice('@opengeo/core'.length)}`;
  if (coreExports[subpath]) return coreTarget(coreExports[subpath]);
  for (const [key, target] of Object.entries(coreExports)) {
    if (!key.includes('*')) continue;
    const [before, after] = key.split('*');
    if (subpath.startsWith(before) && subpath.endsWith(after)) {
      const match = subpath.slice(before.length, subpath.length - after.length);
      return coreTarget(target.replace('*', match));
    }
  }
  return undefined;
}

const PACKAGE_DIRS = readdirSync(join(repoRoot, 'packages')).filter(
  (dir) => dir !== 'core' && existsSync(join(repoRoot, 'packages', dir, 'package.json')),
);

/** Every entry file of every published package, with the core specifiers it imports. */
const entries = PACKAGE_DIRS.flatMap((dir) =>
  readdirSync(join(repoRoot, 'packages', dir, 'src'))
    .filter((file) => file.endsWith('.js'))
    .map((file) => {
      const source = read(`packages/${dir}/src/${file}`);
      return {
        dir,
        name: /** @type {string} */ (readJson(`packages/${dir}/package.json`).name),
        file: `packages/${dir}/src/${file}`,
        source,
        specifiers: [...source.matchAll(/from '(@opengeo\/core[^']*)'/g)].map(([, specifier]) => specifier),
      };
    }),
);

describe("core's exports, tsconfig paths and the package entries agree", () => {
  it('points every core export at a file that exists', () => {
    for (const [subpath, target] of Object.entries(coreExports)) {
      if (subpath.includes('*')) {
        expect(existsSync(join(repoRoot, dirname(coreTarget(target)))), `${subpath} -> ${target}`).toBe(true);
      } else {
        expect(existsSync(join(repoRoot, coreTarget(target))), `${subpath} -> ${target}`).toBe(true);
      }
    }
  });

  it('gives every core export a tsconfig paths entry naming the same file, and no other entries', () => {
    // tsc resolves core through the workspace without `paths`, but tsup's declaration build does
    // not, so a missing entry only shows up as a published .d.ts importing @opengeo/core.
    if (!paths) return;
    const expected = Object.fromEntries(
      Object.entries(coreExports).map(([subpath, target]) => [`@opengeo/core${subpath.slice(1)}`, `./${coreTarget(target)}`]),
    );
    const coreKeys = Object.keys(paths).filter((key) => key.startsWith('@opengeo/core'));
    expect(coreKeys.sort()).toEqual(Object.keys(expected).sort());
    for (const [key, target] of Object.entries(expected)) {
      expect(paths[key], `tsconfig.base.json paths["${key}"]`).toEqual([target]);
    }
  });

  it('only imports core subpaths that core exports, from every package entry', () => {
    let imported = 0;
    for (const entry of entries) {
      for (const specifier of entry.specifiers) {
        imported += 1;
        const file = resolveCore(specifier);
        expect(file, `${entry.file} imports ${specifier}, which core does not export`).toBeDefined();
        expect(existsSync(join(repoRoot, /** @type {string} */ (file))), `${specifier} resolves to ${file}, which is missing`).toBe(true);
      }
    }
    expect(imported).toBeGreaterThan(10);
  });

  it("builds every package's exports from an entry file that imports core", () => {
    // A subpath a package publishes has to come from somewhere: its entry re-exports core, or it is
    // a second implementation, which is the one thing the layout exists to prevent.
    for (const dir of PACKAGE_DIRS) {
      const pkg = readJson(`packages/${dir}/package.json`);
      const tsup = read(`packages/${dir}/tsup.config.js`);
      for (const entry of entries.filter((e) => e.dir === dir)) {
        expect(tsup, `${entry.file} is not a tsup entry`).toContain(entry.file.slice(`packages/${dir}/`.length));
        expect(entry.specifiers.length, `${entry.file} imports nothing from core`).toBeGreaterThan(0);
      }
      for (const [subpath, conditions] of Object.entries(pkg.exports ?? {})) {
        const built = String(/** @type {Record<string, string>} */ (conditions).import).replace(/^\.\/dist\//, '');
        expect(
          entries.some((e) => e.dir === dir && e.file.endsWith(`/src/${built}`)),
          `${pkg.name} exports ${subpath} from dist/${built}, which no src entry builds`,
        ).toBe(true);
      }
    }
  });
});

describe('COMMAND_PACKAGES matches what each package wires up', () => {
  /**
   * The commands a package's CLI entry hands to `main`, each checked against the module it came
   * from, so `test: generateCommand` would not pass as `test`.
   *
   * @param {(typeof entries)[number]} entry
   * @returns {string[]}
   */
  function wiredCommands(entry) {
    const block = entry.source.match(/commands:\s*\{([^}]*)\}/)?.[1];
    if (block === undefined) return [];
    /** @type {Record<string, string>} */
    const importedFrom = Object.fromEntries(
      [...entry.source.matchAll(/import \{ (\w+) \} from '@opengeo\/core\/cli\/commands\/([\w-]+)'/g)].map(
        ([, name, module]) => [name, module],
      ),
    );
    return [...block.matchAll(/(?:'([^']+)'|(\w+)):\s*(\w+)/g)].map(([, quoted, bare, value]) => {
      const command = quoted ?? bare;
      expect(importedFrom[value], `${entry.file} wires ${command} to ${value}`).toBe(command.replace(' ', '-'));
      return command;
    });
  }

  const cliEntries = entries.filter((entry) => entry.file.endsWith('/src/cli.js'));

  it('finds a CLI entry for every published package', () => {
    expect(cliEntries.map((entry) => entry.dir).sort()).toEqual([...PACKAGE_DIRS].sort());
  });

  it('lists exactly the packages whose entry wires each command', () => {
    /** @type {Record<string, string[]>} */
    const actual = {};
    for (const entry of cliEntries) {
      for (const command of wiredCommands(entry)) (actual[command] ??= []).push(entry.name);
    }
    expect(Object.keys(actual).sort()).toEqual(Object.keys(COMMAND_PACKAGES).sort());
    for (const [command, packages] of Object.entries(COMMAND_PACKAGES)) {
      expect([...packages].sort(), `COMMAND_PACKAGES['${command}']`).toEqual(actual[command].sort());
    }
  });

  it('names a narrowest package that really ships the command', () => {
    for (const [command, pkg] of Object.entries(NARROWEST_PACKAGE)) {
      expect(COMMAND_PACKAGES[/** @type {keyof typeof COMMAND_PACKAGES} */ (command)]).toContain(pkg);
    }
  });
});
