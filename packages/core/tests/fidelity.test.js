import { describe, expect, it } from 'vitest';
import { ERRORS } from '@opengeo/core/shared';
import { canonicalize, extractFacts, verifyFidelity } from '@opengeo/core/generate';
import { createAiEnhancer, stripCodeFence } from '@opengeo/core/generate';
/** @import { ProviderCall } from '@opengeo/core/generate' */

/**
 * The fidelity guard is the only thing standing between "the prompt says not to change facts" and
 * "the twin actually says what the page says", so it gets the heaviest coverage in the generate
 * pillar. Every provider here is a mock: no network, no key, no cost.
 */

const SOURCE = `# Engagement record

Aurora Fieldwork completed the Svalbard borehole survey on 3 March 2024 for $12,500,
a 42% increase on the previous contract.

| Project | Date | Value |
| --- | --- | --- |
| Svalbard boreholes | 3 March 2024 | $12,500 |
| Jotunheimen array | 11 June 2023 | 21,400 EUR |
| Vatnajokull transect | 17 September 2022 | 38,900 USD |

Total data delivered: 1.1 TB across 74 kilometres of transect.
`;

describe('extractFacts', () => {
  it('pulls dates, prices, percentages and plain numbers out of markdown', () => {
    const kinds = new Set(extractFacts(SOURCE).map((fact) => fact.kind));
    expect(kinds).toEqual(new Set(['date', 'currency', 'percent', 'number']));
  });

  it('treats a price as one fact rather than a number with a stray symbol', () => {
    const facts = extractFacts('Priced at $12,500 exactly.');
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ value: '$12,500', kind: 'currency' });
  });

  it('sees through markdown emphasis', () => {
    const bold = extractFacts('The price is **$12,500** today.');
    const plain = extractFacts('The price is $12,500 today.');
    expect(bold.map((f) => f.canonical)).toEqual(plain.map((f) => f.canonical));
  });

  it('reads the same day written three ways as the same fact', () => {
    expect(canonicalize('3 March 2024', 'date')).toBe('2024-03-03');
    expect(canonicalize('March 3, 2024', 'date')).toBe('2024-03-03');
    expect(canonicalize('2024-03-03', 'date')).toBe('2024-03-03');
  });

  it('leaves an ambiguous numeric date alone rather than guessing day-first or month-first', () => {
    expect(canonicalize('03/04/2024', 'date')).toBe('03/04/2024');
  });
});

describe('verifyFidelity', () => {
  it('accepts a faithful reformat', () => {
    const candidate = SOURCE.replace('# Engagement record', '# Engagement record\n');
    const report = verifyFidelity(SOURCE, candidate);
    expect(report.ok).toBe(true);
    expect(report.missing).toHaveLength(0);
  });

  it('rejects a changed date and names it', () => {
    const candidate = SOURCE.replaceAll('3 March 2024', '3 March 2023');
    const report = verifyFidelity(SOURCE, candidate);
    expect(report.ok).toBe(false);
    expect(report.missing.map((fact) => fact.value)).toContain('3 March 2024');
    expect(report.errors.join(' ')).toContain('3 March 2024');
  });

  it('rejects a changed price', () => {
    const report = verifyFidelity(SOURCE, SOURCE.replaceAll('$12,500', '$12,900'));
    expect(report.ok).toBe(false);
    expect(report.missing.map((fact) => fact.value)).toContain('$12,500');
  });

  it('rejects a summary even when it keeps every distinct fact', () => {
    const candidate = '# Engagement record\n\nThree surveys: 3 March 2024 ($12,500, 42%), 11 June 2023 (21,400 EUR), 17 September 2022 (38,900 USD). 1.1 TB over 74 kilometres.';
    const report = verifyFidelity(SOURCE, candidate);
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/summary|survived/i);
  });

  it('rejects a collapsed table by counting repeated mentions, not just distinct facts', () => {
    // Every distinct fact survives here. What does not survive is how many times the page says it,
    // which is what a flattened table looks like.
    const repeated = [
      'The standard rate is $12,500.',
      '| Region | Rate |',
      '| --- | --- |',
      '| North | $12,500 |',
      '| South | $12,500 |',
      '| East | $12,500 |',
      '| West | $12,500 |',
    ].join('\n');
    const report = verifyFidelity(repeated, 'The standard rate is $12,500 in every region.', { minWordRatio: 0 });
    expect(report.ok).toBe(false);
    expect(report.missing).toHaveLength(0);
    expect(report.issues.map((issue) => issue.code)).toContain('dropped-occurrences');
  });

  it('rejects an empty document', () => {
    expect(verifyFidelity(SOURCE, '   ').ok).toBe(false);
  });

  it('treats a lost heading as a warning, not a fallback', () => {
    const candidate = SOURCE.replace('# Engagement record', 'Engagement record');
    const report = verifyFidelity(SOURCE, candidate);
    expect(report.ok).toBe(true);
    expect(report.warnings.join(' ')).toContain('heading');
  });

  it('accepts a date rewritten into another valid format for the same day', () => {
    const candidate = SOURCE.replaceAll('3 March 2024', 'March 3, 2024');
    expect(verifyFidelity(SOURCE, candidate).ok).toBe(true);
  });
});

describe('stripCodeFence', () => {
  it('unwraps a whole-document fence the model added anyway', () => {
    expect(stripCodeFence('```markdown\n# Title\n\nBody.\n```')).toBe('# Title\n\nBody.');
  });

  it('leaves an unfenced document alone', () => {
    expect(stripCodeFence('# Title\n\nBody.')).toBe('# Title\n\nBody.');
  });

  it('leaves a document containing a code block alone', () => {
    const doc = '# Title\n\n```js\nconst a = 1;\n```\n\nAfter.';
    expect(stripCodeFence(doc)).toBe(doc);
  });

  it('leaves a document that opens and closes with its own code blocks alone', () => {
    const doc = '```\nnpm install opengeo\n```\n\nThen run it.\n\n```\nopengeo test\n```';
    expect(stripCodeFence(doc)).toBe(doc);
  });

  it('unwraps a bare fence around a document with no code of its own', () => {
    expect(stripCodeFence('```\n# Title\n\nBody.\n```')).toBe('# Title\n\nBody.');
  });

  it('unwraps a markdown fence around a document that has code blocks inside', () => {
    const inner = '# Title\n\n```js\nconst a = 1;\n```\n\nAfter.';
    expect(stripCodeFence(`\`\`\`markdown\n${inner}\n\`\`\``)).toBe(inner);
  });
});

describe('createAiEnhancer', () => {
  const input = {
    url: 'https://example.com/resume',
    title: 'Engagement record',
    html: '<html></html>',
    algorithmicMarkdown: SOURCE,
  };

  /** @param {(c: ProviderCall) => Promise<string>} call */
  const enhancerWith = (call) =>
    createAiEnhancer({ provider: 'anthropic', apiKey: 'test-key', call, env: {} });

  it('keeps a faithful rewrite', async () => {
    const enhance = enhancerWith(async () => `${SOURCE}\n`);
    const result = await enhance(input);
    expect(result.fellBack).toBe(false);
    expect(result.markdown).toContain('$12,500');
  });

  it('falls back to the algorithmic markdown when the model mutates a date', async () => {
    const enhance = enhancerWith(async () => SOURCE.replaceAll('3 March 2024', '3 March 2023'));
    const result = await enhance(input);
    expect(result.fellBack).toBe(true);
    expect(result.markdown).toBe(SOURCE);
    expect(result.warnings[0]).toContain('fidelity');
  });

  it('falls back when the provider errors instead of failing the whole run', async () => {
    const enhance = enhancerWith(async () => {
      throw new Error('The anthropic API returned 429.');
    });
    const result = await enhance(input);
    expect(result.fellBack).toBe(true);
    expect(result.markdown).toBe(SOURCE);
    expect(result.warnings.join(' ')).toContain('429');
  });

  it('does not claim nothing was written when the algorithmic twin is written instead', async () => {
    const enhance = enhancerWith(async () => {
      throw new Error(ERRORS.providerFailed('anthropic', 401, '{"error":"invalid x-api-key"}'));
    });
    const warning = (await enhance(input)).warnings.join(' ');
    expect(warning).toContain('kept the algorithmic version');
    expect(warning).toContain('401');
    expect(warning).not.toMatch(/nothing was written|files are untouched/i);
  });

  it('stops sending pages once the provider refuses the key', async () => {
    let calls = 0;
    const enhance = enhancerWith(async () => {
      calls += 1;
      throw Object.assign(new Error(ERRORS.providerFailed('anthropic', 401, '{}')), { status: 401 });
    });
    await enhance(input);
    const second = await enhance(input);
    await enhance(input);
    expect(calls).toBe(1);
    expect(second.fellBack).toBe(true);
    expect(second.markdown).toBe(SOURCE);
    expect(second.warnings.join(' ')).toContain('refused the key with 401 on an earlier page');
  });

  it('keeps sending pages after a failure that is not about the key', async () => {
    let calls = 0;
    const enhance = enhancerWith(async () => {
      calls += 1;
      throw Object.assign(new Error(ERRORS.providerFailed('anthropic', 429, '{}')), { status: 429 });
    });
    await enhance(input);
    await enhance(input);
    expect(calls).toBe(2);
  });

  it('sends the fidelity instructions and the extraction to the provider', async () => {
    /** @type {ProviderCall | undefined} */
    let seen;
    const enhance = enhancerWith(async (call) => {
      seen = call;
      return SOURCE;
    });
    await enhance(input);
    expect(seen?.system).toContain('Never alter a fact');
    expect(seen?.system).toContain('Never summarize');
    expect(seen?.prompt).toContain('$12,500');
    expect(seen?.apiKey).toBe('test-key');
  });

  it('refuses to run in CI', () => {
    expect(() =>
      createAiEnhancer({ provider: 'anthropic', apiKey: 'k', call: async () => '', env: { CI: 'true' } }),
    ).toThrow(/local-machine-only/);
  });

  it('rejects an unknown provider by name', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createAiEnhancer({ provider: /** @type {any} */ ('bedrock'), apiKey: 'k', call: async () => '', env: {} }),
    ).toThrow(/bedrock/);
  });
});
