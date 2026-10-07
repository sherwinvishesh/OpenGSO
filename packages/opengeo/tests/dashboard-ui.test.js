import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';
import { stalenessOf } from '../web-next/components/staleness.js';
import { ago, banner, button, el, field, safeUrl, setAttr, setBusy, setLabel, useDocument } from '../web-next/ui.js';

/** @import { StateResponse } from '../../core/src/shared/api-types.js' */

// Scripts never run: this jsdom is a document to build nodes in, nothing more.
beforeEach(() => {
  useDocument(new JSDOM('<!doctype html><body></body>').window.document);
});

const WEB = fileURLToPath(new URL('../web-next/', import.meta.url));

/** @param {string} dir @returns {string[]} */
function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(js|html)$/.test(name) ? [path] : [];
  });
}

describe('the dashboard never parses a string as markup', () => {
  // A page title, a model's recommendation or a crawler name typed into a form all reach the page.
  // Each of these would read one of them as HTML.
  const FORBIDDEN = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'DOMParser', 'createContextualFragment', 'eval(', 'new Function'];

  it('has sources to scan', () => {
    expect(sources(WEB).length).toBeGreaterThan(3);
  });

  it.each(FORBIDDEN)('contains no %s', (api) => {
    const hits = sources(WEB).filter((path) => readFileSync(path, 'utf8').includes(api));
    expect(hits).toEqual([]);
  });

  it('has no inline script or style for the CSP to refuse', () => {
    const html = readFileSync(join(WEB, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
  });
});

describe('el', () => {
  it('puts text in as text', () => {
    const node = el('p', { text: '<img src=x onerror=alert(1)>' });
    expect(node.children).toHaveLength(0);
    expect(node.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('flattens children and skips the empty ones', () => {
    const node = el('div', {}, 'a', null, [1, false, [el('b', { text: 'c' })]], undefined);
    expect(node.textContent).toBe('a1c');
  });

  it('writes styles through the CSSOM', () => {
    const node = el('div', { style: { width: '40%', wordBreak: 'break-all' } });
    expect(node.style.width).toBe('40%');
    expect(node.style.getPropertyValue('word-break')).toBe('break-all');
  });

  it('wires listeners without an attribute', () => {
    let clicks = 0;
    const node = el('button', { on: { click: () => (clicks += 1) } });
    node.click();
    expect(clicks).toBe(1);
    expect(node.getAttributeNames()).toEqual([]);
  });
});

describe('links', () => {
  it.each(['https://example.com/a', 'http://localhost:3000/'])('keeps %s', (url) => {
    expect(el('a', { attrs: { href: url } }).getAttribute('href')).toBe(url);
  });

  it.each(['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,x', '/relative', 'vbscript:x'])(
    'drops %s',
    (url) => {
      expect(el('a', { attrs: { href: url } }).hasAttribute('href')).toBe(false);
      expect(safeUrl(url)).toBeUndefined();
    },
  );

  it('refuses handler and style attributes outright', () => {
    const node = el('div');
    expect(() => setAttr(node, 'onclick', 'x')).toThrow();
    expect(() => setAttr(node, 'OnMouseOver', 'x')).toThrow();
    expect(() => setAttr(node, 'style', 'color:red')).toThrow();
  });
});

describe('primitives', () => {
  it('ties a field hint to its control instead of putting it in the label', () => {
    const input = el('input');
    const wrap = field('Max pages', input, 'Stops after this many.');
    const label = /** @type {HTMLLabelElement} */ (wrap.querySelector('label'));
    expect(label.htmlFor).toBe(input.id);
    expect(label.textContent).toBe('Max pages');
    expect(wrap.querySelector(`#${input.getAttribute('aria-describedby')}`)?.textContent).toBe('Stops after this many.');
  });

  it('only gives a failing banner the alert role', () => {
    expect(banner({ tone: 'fail' }, 'x').getAttribute('role')).toBe('alert');
    expect(banner({ tone: 'warn' }, 'x').hasAttribute('role')).toBe(false);
  });

  it('keeps the same button node and label through a busy cycle', () => {
    const node = button({ label: 'Run test', primary: true });
    setBusy(node, true);
    expect(node.disabled).toBe(true);
    expect(node.querySelector('.spinner')).not.toBeNull();
    expect(node.textContent).toBe('Run test');
    setBusy(node, true);
    expect(node.querySelectorAll('.spinner')).toHaveLength(1);
    setBusy(node, false);
    expect(node.disabled).toBe(false);
    expect(node.querySelector('.spinner')).toBeNull();
    setLabel(node, 'Run again');
    expect(node.textContent).toBe('Run again');
  });

  it('says how long ago in words', () => {
    const now = Date.parse('2026-01-31T12:00:00Z');
    expect(ago('2026-01-31T11:59:30Z', now)).toBe('just now');
    expect(ago('2026-01-31T11:59:00Z', now)).toBe('1 minute ago');
    expect(ago('2026-01-31T09:00:00Z', now)).toBe('3 hours ago');
    expect(ago('2026-01-01T12:00:00Z', now)).toBe('30 days ago');
    expect(ago('2025-10-31T12:00:00Z', now)).toBe('3 months ago');
    expect(ago('not a date', now)).toBe('unknown');
  });
});

describe('stalenessOf', () => {
  const now = Date.parse('2026-01-31T12:00:00Z');
  /** @param {string | undefined} generatedAt */
  const stateWith = (generatedAt) =>
    /** @type {StateResponse} */ (/** @type {unknown} */ ({ manifest: generatedAt ? { generatedAt, pages: [{}] } : null }));
  /** @param {'pass' | 'fail'} status */
  const drift = (status) => /** @type {any} */ ({ id: 'B14', status, reason: 'The headings differ.' });

  it('asks for a first generate when there is no manifest', () => {
    expect(stalenessOf(stateWith(undefined), undefined, now)?.title).toBe('Nothing has been generated yet');
  });

  it('lets a failed drift check outrank a recent generate', () => {
    const verdict = stalenessOf(stateWith('2026-01-31T11:00:00Z'), drift('fail'), now);
    expect(verdict?.tone).toBe('fail');
    expect(verdict?.message).toMatch(/^The headings differ\. /);
  });

  it('warns after fourteen days, and says nothing before', () => {
    expect(stalenessOf(stateWith('2026-01-10T12:00:00Z'), undefined, now)?.title).toBe('Last generated 21 days ago');
    expect(stalenessOf(stateWith('2026-01-25T12:00:00Z'), undefined, now)).toBeUndefined();
  });

  it('confirms a passing drift check without offering to regenerate', () => {
    expect(stalenessOf(stateWith('2026-01-25T12:00:00Z'), drift('pass'), now)).toMatchObject({ tone: 'ok', actionable: false });
  });
});
