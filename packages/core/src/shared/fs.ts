import { existsSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface AtomicWriteOptions {
  /** The mode a newly created file gets. A file that already exists keeps the mode it has. */
  mode?: number;
}

/**
 * Write a whole file or nothing.
 *
 * writeFileSync truncates first and fills after, so a Ctrl-C, a full disk or a crash in between
 * leaves half a manifest or half a `.env`, and the next run reads that as "no manifest" or "no
 * key". The contents go to a temporary name in the same directory and are renamed over the target,
 * which is one step on the same filesystem: a reader sees the old file or the new one.
 *
 * Two things writeFileSync did are kept on purpose. A symlink is written through rather than
 * replaced, and an existing file keeps its mode, so a `.env` its owner locked down stays that way.
 */
export function writeFileAtomic(path: string, contents: string, options: AtomicWriteOptions = {}): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : (options.mode ?? 0o666);
  const temp = join(dir, `.${basename(target)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(temp, contents, { encoding: 'utf8', mode });
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Never created, or already renamed: either way there is nothing left to clean up.
    }
    throw error;
  }
}
