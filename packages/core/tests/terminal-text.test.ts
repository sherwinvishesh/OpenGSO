import { describe, expect, it } from 'vitest';
import { terminalSafe, terminalText } from '@opengeo/core/shared';
import type { ContentReview } from '@opengeo/core/test';
import { renderContentReport } from '@opengeo/core/test';

/**
 * Remote text on the terminal.
 *
 * A tested page, a provider's error body and a model's answer are all somebody else's bytes, and a
 * terminal treats some bytes as commands: set the window title, rewrite the clipboard, erase the
 * line above, hide everything after. None of that may survive into a report, with or without
 * colour.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const HOSTILE = `fine${ESC}]0;pwned${BEL}${ESC}]52;c;ZWNobyBoaQ==${BEL}${ESC}[2K\r${ESC}[8mhidden\u009b31m‮evil`;

/** Anything that would make a terminal do something rather than print something. */
function hasControl(text: string): boolean {
  // Our own colour codes are ESC [ digits m. Everything else from ESC is remote.
  const withoutOurColours = text.replace(/\u001b\[[0-9;]*m/g, '');
  return /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(withoutOurColours);
}

describe('terminalText', () => {
  it('keeps the words and drops every control character but newline and tab', () => {
    const cleaned = terminalText(HOSTILE);
    expect(hasControl(cleaned)).toBe(false);
    expect(cleaned).not.toContain(ESC);
    expect(cleaned).toContain('fine');
    expect(cleaned).toContain('evil');
  });

  it('leaves ordinary text, newlines, tabs and non-Latin script alone', () => {
    const text = 'Résumé\n\tline two, 日本語, emoji ✓';
    expect(terminalText(text)).toBe(text);
  });
});

describe('terminalSafe', () => {
  it('cleans every string in a result without touching its shape or the original', () => {
    const original = { a: HOSTILE, list: [HOSTILE, 3], nested: { b: HOSTILE, ok: true }, missing: undefined };
    const cleaned = terminalSafe(original);
    expect(hasControl(JSON.stringify(cleaned).replace(/\\u[0-9a-f]{4}/gi, (m) => JSON.parse(`"${m}"`)))).toBe(false);
    expect(cleaned.list[1]).toBe(3);
    expect(cleaned.nested.ok).toBe(true);
    expect(original.a).toBe(HOSTILE);
  });
});

describe('the content report', () => {
  it('prints what a model said without letting it drive the terminal', () => {
    const review: ContentReview = {
      provider: 'anthropic',
      model: 'm',
      documents: [
        {
          url: `https://example.com/a.md${ESC}]0;t${BEL}`,
          source: 'link',
          words: 10,
          review: { summary: HOSTILE, findings: [], recommendations: [], provider: 'anthropic', model: 'm', raw: HOSTILE },
        },
        { url: 'https://example.com/b.md', source: 'link', words: 5, error: HOSTILE },
      ],
      areaScores: [],
      recommendations: [],
      notReviewed: 0,
    };
    const text = renderContentReport(review, {
      twins: [],
      rejected: [{ url: 'https://example.com/c', reason: HOSTILE }],
    } as unknown as Parameters<typeof renderContentReport>[1]);
    expect(hasControl(text)).toBe(false);
    expect(text).toContain('evil');
  });
});
