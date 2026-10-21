import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readManifestChecked, writeManifest, emptyManifest } from '@opengso/core/generate';
import { describeFsError, writeFileAtomic } from '@opengso/core/shared';

// Windows has no POSIX permission bits: Node reports 0o666 for any writable file whatever was asked.
const posixModes = process.platform !== 'win32';

/**
 * What a write leaves behind when it is interrupted.
 *
 * A plain writeFileSync truncates the file first and fills it after, so a Ctrl-C, a full disk or a
 * crash in between leaves half a manifest or half a .env. Every file OpenGSO owns is written to a
 * temporary name beside it and renamed over the original, which the filesystem does in one step:
 * a reader sees the old file or the new one, never a mixture.
 */

const dir = () => mkdtempSync(join(tmpdir(), 'opengso-atomic-'));

describe('writeFileAtomic', () => {
  it('writes the file, creating its directory, and leaves no temporary file behind', () => {
    const root = dir();
    const path = join(root, 'nested', 'file.json');
    writeFileAtomic(path, '{"a":1}\n');
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n');
    expect(readdirSync(join(root, 'nested'))).toEqual(['file.json']);
  });

  it.runIf(posixModes)('creates a new file with the mode asked for, and keeps the mode of one that exists', () => {
    const root = dir();
    const fresh = join(root, 'fresh');
    writeFileAtomic(fresh, 'x', { mode: 0o600 });
    expect(statSync(fresh).mode & 0o777).toBe(0o600);

    const owned = join(root, 'owned');
    writeFileSync(owned, 'old');
    chmodSync(owned, 0o640);
    writeFileAtomic(owned, 'new', { mode: 0o600 });
    expect(readFileSync(owned, 'utf8')).toBe('new');
    expect(statSync(owned).mode & 0o777).toBe(0o640);
  });

  it('writes through a symlink instead of replacing it', () => {
    const root = dir();
    const real = join(root, 'real.env');
    const link = join(root, 'link.env');
    writeFileSync(real, 'old');
    symlinkSync(real, link);
    writeFileAtomic(link, 'new');
    expect(readFileSync(real, 'utf8')).toBe('new');
  });

  it('leaves the original whole and cleans up when the write cannot finish', () => {
    const root = dir();
    const path = join(root, 'target');
    // A directory where the file should be: the rename is refused after the temporary file exists.
    mkdirSync(path);
    writeFileSync(join(path, 'keep'), 'k');
    expect(() => writeFileAtomic(path, 'new')).toThrow();
    expect(readdirSync(root)).toEqual(['target']);
    expect(readFileSync(join(path, 'keep'), 'utf8')).toBe('k');
  });
});

describe('reading a manifest that is not usable', () => {
  it('is no problem when there is none yet', () => {
    expect(readManifestChecked(dir(), 'https://e.com').problem).toBeUndefined();
  });

  it('says why when the file is not valid JSON', () => {
    const root = dir();
    writeFileSync(join(root, 'manifest.json'), '{"version":1,"pages":{"/":');
    const read = readManifestChecked(root, 'https://e.com');
    expect(read.manifest.pages).toEqual({});
    expect(read.problem).toContain(join(root, 'manifest.json'));
  });

  it('says why when the file is from another manifest version', () => {
    const root = dir();
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ version: 99, pages: {} }));
    expect(readManifestChecked(root, 'https://e.com').problem).toMatch(/version/i);
  });

  it('reads back what writeManifest wrote', () => {
    const root = dir();
    const manifest = emptyManifest('https://e.com');
    writeManifest(root, manifest);
    expect(readManifestChecked(root, 'https://e.com')).toEqual({ manifest });
  });
});

describe('describeFsError', () => {
  it('names the file that was asked for, never the staging file, when an atomic write fails', () => {
    if (!posixModes || process.getuid?.() === 0) return;
    const root = dir();
    const locked = join(root, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      /** @type {unknown} */
      let caught;
      try {
        writeFileAtomic(join(locked, 'robots.txt'), 'x');
      } catch (error) {
        caught = error;
      }
      expect(describeFsError(caught, root)).toBe('no permission to write locked/robots.txt');
      expect(readdirSync(locked)).toEqual([]);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('points at the file that is where a folder should be', () => {
    const root = dir();
    writeFileSync(join(root, 'public'), 'not a folder');
    /** @type {unknown} */
    let caught;
    try {
      mkdirSync(join(root, 'public', 'md', 'deep'), { recursive: true });
    } catch (error) {
      caught = error;
    }
    expect(describeFsError(caught, root)).toBe('public is a file, not a folder, so nothing can be written under it');
  });

  it('leaves anything that is not a filesystem error alone', () => {
    expect(describeFsError(new Error('the provider said no'))).toBe('the provider said no');
    expect(describeFsError('plain string')).toBe('plain string');
  });
});
