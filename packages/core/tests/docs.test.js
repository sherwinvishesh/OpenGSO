import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHECKS } from '../src/test/checks.js';
import {
  SSR_FLOOR_WORDS,
  SSR_MIN_WORDS,
  TTFB_FAST_MS,
  TTFB_SLOW_MS,
  TWIN_FLOOR_RATIO,
  TWIN_FULL_RATIO,
  TWIN_LOCKED_IDS,
} from '../src/test/runner.js';
import { QUALITY_AREAS, QUALITY_TOTAL_WEIGHT } from '../src/test/quality.js';
import { GPTBOT_UA, PROBE_HEADERS } from '../src/test/evidence.js';
import { BROWSER_UA, HOSTILE_ACCEPT, OPENGEO_UA } from '../src/shared/http.js';
import { AI_BOTS } from '../src/shared/bots.js';
import { PROVIDERS } from '../src/shared/providers.js';
import { AEO_SPEC_VERSION, HEADERS, MARKDOWN_CONTENT_TYPE } from '../src/shared/version.js';
import { NOT_ACCEPTABLE_BODY } from '../src/prod/headers.js';
import { routeToTwinUrlPath } from '../src/shared/routes.js';

/**
 * Documentation that describes behaviour is documentation that can be wrong. These tests are the
 * cheapest possible defence: they do not check that the prose is good, only that every fact it
 * states in a table still matches the code it describes.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/**
 * @param {string} relative
 * @returns {string}
 */
const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');

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

  it('states what each content-review area is worth, and totals 100', () => {
    // The second score has weights too, and they are as easy to change and forget as the first
    // score's. Same defence: the table has to say what the code does.
    for (const area of QUALITY_AREAS) {
      expect(doc, `${area.label} is missing its row`).toContain(`| ${area.label} | ${area.weight} |`);
    }
    expect(QUALITY_TOTAL_WEIGHT).toBe(100);
  });

  it('has a weight table that adds up to the real totals', () => {
    /** @param {(c: (typeof CHECKS)[number]) => boolean} predicate */
    const sum = (predicate) =>
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

  /**
   * The prose under `### B7 - ...`, up to the next check heading.
   * @param {string} id
   * @returns {string}
   */
  const section = (id) => (doc.split(`### ${id} - `)[1] ?? '').split('\n### ')[0];

  it('names a partial band for every check that can award one', () => {
    // Derived from the source rather than from a list kept here, because a list kept here is a
    // second place to forget. Any `partial('B6', ...)` in the runner has to have a documented band.
    const runner = read('packages/core/src/test/runner.js');
    const graded = new Set([...runner.matchAll(/partial\(\s*'([AB]\d+)'/g)].map(([, id]) => id));
    expect(graded.size).toBeGreaterThan(0);
    for (const id of graded) {
      expect(section(id), `${id} can return partial and docs/checks.md does not say what that earns`).toContain('**Partial');
    }
  });

  it('does not describe a graded check as all or nothing', () => {
    expect(doc).not.toContain('Partial credit does not exist');
  });

  it('quotes the bands the ramped checks actually use', () => {
    expect(section('A5')).toContain(`from ${SSR_FLOOR_WORDS} up to the ${SSR_MIN_WORDS}`);
    expect(section('A6')).toContain(`**${TTFB_FAST_MS}ms**`);
    expect(section('A6')).toContain(`**${TTFB_SLOW_MS}ms**`);
    expect(section('B3')).toContain(`from ${TWIN_FLOOR_RATIO * 100}% up to ${TWIN_FULL_RATIO * 100}%`);
  });

  it('says how many checks are graded', () => {
    const runner = read('packages/core/src/test/runner.js');
    const graded = new Set([...runner.matchAll(/partial\(\s*'([AB]\d+)'/g)].map(([, id]) => id));
    const words = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen'];
    expect(doc).toContain(`${words[graded.size]} checks are graded rather than binary`);
  });

  it('describes the requests B9, B10 and B11 actually send', () => {
    // How each User-Agent the probes can send is described in prose.
    /** @type {Record<string, string>} */
    const described = { [OPENGEO_UA]: "OpenGEO's own User-Agent", [BROWSER_UA]: 'a browser User-Agent', [GPTBOT_UA]: 'a GPTBot User-Agent' };
    /** @type {Array<[string, Record<string, string>]>} */
    const probes = [
      ['B9', PROBE_HEADERS.acceptMarkdown],
      ['B10', PROBE_HEADERS.botUa],
      ['B11', PROBE_HEADERS.notAcceptable],
    ];
    for (const [id, headers] of probes) {
      expect(section(id), `${id} does not quote the Accept header it sends`).toContain(`\`Accept: ${headers.Accept}\``);
      const ua = headers['User-Agent'];
      if (ua) expect(section(id), `${id} does not say which User-Agent it sends`).toContain(described[ua]);
    }
    // prod test probes the same 406 case, and the two must not ask different questions.
    expect(PROBE_HEADERS.notAcceptable.Accept).toBe(HOSTILE_ACCEPT);
  });

  it('does not call a broken JSON-LD block a failure when A4 scores it as a partial', () => {
    expect(section('A4')).toContain('**Partial: 1** when a block is present but does not parse');
    expect(section('A4')).not.toMatch(/invalid fails/);
  });

  it('prices the locked block with the weights the cascade actually removes', () => {
    /** @param {string} id */
    const weightOf = (id) => CHECKS.find((check) => check.id === id)?.weight ?? 0;
    const points = TWIN_LOCKED_IDS.reduce((total, id) => total + weightOf(id), 0);
    expect(doc).toContain(`Locked (${TWIN_LOCKED_IDS.length})`);
    expect(doc).toContain(`${points} points waiting behind B1`);
    // And the id/weight line under it, in the order the report prints them.
    expect(doc).toContain(TWIN_LOCKED_IDS.map((id) => `${id} ${weightOf(id)}`).join('  '));
  });

  it('never invents a check id that does not exist', () => {
    const ids = new Set(CHECKS.map((c) => c.id));
    for (const [, id] of doc.matchAll(/^### ([AB]\d+) - /gm)) {
      expect(ids.has(id), `docs/checks.md documents "${id}", which is not a real check`).toBe(true);
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
      expect(routeToTwinUrlPath(route), `spec.md maps ${route} to ${twin}`).toBe(twin);
    }
  });
});

describe('the bot list is the documented contribution surface (§17)', () => {
  it('is one file, and the docs point at it', () => {
    const source = read('packages/core/src/shared/bots.js');
    expect(source).toContain('contribution');
    expect(AI_BOTS.length).toBeGreaterThan(20);
  });
});

describe('docs/providers.md', () => {
  const doc = read('docs/providers.md');

  it('lists every provider in the catalogue, by flag value', () => {
    for (const provider of PROVIDERS) {
      expect(doc, `${provider.id} is not in the table`).toContain(`| \`${provider.id}\` |`);
    }
  });

  it('states the real default model and keys URL for each one', () => {
    for (const provider of PROVIDERS) {
      const row = doc.split('\n').find((line) => line.includes(`| \`${provider.id}\` |`)) ?? '';
      if (provider.defaultModel) expect(row, `${provider.id} model`).toContain(provider.defaultModel);
      // A keyless provider has a download link rather than a key page, so the row says so instead.
      if (provider.keysUrl && !provider.keyless) expect(row, `${provider.id} keys URL`).toContain(provider.keysUrl);
    }
  });

  it('names every provider-native environment variable OpenGEO accepts', () => {
    for (const provider of PROVIDERS) {
      for (const variable of provider.envVars) {
        expect(doc, `${variable} is undocumented`).toContain(variable);
      }
    }
  });

  it('documents the four override fields and their allowed values', () => {
    for (const field of ['baseUrl', 'api', 'auth', 'headers']) {
      expect(doc, `${field} is undocumented`).toContain(`\`${field}\``);
    }
    for (const auth of ['bearer', 'x-api-key', 'x-goog-api-key', 'none']) {
      expect(doc, `auth: ${auth} is undocumented`).toContain(auth);
    }
  });
});
