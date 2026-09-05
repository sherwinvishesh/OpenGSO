import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHECKS } from '../src/test/checks.js';
import { AI_BOTS } from '../src/shared/bots.js';
import { AEO_SPEC_VERSION, HEADERS, MARKDOWN_CONTENT_TYPE } from '../src/shared/version.js';
import { NOT_ACCEPTABLE_BODY } from '../src/prod/headers.js';
import { routeToTwinUrlPath } from '../src/shared/routes.js';

/**
 * Documentation that describes behaviour is documentation that can be wrong. These tests are the
 * cheapest possible defence: they do not check that the prose is good, only that every fact it
 * states in a table still matches the code it describes.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

describe('docs/checks.md', () => {
  const doc = read('docs/checks.md');

  it('documents every check, with a heading of its own', () => {
    for (const check of CHECKS) {
      expect(doc, `${check.id} has no "### ${check.id} - ..." heading`).toContain(`### ${check.id} - `);
    }
  });

  it('states the right weight and importance for every check', () => {
    for (const check of CHECKS) {
      const section = doc.split(`### ${check.id} - `)[1] ?? '';
      const claim = section.split('\n').find((line) => line.startsWith('**Required') || line.startsWith('**Recommended'));
      expect(claim, `${check.id} does not state its importance and weight`).toBeDefined();
      const expected = `**${check.importance === 'required' ? 'Required' : 'Recommended'}, weight ${check.weight}.**`;
      expect(claim, `${check.id} claims "${claim}"`).toBe(expected);
    }
  });

  it('has a weight table that adds up to the real totals', () => {
    const sum = (predicate: (c: (typeof CHECKS)[number]) => boolean) =>
      CHECKS.filter(predicate).reduce((total, c) => total + c.weight, 0);
    const a = { required: sum((c) => c.category === 'A' && c.importance === 'required'), recommended: sum((c) => c.category === 'A' && c.importance === 'recommended') };
    const b = { required: sum((c) => c.category === 'B' && c.importance === 'required'), recommended: sum((c) => c.category === 'B' && c.importance === 'recommended') };

    expect(doc).toContain(`| **A. Discoverability** | ${a.required} | ${a.recommended} | ${a.required + a.recommended} |`);
    expect(doc).toContain(`| **B. Implementation** | ${b.required} | ${b.recommended} | ${b.required + b.recommended} |`);
    expect(doc).toContain(`| **Total** | ${a.required + b.required} | ${a.recommended + b.recommended} | ${a.required + a.recommended + b.required + b.recommended} |`);
  });

  it('counts the checks correctly in its own opening line', () => {
    expect(doc).toContain(`runs ${CHECKS.length} checks against a live URL`);
  });

  it('never invents a check id that does not exist', () => {
    const ids = new Set(CHECKS.map((c) => c.id));
    for (const [, id] of doc.matchAll(/^### ([AB]\d+) - /gm)) {
      expect(ids.has(id!), `docs/checks.md documents "${id}", which is not a real check`).toBe(true);
    }
  });
});

describe('docs/spec.md', () => {
  const doc = read('docs/spec.md');

  it('quotes the version string the code actually sends', () => {
    expect(doc).toContain(`${HEADERS.aeoVersion}: ${AEO_SPEC_VERSION}`);
  });

  it('quotes the markdown content type exactly', () => {
    expect(doc).toContain(MARKDOWN_CONTENT_TYPE);
  });

  it('names every header the runtime actually sets', () => {
    for (const header of Object.values(HEADERS)) {
      expect(doc, `spec.md never mentions ${header}`).toContain(header);
    }
  });

  it('reproduces the 406 body verbatim', () => {
    expect(doc).toContain(NOT_ACCEPTABLE_BODY);
  });

  it('gets its own twin URL examples right', () => {
    // Every "| `/x` | `/x.md` |" row in the table is checked against the real mapping.
    const rows = [...doc.matchAll(/^\| `(\/[^`]*)` \| `([^`]+)`/gm)];
    expect(rows.length).toBeGreaterThan(3);
    for (const [, route, twin] of rows) {
      expect(routeToTwinUrlPath(route!), `spec.md maps ${route} to ${twin}`).toBe(twin);
    }
  });
});

describe('the bot list is the documented contribution surface (§17)', () => {
  it('is one file, and the docs point at it', () => {
    const source = read('packages/core/src/shared/bots.ts');
    expect(source).toContain('contribution');
    expect(AI_BOTS.length).toBeGreaterThan(20);
  });
});
