import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, mergeConfig } from '@opengeo/core/shared';
import { generateFromFiles } from '@opengeo/core/generate';
import { gatherEvidence, siteFolderOf, testEvidence } from '@opengeo/core/test';
/** @import { CheckResult } from '@opengeo/core/test' */

/**
 * A site that lives in a folder of its host, the way GitHub Pages publishes a project site at
 * user.github.io/repo/: generated from its build folder, served by a host that maps the folder to
 * /repo/ and owns everything outside it, and tested the way `opengeo test` would test it.
 */

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opengeo-folder-site-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const WORDS = '<p>Acme builds small, dependable tools for teams who would rather ship than configure, and has done so since 2019 from one office.</p>';

/**
 * @param {string} title
 * @param {string} body
 */
const page = (title, body) =>
  `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${WORDS}${body}</main></body></html>`;

/** @param {Record<string, string>} files */
function writeSite(files) {
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, 'site', file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

const TYPES = /** @type {Record<string, string>} */ ({ '.html': 'text/html', '.md': 'text/markdown', '.txt': 'text/plain', '.xml': 'application/xml' });

/**
 * Serves `root/site` at `/repo/` the way GitHub Pages does: a folder's index.html at its slash, a
 * page with or without `.html`, and a 404 for anything outside the folder.
 *
 * @returns {Promise<{ base: string; close: () => Promise<void> }>}
 */
async function host() {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (!path.startsWith('/repo/')) return void res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>404</title>');
    const rel = path.slice('/repo/'.length);
    const candidates = rel === '' || rel.endsWith('/') ? [`${rel}index.html`] : [rel, `${rel}.html`];
    for (const candidate of candidates) {
      const file = join(root, 'site', candidate);
      if (existsSync(file) && statSync(file).isFile()) {
        return void res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
      }
    }
    res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>404</title>');
  });
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      /** @type {Promise<void>} */ (
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
      ),
  };
}

/**
 * @param {readonly CheckResult[]} checks
 * @param {string} id
 * @returns {CheckResult}
 */
const check = (checks, id) => /** @type {CheckResult} */ (checks.find((c) => c.id === id));

describe('siteFolderOf', () => {
  it('names the first folder of a page inside one, and none for a page at the top of its host', () => {
    expect(siteFolderOf(new URL('https://user.github.io/repo/'))).toBe('https://user.github.io/repo/');
    expect(siteFolderOf(new URL('https://user.github.io/repo/guide/start'))).toBe('https://user.github.io/repo/');
    expect(siteFolderOf(new URL('https://example.com/about'))).toBeUndefined();
    expect(siteFolderOf(new URL('https://example.com/'))).toBeUndefined();
  });
});

describe('a site in a folder of its host', () => {
  it('is generated with every URL in its folder and tested where it keeps its files', async () => {
    writeSite({
      'index.html': page('Acme docs', '<a href="about">About</a><a href="guide/">Guide</a>'),
      'about.html': page('About', ''),
      'guide/index.html': page('Guide', '<a href="../about">About</a>'),
    });
    const site = await host();
    try {
      const base = `${site.base}/repo`;
      const loaded = { root, exists: true, config: mergeConfig(defaultConfig(), { publicDir: 'site', generate: { source: 'files' } }) };
      const generated = await generateFromFiles({ loaded, origin: base });
      expect(generated.generate.pages.every((p) => p.status === 'written')).toBe(true);
      expect(existsSync(join(root, 'site', 'robots.txt'))).toBe(false);

      const home = await gatherEvidence(new URL(`${base}/`), { timeoutMs: 5000 });
      expect(home.llms.url).toBe(`${base}/llms.txt`);
      expect(home.sitemap.url).toBe(`${base}/sitemap.xml`);
      expect(home.twinUrl).toBe(`${base}/index.md`);
      expect(home.folder).toBe(`${base}/`);

      const { checks } = testEvidence(home);
      expect(check(checks, 'A2').status).toBe('pass');
      expect(check(checks, 'A3').status).toBe('pass');
      expect(check(checks, 'B1').status).toBe('pass');
      // robots.txt is the host's, and the fix says so rather than telling them to generate one.
      expect(check(checks, 'A1').status).toBe('fail');
      expect(check(checks, 'A1').fix).toContain(`this site lives in ${base}/`);

      const about = await gatherEvidence(new URL(`${base}/about`), { timeoutMs: 5000 });
      expect(about.twinUrl).toBe(`${base}/about.md`);
      expect(check(testEvidence(about).checks, 'B1').status).toBe('pass');
    } finally {
      await site.close();
    }
  });

  it('names both places it looked when neither has the file', async () => {
    writeSite({ 'index.html': page('Acme docs', '') });
    const site = await host();
    try {
      const evidence = await gatherEvidence(new URL(`${site.base}/repo/`), { timeoutMs: 5000 });
      const { checks } = testEvidence(evidence);
      expect(check(checks, 'A2').reason).toContain(`${site.base}/llms.txt or ${site.base}/repo/llms.txt`);
      expect(check(checks, 'A3').reason).toContain(`${site.base}/sitemap.xml or ${site.base}/repo/sitemap.xml`);
      // Nothing of the site's own was found in the folder, so A1 gives the usual fix.
      expect(check(checks, 'A1').fix).toContain('opengeo generate');
    } finally {
      await site.close();
    }
  });
});
