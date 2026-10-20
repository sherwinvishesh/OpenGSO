import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';
import { stalenessOf } from '../web/components/staleness.js';
import { ago, banner, button, el, field, projectPath, safeUrl, setAttr, setBusy, setLabel, useDocument } from '../web/ui.js';

/** @import { StateResponse } from '../../core/src/shared/api-types.js' */

// Scripts never run: this jsdom is a document to build nodes in, nothing more.
beforeEach(() => {
  useDocument(new JSDOM('<!doctype html><body></body>').window.document);
});

const WEB = fileURLToPath(new URL('../web/', import.meta.url));

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

describe('the dashboard ships as it is', () => {
  // Nothing bundles web/: the browser fetches each module by the path written in its import. One
  // that reaches outside the folder works in a clone and 404s from an installed package, where
  // core is not there to reach. Type-only `@import` comments are not imports and are exempt.
  it('imports only files inside its own folder, and only ones that exist', () => {
    /** @type {string[]} */
    const outside = [];
    for (const path of sources(WEB).filter((file) => file.endsWith('.js'))) {
      const code = readFileSync(path, 'utf8');
      for (const [, specifier] of code.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'/gm)) {
        const target = resolvePath(dirname(path), specifier);
        if (!specifier.startsWith('.') || !target.startsWith(WEB) || !existsSync(target)) outside.push(`${path}: ${specifier}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it('is in the published package, with nothing beside it that would not run', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.files).toContain('web');
    expect(pkg.files).toContain('!web/tsconfig.json');
    const files = readdirSync(WEB, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    expect(files.map((entry) => entry.name).filter((name) => !/\.(js|html|css)$/.test(name) && name !== 'tsconfig.json')).toEqual([]);
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

  it('shows a path from the project folder, and only when it is inside it', () => {
    expect(projectPath('/work/site/public/robots.txt', '/work/site')).toBe('public/robots.txt');
    expect(projectPath('/work/site/public', '/work/site/')).toBe('public');
    expect(projectPath('C:\\work\\site\\public\\llms.txt', 'C:\\work\\site')).toBe('public\\llms.txt');
    // A sibling whose name starts the same is not inside it.
    expect(projectPath('/work/site-old/robots.txt', '/work/site')).toBe('/work/site-old/robots.txt');
    expect(projectPath('/elsewhere/robots.txt', '/work/site')).toBe('/elsewhere/robots.txt');
    expect(projectPath('/work/site', '/work/site')).toBe('/work/site');
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
    expect(verdict?.message).toBe('The headings differ.');
  });

  it('stops quoting a failed drift check once the twins were regenerated after it', () => {
    const tested = '2026-01-31T11:00:00Z';
    // Still the manifest the test compared against: the failure stands.
    expect(stalenessOf(stateWith(tested), drift('fail'), now, tested)?.tone).toBe('fail');
    // Generate has run since. Neither the old failure nor a claim that it is fixed.
    expect(stalenessOf(stateWith('2026-01-31T11:30:00Z'), drift('fail'), now, tested)).toMatchObject({
      tone: 'ok',
      title: 'Regenerated since the last test',
      actionable: false,
    });
  });

  it('warns after fourteen days, and says nothing before', () => {
    expect(stalenessOf(stateWith('2026-01-10T12:00:00Z'), undefined, now)?.title).toBe('Last generated 21 days ago');
    expect(stalenessOf(stateWith('2026-01-25T12:00:00Z'), undefined, now)).toBeUndefined();
  });

  it('confirms a passing drift check without offering to regenerate', () => {
    expect(stalenessOf(stateWith('2026-01-25T12:00:00Z'), drift('pass'), now)).toMatchObject({ tone: 'ok', actionable: false });
  });

  describe('for a project generated from its files', () => {
    /** @param {Array<{ kind: 'changed' | 'new' | 'missing' | 'manual'; sourceFile: string }>} stale */
    const filesState = (stale) =>
      /** @type {StateResponse} */ (
        /** @type {unknown} */ ({
          manifest: { generatedAt: '2025-01-01T00:00:00Z', pages: [{}] },
          freshness: { checked: 3, stale: stale.map((twin) => ({ ...twin, message: `${twin.sourceFile} is ${twin.kind}.` })) },
        })
      );

    it('names the kind of change when there is one page', () => {
      expect(stalenessOf(filesState([{ kind: 'changed', sourceFile: 'a.html' }]), undefined, now)).toMatchObject({
        title: 'A page changed after its twin was written',
        message: 'Agents are reading the old version. a.html is changed.',
        actionable: true,
      });
      expect(stalenessOf(filesState([{ kind: 'new', sourceFile: 'b.html' }]), undefined, now)).toMatchObject({
        title: 'A page has no twin yet',
        message: 'b.html is new.',
      });
      expect(stalenessOf(filesState([{ kind: 'missing', sourceFile: 'c.html' }]), undefined, now)?.title).toBe(
        'A twin is left over from a deleted page',
      );
    });

    it('counts a mix without claiming every page changed', () => {
      const verdict = stalenessOf(
        filesState([
          { kind: 'new', sourceFile: 'careers.html' },
          { kind: 'changed', sourceFile: 'pricing.html' },
        ]),
        undefined,
        now,
      );
      expect(verdict?.title).toBe('2 pages are out of date');
      expect(verdict?.message).toBe('Agents are reading the old version. careers.html is new. pricing.html is changed.');
    });

    it('offers no Generate button when only hand-written twins are behind', () => {
      expect(stalenessOf(filesState([{ kind: 'manual', sourceFile: 'a.html' }]), undefined, now)?.actionable).toBe(false);
    });

    it('trusts the files over the clock: an old generate with nothing stale says nothing', () => {
      expect(stalenessOf(filesState([]), undefined, now)).toBeUndefined();
    });
  });
});
