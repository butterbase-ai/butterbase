import fs from 'fs-extra';
import path from 'path';
import { isIgnored } from './repo-ignore.js';
import type { Ignore } from 'ignore';
import { toPosixRelative, validateRelativePath } from './repo-paths.js';

export interface WalkedFile {
  /** Posix-style relative path from `root`. */
  relPath: string;
  /** Absolute filesystem path. */
  absPath: string;
  size: number;
}

/**
 * Async-iterate every non-ignored regular file under `root`.
 * Skips symlinks. Validates each path through validateRelativePath; throws on bad ones.
 */
export async function* walkRepo(root: string, ig: Ignore): AsyncGenerator<WalkedFile> {
  async function* recurse(dir: string): AsyncGenerator<WalkedFile> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    // Sorted for determinism (stable progress reporting, stable manifests in tests).
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toPosixRelative(path.relative(root, abs));
      // For directory ignore checks the `ignore` package expects a trailing slash.
      const probe = entry.isDirectory() ? `${rel}/` : rel;
      if (isIgnored(ig, probe)) continue;
      if (entry.isSymbolicLink()) continue;  // Skip symlinks — content semantics are ambiguous.
      if (entry.isDirectory()) {
        yield* recurse(abs);
        continue;
      }
      if (!entry.isFile()) continue;  // sockets, fifos, etc.
      validateRelativePath(rel);
      const st = await fs.stat(abs);
      yield { relPath: rel, absPath: abs, size: st.size };
    }
  }
  yield* recurse(root);
}
