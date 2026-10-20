import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERRORS, defaultConfig, fileToRoute, listLocalPages, loadConfig, mergeConfig, routeToTwinRelPath } from '@opengeo/core/shared';
import {
  SourceFilesError,
  canonicalOf,
  checkFreshness,
  chooseOrigin,
  generateFromFiles,
  parseFrontmatter,
  readManifest,
  resolveRoutes,
  staleCounts,
} from '@opengeo/core/generate';
import { generateCommand } from '../src/cli/commands/generate.js';
import { runCli } from '../src/cli/index.js';
import { readHomeStatus, plainStatus, statusRows } from '../src/cli/home.js';
import { readGeneratedFile } from '../src/server/api-files.js';
import { runGenerate } from '../src/server/api-generate.js';
import { readState } from '../src/server/api-settings.js';
/** @import { LoadedConfig } from '@opengeo/core/shared' */
/** @import { LocalPage } from '../src/shared/local-pages.js' */
/** @import { FreshnessReport } from '../src/shared/api-types.js' */

/**
 * A site that is a folder of HTML files, read without a server: `opengeo generate site/`.
 *
 * Everything here runs against real files in a temporary directory, because the parts that go wrong
 * are the parts a stub would hide: how a folder is walked, which file a host serves at a URL, where
 * the twin lands, and whether a file's date and contents still match the twin made from it.
 */

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opengeo-files-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/**
 * @param {string} title
 * @param {string} body
 * @param {string} [head]
 */
const page = (title, body, head = '') =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1>${body}</main></body></html>`;

const WORDS = '<p>Acme builds small, dependable tools for teams who would rather ship than configure, and has done so since 2019 from one office.</p>';

/**
 * Writes files under `root/<dir>`, creating folders as needed.
 *
 * @param {Record<string, string>} files
 * @param {string} [dir]
 */
function writeSite(files, dir = 'site') {
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

/**
 * @param {Partial<import('@opengeo/core/shared').OpenGeoConfig>} [patch]
 * @returns {LoadedConfig}
 */
function loaded(patch = {}) {
  return { root, exists: true, config: mergeConfig(defaultConfig(), { publicDir: 'site', generate: { source: 'files' }, ...patch }) };
}

/** Moves a file's dates forward, as saving it in an editor would. */
const later = (/** @type {string} */ path, /** @type {number} */ seconds) => {
  const when = new Date(Date.now() + seconds * 1000);
  utimesSync(path, when, when);
};

const SITE = {
  'index.html': page('Acme', `${WORDS}<a href="/about.html">About</a><a href="pricing.html">Pricing</a>`, '<link rel="canonical" href="https://acme.example/">'),
  'about.html': page('About', WORDS),
  'pricing.html': page('Pricing', `${WORDS}<p>Plans start at $12 a month.</p>`),
};

// -- listing -------------------------------------------------------------------------------------

describe('listLocalPages', () => {
  it('finds every page, home first, and leaves out what is never a page', () => {
    writeSite({
      'about.html': 'a',
      'index.html': 'i',
      'blog/index.htm': 'b',
      'blog/post.HTML': 'p',
      '.git/index.html': 'x',
      '_includes/header.html': 'x',
      'node_modules/pkg/readme.html': 'x',
      '404.html': 'x',
      'google1234abcd5678ef90.html': 'x',
      'style.css': 'x',
    });
    const listing = listLocalPages(join(root, 'site'));
    expect(listing.pages.map((p) => p.file)).toEqual(['index.html', 'about.html', 'blog/index.htm', 'blog/post.HTML']);
    expect(listing.skipped).toHaveLength(2);
    expect(listing.skipped[0]).toContain('404.html');
    expect(listing.capped).toBe(false);
  });

  it('never follows a symbolic link, which could lead out of the project', () => {
    writeSite({ 'index.html': 'i' });
    writeSite({ 'secret.html': 's' }, 'outside');
    symlinkSync(join(root, 'outside'), join(root, 'site', 'linked'));
    symlinkSync(join(root, 'outside', 'secret.html'), join(root, 'site', 'secret.html'));
    expect(listLocalPages(join(root, 'site')).pages.map((p) => p.file)).toEqual(['index.html']);
  });

  it('honours crawl.exclude by file path or by clean URL, and caps with the home page kept', () => {
    writeSite({ 'index.html': 'i', 'admin.html': 'a', 'admin/users.html': 'u', 'zeta.html': 'z', 'beta.html': 'b' });
    const excluded = listLocalPages(join(root, 'site'), { exclude: ['/admin'] });
    expect(excluded.pages.map((p) => p.file)).toEqual(['index.html', 'beta.html', 'zeta.html']);

    const capped = listLocalPages(join(root, 'site'), { maxPages: 2 });
    expect(capped.pages.map((p) => p.file)).toEqual(['index.html', 'admin.html']);
    expect(capped.capped).toBe(true);
  });

  it('does not walk into a directory it was told to skip', () => {
    writeSite({ 'index.html': 'i', 'cache/page.html': 'c' });
    expect(listLocalPages(join(root, 'site'), { skipDirs: [join(root, 'site', 'cache')] }).pages).toHaveLength(1);
  });
});

describe('fileToRoute and the beside layout', () => {
  it('serves an index file at its folder and any other page in either form', () => {
    expect(fileToRoute('index.html')).toBe('/');
    expect(fileToRoute('blog/index.htm')).toBe('/blog');
    expect(fileToRoute('about.html')).toBe('/about');
    expect(fileToRoute('about.html', 'file')).toBe('/about.html');
    expect(fileToRoute('docs/Getting Started.html', 'file')).toBe('/docs/Getting%20Started.html');
    // `#` and `?` are part of the name, not a fragment or a query.
    expect(fileToRoute('a#b?.html', 'file')).toBe('/a%23b%3F.html');
  });

  it('puts each twin beside its page, under the name a static host serves', () => {
    expect(routeToTwinRelPath('/', 'beside')).toBe('index.md');
    expect(routeToTwinRelPath('/about.html', 'beside')).toBe('about.html.md');
    expect(routeToTwinRelPath('/blog', 'beside')).toBe('blog.md');
    expect(routeToTwinRelPath('/docs/Getting%20Started.html', 'beside')).toBe('docs/Getting Started.html.md');
    // An encoded slash stays encoded: decoding it would write the twin into another folder.
    expect(routeToTwinRelPath('/a%2Fb.html', 'beside')).toBe('a%2Fb.html.md');
    expect(routeToTwinRelPath('/about', 'md')).toBe('md/about.md');
  });
});

// -- routes --------------------------------------------------------------------------------------

/**
 * @param {Record<string, string>} files
 * @param {string} [origin]
 */
function routesFor(files, origin = 'https://acme.example') {
  /** @type {LocalPage[]} */
  const pages = Object.keys(files).map((file) => ({ file, path: file, size: 1, mtimeMs: 0 }));
  return resolveRoutes(pages, new Map(Object.entries(files)), origin);
}

describe('resolveRoutes', () => {
  it('uses the file form when nothing links anywhere, since every host answers to it', () => {
    const { routes } = routesFor({ 'index.html': page('Home', ''), 'about.html': page('About', '') });
    expect(Object.fromEntries(routes)).toEqual({ 'index.html': '/', 'about.html': '/about.html' });
  });

  it('lets the site link its way to clean URLs, and applies the site majority to an unlinked page', () => {
    const { routes } = routesFor({
      'index.html': page('Home', '<a href="/about">About</a><a href="https://www.acme.example/pricing">Pricing</a>'),
      'about.html': page('About', ''),
      'pricing.html': page('Pricing', ''),
      'team.html': page('Team', ''),
    });
    expect(routes.get('about.html')).toBe('/about');
    expect(routes.get('pricing.html')).toBe('/pricing');
    expect(routes.get('team.html')).toBe('/team');
  });

  it('ignores links in comments and scripts, and links to other sites', () => {
    const { routes } = routesFor({
      'index.html': page('Home', '<!-- <a href="/about">old</a> --><script>"<a href=/about>"</script><a href="https://other.example/about">x</a>'),
      'about.html': page('About', ''),
    });
    expect(routes.get('about.html')).toBe('/about.html');
  });

  it('believes a canonical that names one of the page\'s own forms over every vote', () => {
    const { routes } = routesFor({
      'index.html': page('Home', '<a href="/about.html">About</a>'),
      'about.html': page('About', '', '<link rel="canonical" href="https://acme.example/about">'),
    });
    expect(routes.get('about.html')).toBe('/about');
  });

  it('takes a canonical that names an unknown address as a host rewrite, and warns about one naming another page', () => {
    const { routes, warnings } = routesFor({
      'index.html': page('Home', ''),
      'contact-us.html': page('Contact', '', '<link rel="canonical" href="/contact">'),
      'copy.html': page('Copy', '', '<link rel="canonical" href="/contact-us.html">'),
    });
    expect(routes.get('contact-us.html')).toBe('/contact');
    expect(routes.get('copy.html')).toBe('/copy.html');
    expect(warnings).toEqual([ERRORS.canonicalNotOwn('/contact-us.html', ['copy.html'], 'contact-us.html')]);
  });

  it('gives a shared URL to the file a host is likelier to serve, and says which file lost it', () => {
    const { routes, losers, warnings } = routesFor({
      'index.html': page('Home', '<a href="/pricing">Pricing</a>'),
      'about.html': page('About', ''),
      'about/index.html': page('About too', ''),
      'pricing.html': page('Pricing', ''),
    });
    expect(routes.get('about.html')).toBe('/about');
    expect(routes.has('about/index.html')).toBe(false);
    expect(losers.get('about/index.html')?.route).toBe('/about');
    expect(warnings).toContain(ERRORS.sameUrlFiles('about/index.html', 'about.html', '/about'));
  });
});

describe('canonicalOf and chooseOrigin', () => {
  it('reads the canonical href, but not one that is commented out', () => {
    expect(canonicalOf('<link href="https://a.example/x" rel="canonical">')).toBe('https://a.example/x');
    expect(canonicalOf('<!-- <link rel="canonical" href="https://old.example/"> -->')).toBeUndefined();
  });

  it('prefers the flag, then the config, then the site, then what the home page says, then warns', () => {
    const base = defaultConfig();
    const home = { file: 'index.html', html: '<link rel="canonical" href="https://acme.example/">' };
    expect(chooseOrigin('https://flag.example', { ...base, publicOrigin: 'https://config.example' }, home).origin).toBe('https://flag.example');
    expect(chooseOrigin(undefined, { ...base, publicOrigin: 'https://config.example' }, home).origin).toBe('https://config.example');
    expect(chooseOrigin(undefined, { ...base, site: 'https://site.example/start' }, home).origin).toBe('https://site.example');

    const declared = chooseOrigin(undefined, base, home);
    expect(declared.origin).toBe('https://acme.example');
    expect(declared.note).toBe(ERRORS.originFromCanonical('https://acme.example', 'index.html'));

    const unknown = chooseOrigin(undefined, base, { file: 'index.html', html: '<link rel="canonical" href="http://localhost:8080/">' });
    expect(unknown.origin).toBe('http://localhost:3000');
    expect(unknown.warning).toBe(ERRORS.filesOriginUnknown('http://localhost:3000'));
  });
});

// -- the pipeline --------------------------------------------------------------------------------

describe('generateFromFiles', () => {
  it('writes each twin beside its page and records the file it came from', async () => {
    writeSite(SITE);
    const result = await generateFromFiles({ loaded: loaded() });

    expect(result.source).toBe('files');
    expect(result.site).toBe('https://acme.example');
    expect(result.notes).toContain(ERRORS.originFromCanonical('https://acme.example', 'index.html'));
    expect(result.generate.pages.map((p) => [p.sourceFile, p.file, p.status])).toEqual([
      ['index.html', 'index.md', 'written'],
      ['about.html', 'about.html.md', 'written'],
      ['pricing.html', 'pricing.html.md', 'written'],
    ]);
    const twin = parseFrontmatter(readFileSync(join(root, 'site', 'pricing.html.md'), 'utf8'));
    expect(twin.data.url).toBe('https://acme.example/pricing.html');
    expect(twin.body).toContain('$12 a month');
    expect(existsSync(join(root, 'site', 'md'))).toBe(false);

    const manifest = readManifest(join(root, '.opengeo'));
    expect(manifest.source).toBe('files');
    const entry = manifest.pages['/about.html'];
    expect(entry?.sourceFile).toBe('about.html');
    expect(entry?.file).toBe('about.html.md');
    expect(typeof entry?.sourceFileHash).toBe('string');
    expect(typeof entry?.sourceModified).toBe('string');

    expect(readFileSync(join(root, 'site', 'sitemap.xml'), 'utf8')).toContain('<loc>https://acme.example/about.html</loc>');
    const llms = readFileSync(join(root, 'site', 'llms.txt'), 'utf8');
    expect(llms).toContain('https://acme.example/about.html.md');
    // A static host does not negotiate, so llms.txt must not promise it does.
    expect(llms).not.toContain('Accept: text/markdown');
  });

  it('changes nothing on a second run, and a touched file keeps its recorded date', async () => {
    writeSite(SITE);
    await generateFromFiles({ loaded: loaded() });
    const twin = readFileSync(join(root, 'site', 'about.html.md'), 'utf8');
    const before = readManifest(join(root, '.opengeo')).pages['/about.html'];

    later(join(root, 'site', 'about.html'), 60);
    const again = await generateFromFiles({ loaded: loaded() });
    expect(again.generate.pages.every((p) => p.status === 'cached')).toBe(true);
    expect(readFileSync(join(root, 'site', 'about.html.md'), 'utf8')).toBe(twin);
    expect(readManifest(join(root, '.opengeo')).pages['/about.html']?.sourceModified).toBe(before?.sourceModified);
  });

  it('regenerates one file and keeps every other page in the manifest', async () => {
    writeSite(SITE);
    await generateFromFiles({ loaded: loaded() });
    writeFileSync(join(root, 'site', 'about.html'), page('About', `${WORDS}<p>Now four people.</p>`));

    const one = await generateFromFiles({ loaded: loaded(), file: 'about.html' });
    expect(one.single).toBe(true);
    expect(one.generate.pages.map((p) => [p.sourceFile, p.status])).toEqual([['about.html', 'written']]);
    expect(Object.keys(readManifest(join(root, '.opengeo')).pages).sort()).toEqual(['/', '/about.html', '/pricing.html']);
    expect(readFileSync(join(root, 'site', 'about.html.md'), 'utf8')).toContain('Now four people.');
  });

  it('refuses a missing folder, an empty one, and a file that is not one of its pages', async () => {
    await expect(generateFromFiles({ loaded: loaded() })).rejects.toThrow(SourceFilesError);
    mkdirSync(join(root, 'site'));
    await expect(generateFromFiles({ loaded: loaded() })).rejects.toThrow(/no HTML|\.html/i);
    writeSite(SITE);
    await expect(generateFromFiles({ loaded: loaded(), file: 'nope.html' })).rejects.toThrow(SourceFilesError);
  });

  it('never overwrites a twin somebody else wrote', async () => {
    writeSite({ ...SITE, 'about.html.md': '# My own notes about this page\n' });
    const result = await generateFromFiles({ loaded: loaded() });
    expect(result.generate.pages.find((p) => p.sourceFile === 'about.html')?.status).toBe('proposed');
    expect(readFileSync(join(root, 'site', 'about.html.md'), 'utf8')).toBe('# My own notes about this page\n');
    expect(existsSync(join(root, 'site', 'about.html.md.opengeo-proposed'))).toBe(true);
  });

  it('warns about Jekyll on what looks like GitHub Pages, and not once .nojekyll is there', async () => {
    writeSite({ ...SITE, CNAME: 'acme.example\n' });
    const result = await generateFromFiles({ loaded: loaded() });
    expect(result.notes?.some((note) => note.includes('.nojekyll'))).toBe(true);

    writeFileSync(join(root, 'site', '.nojekyll'), '');
    const quiet = await generateFromFiles({ loaded: loaded() });
    expect(quiet.notes?.some((note) => note.includes('.nojekyll'))).toBe(false);
  });
});

// -- freshness -----------------------------------------------------------------------------------

describe('checkFreshness', () => {
  it('has nothing to say about a project that crawls', () => {
    expect(checkFreshness({ root, config: defaultConfig() })).toBeUndefined();
  });

  it('reports every kind of out of date, and none for a file that was only touched', async () => {
    writeSite({ ...SITE, 'team.html': page('Team', WORDS), 'notes.html': page('Notes', WORDS) });
    // A hand-written twin, which generate records and never rewrites.
    writeSite({ 'notes.html.md': '---\ntitle: Notes\ngenerated_by: manual\n---\n\n# Notes\n' });
    await generateFromFiles({ loaded: loaded() });
    expect(checkFreshness(loaded())).toEqual({ checked: 5, stale: [] });

    later(join(root, 'site', 'index.html'), 120);
    writeFileSync(join(root, 'site', 'about.html'), page('About', `${WORDS}<p>Moved offices.</p>`));
    later(join(root, 'site', 'about.html'), 120);
    rmSync(join(root, 'site', 'team.html'));
    writeFileSync(join(root, 'site', 'careers.html'), page('Careers', WORDS));
    later(join(root, 'site', 'notes.html'), 120);

    const report = /** @type {FreshnessReport} */ (checkFreshness(loaded()));
    expect(report.stale.map((twin) => [twin.sourceFile, twin.kind])).toEqual([
      ['about.html', 'changed'],
      ['careers.html', 'new'],
      ['notes.html', 'manual'],
      ['team.html', 'missing'],
    ]);
    expect(report.stale[0]?.message).toContain('after its twin about.html.md was written');
    expect(staleCounts(report)).toEqual({ changed: 1, manual: 1, missing: 1, new: 1 });

    await generateFromFiles({ loaded: loaded(), prune: true });
    expect(checkFreshness(loaded())?.stale.map((twin) => twin.kind)).toEqual(['manual']);
  });

  it('gives both times their seconds when the page changed in the same minute its twin was written', async () => {
    writeSite(SITE);
    await generateFromFiles({ loaded: loaded() });
    const written = Date.parse(readManifest(join(root, '.opengeo')).pages['/about.html']?.lastUpdated ?? '');
    writeFileSync(join(root, 'site', 'about.html'), page('About', `${WORDS}<p>Moved offices.</p>`));
    // The same minute as the twin, two seconds after it, or the next minute when that would cross.
    const when = new Date(new Date(written).getSeconds() < 57 ? written + 2000 : written + 61_000);
    utimesSync(join(root, 'site', 'about.html'), when, when);
    const [stale] = checkFreshness(loaded())?.stale ?? [];
    const sameMinute = new Date(written).getMinutes() === when.getMinutes();
    expect(stale?.message).toMatch(sameMinute ? /modified \S+ \d\d:\d\d:\d\d, after its twin about\.html\.md was written \S+ \d\d:\d\d:\d\d/ : /modified \S+ \d\d:\d\d,/);
  });

  it('does not trust a manifest that points outside the web root', async () => {
    writeSite(SITE);
    await generateFromFiles({ loaded: loaded() });
    const path = join(root, '.opengeo', 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.pages['/about.html'].sourceFile = '../../etc/passwd';
    writeFileSync(path, JSON.stringify(manifest));
    expect(checkFreshness(loaded())?.checked).toBe(2);
  });
});

// -- the command line ----------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {Promise<{ code: number; stdout: string; stderr: string }>}
 */
async function cli(argv) {
  let stdout = '';
  let stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const code = await runCli({ packageName: 'opengeo', version: '0.0.0-test', commands: { generate: generateCommand }, argv: ['generate', ...argv] });
    // eslint-disable-next-line no-control-regex
    const plain = (/** @type {string} */ text) => text.replace(/\x1b\[[0-9;]*m/g, '');
    return { code, stdout: plain(stdout), stderr: plain(stderr) };
  } finally {
    vi.restoreAllMocks();
  }
}

describe('opengeo generate <folder>', () => {
  it('reads the folder, writes the twins beside the pages, and creates the config that remembers it', async () => {
    writeSite(SITE);
    const { code, stdout } = await cli([join(root, 'site'), '--project', root]);
    expect(code).toBe(0);
    expect(stdout).toContain('about.html.md');
    expect(stdout).toContain('Links name: https://acme.example');
    const saved = loadConfig(root);
    expect(saved.exists).toBe(true);
    expect(saved.config.publicDir).toBe('site');
    expect(saved.config.generate.source).toBe('files');

    // Remembered: no positional now reads the same folder.
    const again = await cli(['--project', root, '--json']);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ source: 'files', site: 'https://acme.example' });
  });

  it('leaves no config behind when the folder holds no pages', async () => {
    mkdirSync(join(root, 'site'));
    const { code, stderr } = await cli([join(root, 'site'), '--project', root]);
    expect(code).toBe(2);
    expect(stderr).toContain(ERRORS.noHtmlFiles(join(root, 'site')));
    expect(loadConfig(root).exists).toBe(false);
  });

  it('refuses the project root itself, since the web root would then hold .env', async () => {
    writeSite(SITE, '.');
    const { code, stderr } = await cli([root, '--project', root]);
    expect(code).toBe(2);
    expect(stderr).toContain('cd .. && opengeo generate');
  });

  it('refuses a folder outside the project, and one that is not the configured web root', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'opengeo-elsewhere-'));
    try {
      expect((await cli([elsewhere, '--project', root])).stderr).toContain(ERRORS.filesOutsideProject(elsewhere, root));
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }

    writeSite(SITE);
    writeSite(SITE, 'public');
    writeFileSync(join(root, 'opengeo.config.json'), JSON.stringify({ site: 'https://acme.example', publicDir: 'public' }));
    const mismatch = await cli([join(root, 'site'), '--project', root]);
    expect(mismatch.code).toBe(2);
    expect(mismatch.stderr).toContain(ERRORS.filesWebRootMismatch(join(root, 'site'), join(root, 'public')));
  });

  it('says what each wrong kind of argument should have been', async () => {
    writeSite({ ...SITE, 'style.css': 'body{}' });
    expect((await cli([join(root, 'site', 'style.css'), '--project', root])).stderr).toContain(ERRORS.notAPageFile(join(root, 'site', 'style.css')));
    expect((await cli([join(root, 'site', 'about.html'), '--project', root])).stderr).toContain(
      ERRORS.filesSingleNeedsSite(join(root, 'site', 'about.html')),
    );
    expect((await cli([join(root, 'site'), '--single', '--project', root])).stderr).toContain(ERRORS.filesSingleNeedsPage(join(root, 'site')));
    expect((await cli(['acme.example', '--project', root])).stderr).toContain(ERRORS.notUrlOrFolder('acme.example'));
    expect((await cli(['acme.example', '--project', root])).stderr).toContain('https://acme.example');
    expect((await cli(['localhost:8080', '--project', root])).stderr).toContain('http://localhost:8080');
  });

  it('regenerates one page by its file name once the folder is configured', async () => {
    writeSite(SITE);
    await cli([join(root, 'site'), '--project', root]);
    writeFileSync(join(root, 'site', 'about.html'), page('About', `${WORDS}<p>Moved offices.</p>`));
    writeFileSync(join(root, 'site', 'pricing.html'), page('Pricing', `${WORDS}<p>Plans start at $15.</p>`));
    later(join(root, 'site', 'pricing.html'), 120);

    const { code, stdout } = await cli([join(root, 'site', 'about.html'), '--project', root]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/written about\.html/);
    expect(stdout).toContain('1 other page is out of date.');
  });

  it('saves a bare --origin as an https origin, and refuses one with a path', async () => {
    writeSite({ 'index.html': page('Home', WORDS), 'about.html': page('About', WORDS) });
    const first = await cli([join(root, 'site'), '--project', root, '--origin', 'acme.test']);
    expect(first.code).toBe(0);
    expect(loadConfig(root).config.publicOrigin).toBe('https://acme.test');
    expect(readFileSync(join(root, 'site', 'about.html.md'), 'utf8')).toContain('https://acme.test/about.html');

    const bad = await cli([join(root, 'site'), '--project', root, '--origin', 'https://user.github.io/project']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain(ERRORS.badOrigin('https://user.github.io/project'));
    expect((await cli([join(root, 'site'), '--project', root, '--origin', 'intranet'])).code).toBe(2);
  });
});

describe('opengeo generate --check', () => {
  it('exits 0 when every twin matches, 1 when one does not, and 2 for a crawled site', async () => {
    writeSite(SITE);
    await cli([join(root, 'site'), '--project', root]);

    const clean = await cli(['--check', '--project', root]);
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain('All 3 twins match their pages.');

    writeFileSync(join(root, 'site', 'pricing.html'), page('Pricing', `${WORDS}<p>Plans start at $15.</p>`));
    later(join(root, 'site', 'pricing.html'), 120);
    const stale = await cli(['--check', '--project', root]);
    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain('pricing.html');

    const json = await cli(['--check', '--json', '--project', root]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout).stale.map((/** @type {{ kind: string }} */ twin) => twin.kind)).toEqual(['changed']);

    // Nothing is written by a check, so it is still stale afterwards.
    expect((await cli(['--check', '--project', root])).code).toBe(1);

    const crawled = await cli(['https://acme.example', '--check', '--project', root]);
    expect(crawled.code).toBe(2);
    expect(crawled.stderr).toContain(ERRORS.checkNeedsFiles);
  });

  it('asks for a first run before there is anything to compare', async () => {
    writeSite(SITE);
    const { code, stderr } = await cli([join(root, 'site'), '--check', '--project', root]);
    expect(code).toBe(2);
    expect(stderr).toContain(ERRORS.checkBeforeGenerate(join(root, 'site')));
  });
});

// -- the dashboard and the home screen -----------------------------------------------------------

describe('the dashboard on a folder project', () => {
  const options = () => ({ root, version: '0.0.0-test', packageName: 'opengeo' });

  it('generates from the folder, not the configured URL, and reports the freshness in the state', async () => {
    writeSite(SITE);
    writeFileSync(join(root, 'opengeo.config.json'), JSON.stringify({ site: 'http://localhost:9', publicDir: 'site', generate: { source: 'files' } }));

    const response = await runGenerate({}, options());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ source: 'files', site: 'https://acme.example' });

    const state = readState(options());
    expect(state.freshness).toEqual({ checked: 3, stale: [] });
    expect(state.manifest?.source).toBe('files');
    expect(state.manifest?.pages.find((p) => p.route === '/about.html')).toMatchObject({ file: 'about.html.md', sourceFile: 'about.html' });

    writeFileSync(join(root, 'site', 'careers.html'), page('Careers', WORDS));
    expect(readState(options()).freshness?.stale.map((twin) => twin.kind)).toEqual(['new']);
  });

  it('turns a folder problem into a 400 with the message, and refuses a file on a crawled project', async () => {
    writeFileSync(join(root, 'opengeo.config.json'), JSON.stringify({ site: 'http://localhost:9', publicDir: 'site', generate: { source: 'files' } }));
    mkdirSync(join(root, 'site'));
    const empty = await runGenerate({}, options());
    expect(empty.status).toBe(400);
    expect(JSON.stringify(empty.body)).toContain('site');

    writeFileSync(join(root, 'opengeo.config.json'), JSON.stringify({ site: 'http://localhost:9' }));
    expect((await runGenerate({ file: 'about.html' }, options())).status).toBe(400);
  });

  it('reads back a twin the manifest lists beside its page, and never somebody else\'s markdown', async () => {
    writeSite({ ...SITE, 'README.md': '# private notes' });
    writeFileSync(join(root, 'opengeo.config.json'), JSON.stringify({ publicDir: 'site', generate: { source: 'files' } }));
    await runGenerate({}, options());

    expect(readGeneratedFile(root, 'about.html.md')).toContain('About');
    expect(readGeneratedFile(root, 'README.md')).toBeUndefined();
    expect(readGeneratedFile(root, '../opengeo.config.json')).toBeUndefined();
  });
});

describe('the home screen on a folder project', () => {
  it('names the folder, counts what is out of date, and launches generate with no URL', async () => {
    writeSite(SITE);
    writeFileSync(join(root, 'opengeo.config.json'), JSON.stringify({ publicDir: 'site', generate: { source: 'files' } }));
    await generateFromFiles({ loaded: loadConfig(root) });

    const fresh = readHomeStatus(root);
    expect(fresh).toMatchObject({ folder: 'site', stale: 0, twins: 3 });
    // The localhost default is not a site anybody can visit.
    expect(fresh.site).toBeUndefined();

    writeFileSync(join(root, 'site', 'careers.html'), page('Careers', WORDS));
    const behind = readHomeStatus(root);
    expect(behind.stale).toBe(1);
    expect(statusRows(behind, 120).join('\n')).toContain('1 out of date');
    expect(plainStatus(behind).join('\n')).toContain('3 pages from site/, 1 out of date');
  });
});
