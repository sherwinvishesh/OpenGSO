import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_PACKAGES,
  contentHash,
  commandUnavailable,
  defaultConfig,
  ensureEnvGitignored,
  estimateTokens,
  isCI,
  loadConfig,
  mergeConfig,
  normalizeForHash,
  normalizeRoute,
  routeToMdRelPath,
  routeToTwinUrlPath,
  saveConfig,
  twinUrl,
  twinUrlPathToRoute,
  ERRORS,
  unknownCommand,
} from '@opengeo/core/shared';
import { parseFrontmatter, serializeFrontmatter, withFrontmatter } from '@opengeo/core/generate';

const temp = () => mkdtempSync(join(tmpdir(), 'opengeo-test-'));

describe('routes', () => {
  it('normalises paths to a canonical route', () => {
    expect(normalizeRoute('/')).toBe('/');
    expect(normalizeRoute('')).toBe('/');
    expect(normalizeRoute('about')).toBe('/about');
    expect(normalizeRoute('/about/')).toBe('/about');
    expect(normalizeRoute('//blog//post//')).toBe('/blog/post');
  });

  it('maps a route to its file and its twin URL', () => {
    expect(routeToMdRelPath('/')).toBe('md/index.md');
    expect(routeToMdRelPath('/resume')).toBe('md/resume.md');
    expect(routeToMdRelPath('/blog/post')).toBe('md/blog/post.md');
    expect(routeToTwinUrlPath('/')).toBe('/index.md');
    expect(routeToTwinUrlPath('/resume')).toBe('/resume.md');
  });

  it('reverses both the canonical twin URL and a direct hit on the on-disk path', () => {
    expect(twinUrlPathToRoute('/resume.md')).toBe('/resume');
    expect(twinUrlPathToRoute('/md/resume.md')).toBe('/resume');
    expect(twinUrlPathToRoute('/index.md')).toBe('/');
    expect(twinUrlPathToRoute('/md/index.md')).toBe('/');
    expect(twinUrlPathToRoute('/resume')).toBeUndefined();
  });

  it('builds an absolute twin URL without query or hash', () => {
    expect(twinUrl('https://example.com/resume?utm=x#top')).toBe('https://example.com/resume.md');
  });
});

describe('tokens and hashing', () => {
  it('estimates tokens from words and never returns zero', () => {
    expect(estimateTokens('one two three four five')).toBe(7);
    expect(estimateTokens('')).toBe(1);
  });

  it('ignores cosmetic whitespace changes so a reflow does not force a paid regeneration', () => {
    expect(normalizeForHash('  a   b\t\tc\n\n\n\nd  ')).toBe('a b c\n\nd');
    expect(contentHash('a   b')).toBe(contentHash('a b'));
    expect(contentHash('a b c')).not.toBe(contentHash('a b d'));
    expect(contentHash('x')).toHaveLength(16);
  });
});

describe('frontmatter', () => {
  it('round-trips the values OpenGEO actually writes', () => {
    const data = {
      title: 'A "quoted" title',
      url: 'https://example.com/resume',
      last_updated: '2026-01-01T00:00:00.000Z',
      tokens: 412,
      source_hash: 'abc123',
      generated_by: 'opengeo-free',
      tags: ['one', 'two'],
      draft: false,
    };
    const parsed = parseFrontmatter(withFrontmatter(data, '# Body\n\nText.'));
    expect(parsed.data).toEqual(data);
    expect(parsed.body.trim()).toBe('# Body\n\nText.');
    expect(parsed.hasFrontmatter).toBe(true);
  });

  it('treats a file with no frontmatter as all body', () => {
    const parsed = parseFrontmatter('# Just markdown');
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.body).toBe('# Just markdown');
  });

  it('writes a block that starts and ends with the fence', () => {
    expect(serializeFrontmatter({ a: 1 })).toBe('---\na: 1\n---\n');
  });
});

describe('config', () => {
  it('defaults to routing every routable bot and blocking none', () => {
    const config = defaultConfig();
    expect(config.bots.blocked).toEqual([]);
    expect(config.bots.markdownRouting.length).toBeGreaterThan(10);
    expect(config.generate.tier).toBe('free');
  });

  it('merges a partial file over the defaults section by section', () => {
    const merged = mergeConfig(defaultConfig(), { crawl: { maxPages: 5 } as never });
    expect(merged.crawl.maxPages).toBe(5);
    expect(merged.crawl.maxDepth).toBe(4);
  });

  it('round-trips through disk and reports where the project root is', () => {
    const root = temp();
    const config = defaultConfig('https://example.com');
    saveConfig(root, config);
    const loaded = loadConfig(root);
    expect(loaded.exists).toBe(true);
    expect(loaded.root).toBe(root);
    expect(loaded.config.site).toBe('https://example.com');
  });

  it('falls back to defaults when there is no config anywhere above the directory', () => {
    const loaded = loadConfig('/');
    expect(loaded.exists).toBe(false);
    expect(loaded.config.site).toBe('http://localhost:3000');
  });
});

describe('API key handling (§11)', () => {
  it('adds .env to .gitignore, which is the actual leak-prevention mechanism', () => {
    const root = temp();
    writeFileSync(join(root, '.gitignore'), 'node_modules\n', 'utf8');
    const result = ensureEnvGitignored(root);
    expect(result.added).toBe(true);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.env');
    expect(ensureEnvGitignored(root).alreadyPresent).toBe(true);
  });

  it('creates a .gitignore when the project has none', () => {
    const root = temp();
    ensureEnvGitignored(root);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.env');
  });

  it('detects CI, which is what gates every AI-touched feature', () => {
    expect(isCI({ CI: 'true' })).toBe(true);
    expect(isCI({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(isCI({})).toBe(false);
  });
});

describe('error copy (§13)', () => {
  it('names the narrow package and the full one when a command is missing', () => {
    const message = commandUnavailable('generate', 'opengeo-testing');
    expect(message).toContain('npm install -D opengeo-generate');
    expect(message).toContain('npm install -D opengeo-cli');
    expect(message).toContain('opengeo-testing');
  });

  it('lists only the commands this install can actually run', () => {
    expect(unknownCommand('publish', ['test'])).toContain('opengeo test');
  });

  it('explains why OpenGEO wants a URL rather than a directory', () => {
    expect(ERRORS.missingUrl('test')).toContain('never a source directory');
  });

  it('explains the CI block as deliberate rather than a failure', () => {
    expect(ERRORS.ciBlocked('The AI tier')).toContain('human review');
  });

  it('keeps the command-to-package table honest', () => {
    for (const packages of Object.values(COMMAND_PACKAGES)) {
      expect(packages).toContain('opengeo');
    }
  });
});
