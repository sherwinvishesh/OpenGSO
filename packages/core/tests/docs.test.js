import { readdirSync, readFileSync } from 'node:fs';
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
import { COMMAND_PACKAGES } from '../src/shared/errors.js';
import { RESERVED_AI_PARAMS, defaultConfig } from '../src/shared/config.js';

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

/** Every file a check is implemented in, as one string, so a check that moves is still found. */
const checkSources = () =>
  ['checks-site.js', 'checks-twin.js', 'drift.js', 'cascade.js', 'runner.js'].map((name) => read(`packages/core/src/test/${name}`)).join('\n');

describe('docs/checks.md', () => {
  const doc = read('docs/checks.md');

  it('documents every check, with a heading of its own', () => {
    for (const check of CHECKS) {
      expect(doc, `${check.id} has no "### ${check.id} - ..." heading`).toContain(`### ${check.id} - `);
    }
  });

  it('says whether every check is scored, and states its weight', () => {
    for (const check of CHECKS) {
      const section = doc.split(`### ${check.id} - `)[1] ?? '';
      const claim = section.split('\n').find((line) => line.startsWith('**Scored') || line.startsWith('**Suggestion'));
      expect(claim, `${check.id} does not state whether it is scored, and its weight`).toBeDefined();
      const expected = `**${check.scored ? 'Scored' : 'Suggestion'}, weight ${check.weight}.**`;
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
    const a = { scored: sum((c) => c.category === 'A' && c.scored), suggestions: sum((c) => c.category === 'A' && !c.scored) };
    const b = { scored: sum((c) => c.category === 'B' && c.scored), suggestions: sum((c) => c.category === 'B' && !c.scored) };

    expect(doc).toContain(`| **A. Discoverability** | ${a.scored} | ${a.suggestions} | ${a.scored + a.suggestions} |`);
    expect(doc).toContain(`| **B. Implementation** | ${b.scored} | ${b.suggestions} | ${b.scored + b.suggestions} |`);
    expect(doc).toContain(`| **Total** | ${a.scored + b.scored} | ${a.suggestions + b.suggestions} | ${a.scored + a.suggestions + b.scored + b.suggestions} |`);
  });

  it('counts the scored checks and the suggestions the way the catalogue does', () => {
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'];
    const scored = CHECKS.filter((check) => check.scored).length;
    const suggestions = CHECKS.length - scored;
    expect(doc).toContain(`${words[scored][0]?.toUpperCase()}${words[scored].slice(1)} checks make the 0 to 100`);
    expect(doc).toContain(`The other ${words[suggestions]} are conventions`);
    expect(doc).toContain(`"N of ${suggestions} adopted"`);
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
    const runner = checkSources();
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
    const runner = checkSources();
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

  it('shows the locked block with the weights the cascade actually locks', () => {
    /** @param {string} id */
    const weightOf = (id) => CHECKS.find((check) => check.id === id)?.weight ?? 0;
    const points = TWIN_LOCKED_IDS.reduce((total, id) => total + weightOf(id), 0);
    expect(doc).toContain(`Locked (${TWIN_LOCKED_IDS.length})`);
    expect(doc).toContain(`${TWIN_LOCKED_IDS.length} more suggestions apply once B1 passes`);
    expect(doc).toMatch(new RegExp(`which\\s+total ${points}\\.`));
    // And the id/weight line under it, in the order the report prints them, which is the catalogue's.
    const printed = CHECKS.filter((check) => TWIN_LOCKED_IDS.includes(check.id));
    expect(doc).toContain(printed.map((check) => `${check.id} ${check.weight}`).join('  '));
  });

  it('never invents a check id that does not exist', () => {
    /** @type {Set<string>} */
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

describe('docs/config.md', () => {
  const doc = read('docs/config.md');
  const rowFor = (/** @type {string} */ key) => doc.split('\n').find((line) => line.startsWith(`| \`${key}\` |`));

  // FIELD_RULES is module-private, and it is the one list of every field the loader validates, so
  // it is read from source: a field added there without a row here fails this test.
  const rules = [...read('packages/core/src/shared/config.js').matchAll(/^\s+\[(?:undefined|'(\w+)'), '(\w+)',/gm)].map(
    ([, section, key]) => (section ? `${section}.${key}` : key),
  );

  it('has a row for every field the loader checks', () => {
    expect(rules.length).toBeGreaterThan(15);
    for (const key of rules) expect(rowFor(key), `${key} has no row`).toBeDefined();
  });

  it('has a row for every field defaultConfig sets, and states its literal default', () => {
    const defaults = /** @type {Record<string, unknown>} */ (defaultConfig());
    for (const [name, value] of Object.entries(defaults)) {
      const entries =
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.entries(value).map(([key, inner]) => [`${name}.${key}`, inner])
          : [[name, value]];
      for (const [key, inner] of entries) {
        const row = rowFor(String(key));
        expect(row, `${key} has no row`).toBeDefined();
        // markdownRouting's default is derived from the bot list, so the row describes it instead.
        if (key === 'bots.markdownRouting') continue;
        expect(row?.split('|')[2], `${key} default`).toContain(`\`${JSON.stringify(inner)}\``);
      }
    }
  });

  it('documents no field the loader does not know', () => {
    const fieldsTable = doc.slice(doc.indexOf('## Fields'), doc.indexOf('### A `bots.custom` entry'));
    const documented = [...fieldsTable.matchAll(/^\| `([\w.]+)` \|/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual([...rules].sort());
  });

  it('documents every field of a bots.custom entry', () => {
    const fields = read('packages/core/src/shared/bot-types.js').match(/@typedef \{object\} CustomBotInput([\s\S]*?)\*\//)?.[1] ?? '';
    const names = [...fields.matchAll(/@property \{[^}]+\} \[?(\w+)/g)].map((m) => m[1]);
    expect(names).toContain('uaPatterns');
    for (const name of names) expect(rowFor(name), `bots.custom ${name}`).toBeDefined();
  });
});

describe('docs/prod-api.md', () => {
  const doc = read('docs/prod-api.md');

  it('documents every export of the six opengeo-prod entries, and nothing else', async () => {
    const exported = new Set([
      ...Object.keys(await import('../src/prod/index.js')),
      ...Object.keys(await import('../src/prod/adapters/next.js')),
      ...Object.keys(await import('../src/prod/edge.js')),
      ...Object.keys(await import('../src/prod/adapters/node.js')),
      ...Object.keys(await import('../src/prod/adapters/fetch.js')),
      ...Object.keys(await import('../src/prod/adapters/vite.js')).filter((name) => name !== 'default'),
    ]);
    for (const name of exported) expect(doc, `${name} is not documented`).toMatch(new RegExp(`\\*\\*\`${name}[(\`]`));
    const documented = [...doc.matchAll(/\*\*`(\w+)[(`]/g)].map((m) => m[1]);
    for (const name of documented) expect(exported, `${name} is not exported`).toContain(name);
  });

  it('keeps the Node-only exports out of the edge entry it says has none', async () => {
    const edge = Object.keys(await import('../src/prod/edge.js'));
    for (const name of ['createFsStore', 'buildStartupStatus', 'logStartupStatus']) expect(edge).not.toContain(name);
  });
});

describe('docs/versioning.md', () => {
  const doc = read('docs/versioning.md');

  it('names the real spec version and the real package version', () => {
    expect(doc).toContain(`\`${AEO_SPEC_VERSION}\``);
    const versions = new Set(
      ['testing', 'generate', 'prod', 'cli', 'opengeo'].map((dir) => JSON.parse(read(`packages/${dir}/package.json`)).version),
    );
    // The doc says all five share one version today; when they diverge, so must the sentence.
    expect(versions.size).toBe(1);
    expect(doc).toContain(`today all five are\n\`${[...versions][0]}\``);
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

  it('documents the override fields and their allowed values', () => {
    for (const field of ['baseUrl', 'api', 'auth', 'headers', 'params']) {
      expect(doc, `${field} is undocumented`).toContain(`\`${field}\``);
    }
    for (const auth of ['bearer', 'x-api-key', 'x-goog-api-key', 'none']) {
      expect(doc, `auth: ${auth} is undocumented`).toContain(auth);
    }
  });

  it('is counted the same way everywhere the READMEs count it', () => {
    const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    const tens = ['', '', 'twenty', 'thirty'];
    const n = PROVIDERS.length;
    const spelled = n % 10 === 0 ? tens[n / 10] : `${tens[Math.floor(n / 10)]}-${ones[n % 10]}`;
    expect(read('README.md')).toContain(`${capitalized(spelled)} of them out of the box`);
    expect(read('packages/cli/README.md')).toContain(`${capitalized(spelled)} of them`);
    expect(read('packages/generate/README.md')).toContain(`Any of ${spelled} providers`);
    expect(read('packages/opengeo/README.md')).toContain(`any of the ${spelled} providers`);
    const readme = read('README.md');
    for (const provider of PROVIDERS) expect(readme, `README.md never names ${provider.id}`).toMatch(new RegExp(`\\b${provider.id}\\b`));
  });

  it('names every request field ai.params may not set', () => {
    for (const field of RESERVED_AI_PARAMS) expect(doc, `${field} is not listed as reserved`).toContain(`\`${field}\``);
  });

  it('gives each keyless provider its own section, since none of them has a key page to link', () => {
    for (const provider of PROVIDERS.filter((entry) => entry.keyless)) {
      expect(doc, `${provider.label} has no section`).toContain(`### ${provider.label.replace(/ \(.*\)$/, '')}`);
    }
  });
});

/** Spelled-out counts, for prose that says "five probes" rather than "5 probes". */
const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** @param {string} word */
const capitalized = (word) => `${word[0].toUpperCase()}${word.slice(1)}`;

describe('`opengeo prod test`', () => {
  const verify = read('packages/core/src/prod/verify.js');
  const probes = new Set([...verify.matchAll(/^\s+id: '([a-z-]+)',$/gm)].map(([, id]) => id));

  it('says in its help how many probes it sends', () => {
    // The help lives in the CLI source and is not exported, so it is read as text.
    expect(probes.size).toBeGreaterThan(3);
    expect(read('packages/core/src/cli/index.js')).toContain(
      `Probes a deployed opengeo-prod middleware ${COUNT_WORDS[probes.size]} ways`,
    );
  });

  it('says the same in the opengeo-prod README', () => {
    expect(read('packages/prod/README.md')).toContain(`${capitalized(COUNT_WORDS[probes.size])} probes,`);
  });
});

/**
 * READMEs and the contributor guide state facts too, and nothing else reads them. Each test below
 * exists because the fact it checks once drifted.
 */
describe('the READMEs', () => {
  const READMES = ['README.md', ...['testing', 'generate', 'prod', 'cli', 'opengeo'].map((dir) => `packages/${dir}/README.md`)];
  const docFiles = readdirSync(join(repoRoot, 'docs')).filter((file) => file.endsWith('.md'));
  const proseFiles = [...READMES, 'CONTRIBUTING.md', 'examples/nextjs-demo/README.md', ...docFiles.map((file) => `docs/${file}`)];

  it('say, under the title, that nothing is on npm yet', () => {
    // Remove this test, and the notice, in the release that first publishes.
    for (const file of READMES) {
      expect(read(file).split('\n').slice(0, 4).join('\n'), file).toContain(
        '> **Pre-release.** Nothing is published to npm yet, and the APIs may change before 1.0.',
      );
    }
  });

  it('state the Node version each engines field requires', () => {
    for (const dir of ['testing', 'generate', 'prod', 'cli', 'opengeo']) {
      const engines = JSON.parse(read(`packages/${dir}/package.json`)).engines?.node ?? '';
      const major = engines.match(/^>=(\d+)$/)?.[1];
      expect(major, `packages/${dir} engines.node`).toBeDefined();
      expect(read(`packages/${dir}/README.md`), dir).toContain(`Needs Node.js ${major} or later.`);
      expect(read('README.md')).toContain(`Needs Node.js ${major} or later.`);
    }
  });

  it('state the category weight totals of opengeo-testing correctly', () => {
    /** @param {string} category */
    const total = (category) => CHECKS.filter((c) => c.category === category).reduce((sum, c) => sum + c.weight, 0);
    const doc = read('packages/testing/README.md');
    expect(doc).toContain(`**Category A, discoverability (weights totalling ${total('A')}).**`);
    expect(doc).toContain(`**Category B, implementation (weights totalling ${total('B')}).**`);
  });

  it('list every group the test report can print', () => {
    // The check groups are the headings in `renderReport` and `renderLocked`. The discovery
    // section further down the file is not a group of checks.
    const source = read('packages/core/src/test/report.js');
    const report = ['export function renderReport(', 'function renderLocked(']
      .map((signature) => (source.split(signature)[1] ?? '').split('\n}\n')[0])
      .join('\n');
    // Passed and Adopted share one renderer, so their names are its first argument.
    const groups = [
      ...[...report.matchAll(/heading\(`([A-Z][^`(]*?) \(\$\{/g)].map(([, name]) => name),
      ...[...report.matchAll(/renderPassing\('([A-Z][^']*)'/g)].map(([, name]) => name),
    ];
    expect(new Set(groups).size).toBeGreaterThanOrEqual(7);
    const output = (read('packages/testing/README.md').split('## Output')[1] ?? '').split('\n## ')[0];
    for (const group of groups) expect(output, `the Output section never names "${group}"`).toContain(`\n${group} `);
  });

  it('call the Next.js Vary limitation the partial B7 actually returns', () => {
    const earned = checkSources().match(/partial\('B7', (\d+)/)?.[1];
    const weight = CHECKS.find((check) => check.id === 'B7')?.weight;
    expect(earned).toBeDefined();
    for (const file of ['README.md', 'packages/testing/README.md', 'packages/prod/README.md', 'examples/nextjs-demo/README.md']) {
      expect(read(file), `${file} does not give B7 as ${earned} of ${weight}`).toContain(`${earned} of ${weight}`);
    }
    expect(read('docs/spec.md')).toContain(`check B7 earns ${earned} of its ${weight}`);
    for (const file of proseFiles) {
      expect(read(file), `${file} calls the Vary limitation a failure`).not.toMatch(/genuine failure|B7 fails/);
    }
  });

  it('give the demo the number of pages it has', () => {
    /** @param {string} dir @returns {number} */
    const pages = (dir) =>
      readdirSync(join(repoRoot, dir), { withFileTypes: true }).reduce(
        (count, entry) =>
          count + (entry.isDirectory() ? pages(`${dir}/${entry.name}`) : entry.name === 'page.tsx' ? 1 : 0),
        0,
      );
    expect(read('examples/nextjs-demo/README.md')).toContain(`A ${COUNT_WORDS[pages('examples/nextjs-demo/app')]}-page`);
  });

  it('only import names the prod entries really export', async () => {
    const modules = {
      'opengeo-prod': await import('../src/prod/index.js'),
      'opengeo-prod/next': await import('../src/prod/adapters/next.js'),
      'opengeo-prod/edge': await import('../src/prod/edge.js'),
      'opengeo-prod/node': await import('../src/prod/adapters/node.js'),
      'opengeo-prod/fetch': await import('../src/prod/adapters/fetch.js'),
      'opengeo-prod/vite': await import('../src/prod/adapters/vite.js'),
    };
    /** @type {Record<string, keyof typeof modules>} */
    const sameAs = {
      'opengeo-prod': 'opengeo-prod',
      'opengeo-prod/next': 'opengeo-prod/next',
      'opengeo-prod/edge': 'opengeo-prod/edge',
      'opengeo-prod/node': 'opengeo-prod/node',
      'opengeo-prod/fetch': 'opengeo-prod/fetch',
      'opengeo-prod/vite': 'opengeo-prod/vite',
      'opengeo/prod': 'opengeo-prod',
      'opengeo/prod/next': 'opengeo-prod/next',
      'opengeo/prod/edge': 'opengeo-prod/edge',
      'opengeo/prod/node': 'opengeo-prod/node',
      'opengeo/prod/fetch': 'opengeo-prod/fetch',
      'opengeo/prod/vite': 'opengeo-prod/vite',
    };
    let seen = 0;
    for (const file of proseFiles) {
      for (const [, names, specifier] of read(file).matchAll(/(?:import|export)\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
        const entry = sameAs[specifier];
        if (!entry) continue;
        for (const name of names.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
          seen += 1;
          expect(Object.keys(modules[entry]), `${file} imports ${name} from ${specifier}`).toContain(name);
        }
      }
    }
    expect(seen).toBeGreaterThan(5);
  });

  it('name every entry opengeo-prod and opengeo publish', () => {
    for (const dir of ['prod', 'opengeo']) {
      const pkg = JSON.parse(read(`packages/${dir}/package.json`));
      const doc = read(`packages/${dir}/README.md`);
      for (const subpath of Object.keys(pkg.exports)) {
        const specifier = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
        expect(doc, `packages/${dir}/README.md never mentions ${specifier}`).toContain(`\`${specifier}`);
      }
    }
  });

  it('do not claim the opengeo-prod tarball has no AI provider code at all', () => {
    // True of the library a server imports, which check:bundles enforces. The tarball's CLI carries
    // the provider catalogue so `opengeo help providers` can print it.
    for (const file of proseFiles) expect(read(file)).not.toContain('no AI provider code at all');
  });

  it('link every document in docs/ from the root README', () => {
    for (const file of docFiles) {
      expect(read('README.md'), `README.md does not link docs/${file}`).toContain(`(docs/${file})`);
    }
  });
});

describe('CONTRIBUTING.md', () => {
  const doc = read('CONTRIBUTING.md');

  it('lists the commands each package ships in its layout table', () => {
    for (const [, name, ships] of doc.matchAll(/^packages\/\w+\s+(opengeo-\w+)\s+(.+)$/gm)) {
      const commands = Object.entries(COMMAND_PACKAGES)
        .filter(([, packages]) => packages.includes(name))
        .map(([command]) => command);
      expect(ships.split(' + ').filter((part) => part !== 'middleware').sort(), name).toEqual(commands.sort());
    }
  });
});

describe('the verify steps', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  const CHECKS_TO_RUN = ['typecheck', 'test', 'build', 'check:bundles', 'check:packages'];

  it('are the same five real scripts in the README and the contributor guide', () => {
    for (const [file, heading] of [['README.md', '## Working on it'], ['CONTRIBUTING.md', '## The loop']]) {
      const block = (read(file).split(heading)[1] ?? '').split('```bash')[1]?.split('```')[0] ?? '';
      const named = [...block.matchAll(/npm (?:run )?([\w:]+)/g)].map(([, script]) => script).filter((s) => s !== 'install');
      expect(named, `${file} ${heading}`).toEqual(CHECKS_TO_RUN);
      for (const script of named) expect(scripts[script], `${file} runs \`npm run ${script}\`, which does not exist`).toBeDefined();
    }
  });

  it('typecheck covers the dashboard, so neither guide needs a second tsc line', () => {
    expect(scripts.typecheck).toContain('packages/opengeo/web/tsconfig.json');
  });
});
