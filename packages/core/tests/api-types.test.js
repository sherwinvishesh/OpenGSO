import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `shared/api-types.js` is what the browser dashboard type-checks against, with no Node types
 * installed. One `@import` of a module that reads a file would drag `@types/node` and jsdom into
 * the browser project, and it would still compile, quietly, against types a browser does not have.
 * So the rule is checked here rather than trusted: nothing reachable from that file may name Node,
 * jsdom, or any package at all.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const ENTRY = resolve(SRC, 'shared/api-types.js');

/**
 * Every module specifier in a file: value imports, JSDoc `@import`s and `import('...')` types.
 *
 * @param {string} text
 * @returns {string[]}
 */
function specifiers(text) {
  const found = [];
  for (const match of text.matchAll(/(?:^|\s)(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) found.push(match[1]);
  for (const match of text.matchAll(/@import\s[\s\S]*?from\s*['"]([^'"]+)['"]/g)) found.push(match[1]);
  for (const match of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(match[1]);
  return found;
}

/** @returns {Map<string, string[]>} every reachable file and the specifiers it names */
function closure() {
  /** @type {Map<string, string[]>} */
  const seen = new Map();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.pop());
    if (seen.has(file)) continue;
    const named = specifiers(readFileSync(file, 'utf8'));
    seen.set(file, named);
    for (const specifier of named) if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier));
  }
  return seen;
}

describe('the API types module', () => {
  it('reaches nothing that needs Node, jsdom or a package', () => {
    const offenders = [...closure()].flatMap(([file, named]) =>
      named.filter((specifier) => !specifier.startsWith('.')).map((specifier) => `${file.slice(SRC.length + 1)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it('really does follow imports, so an empty pass means something', () => {
    expect([...closure().keys()].map((file) => file.slice(SRC.length + 1))).toEqual(
      expect.arrayContaining(['shared/api-types.js', 'shared/providers.js', 'test/checks.js']),
    );
  });

  it('is types only', () => {
    const code = readFileSync(ENTRY, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .trim();
    expect(code).toBe('export {};');
  });
});
