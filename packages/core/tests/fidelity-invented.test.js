import { describe, expect, it } from 'vitest';
import { extractFacts, verifyFidelity } from '@opengso/core/generate';

/**
 * The guard used to look one way only: every fact on the page had to survive. A model that kept
 * them all and added its own, or flipped a sign, or turned millions into billions, passed. These
 * are the cases that look the other way.
 */

const SOURCE = `# Results

Revenue fell -4% to $1.2 million in 2024. The team shipped 12 releases.

1. Planning
2. Delivery
`;

describe('verifyFidelity, the other direction', () => {
  it('rejects a number the page never states', () => {
    const report = verifyFidelity(SOURCE, `${SOURCE}\nCustomer satisfaction reached 97%.\n`);
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain('invented-fact');
    expect(report.errors.join(' ')).toContain('97%');
  });

  it('rejects a date the page never states', () => {
    const report = verifyFidelity(SOURCE, `${SOURCE}\nLast reviewed 9 January 2025.\n`);
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toContain('9 January 2025');
  });

  it('rejects a flipped sign', () => {
    const report = verifyFidelity(SOURCE, SOURCE.replace('-4%', '4%'));
    expect(report.ok).toBe(false);
  });

  it('rejects a changed magnitude', () => {
    const report = verifyFidelity(SOURCE, SOURCE.replace('$1.2 million', '$1.2 billion'));
    expect(report.ok).toBe(false);
  });

  it('rejects a changed magnitude written as a suffix', () => {
    const page = 'Raised $5M in the seed round, then 10k users signed up.';
    expect(verifyFidelity(page, page.replace('$5M', '$5B')).ok).toBe(false);
  });

  it('does not count list numbering as a fact', () => {
    const candidate = SOURCE.replace('1. Planning\n2. Delivery', '- Planning\n- Delivery');
    expect(verifyFidelity(SOURCE, candidate).ok).toBe(true);
    expect(verifyFidelity(candidate, SOURCE).ok).toBe(true);
  });

  it('still accepts a faithful reformat', () => {
    const candidate = SOURCE.replace('Revenue fell -4% to $1.2 million in 2024.', 'Revenue fell **-4%** to **$1.2 million** in 2024.');
    expect(verifyFidelity(SOURCE, candidate).ok).toBe(true);
  });
});

describe('extractFacts, sign and scale', () => {
  it('keeps a minus sign and a scale word as part of the fact', () => {
    const canonical = extractFacts('Fell -4% to $1.2 million, or 3 bn, or $5M.').map((fact) => fact.canonical);
    expect(canonical).toEqual(['-4%', '$1.2million', '3bn', '$5m']);
  });

  it('does not read a range as a negative number', () => {
    expect(extractFacts('From 2019-2024.').map((fact) => fact.canonical)).toEqual(['2019', '2024']);
  });
});
