import fs from 'fs-extra';
import { createHash } from 'crypto';
import type { FileEntry } from './repo-api.js';
import type { WalkedFile } from './repo-walk.js';

/**
 * Read every file's bytes and compute its sha256. Returns FileEntry[] suitable for
 * /repo/snapshots/prepare. Caller is responsible for any progress UX — this is a tight loop.
 *
 * Concurrency is intentionally serial: a typical repo is small (100 MB cap) and parallel
 * file reads on cold disk are not necessarily faster. Tighten later if profiling shows
 * a hot path.
 */
export async function buildManifest(files: WalkedFile[]): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for (const f of files) {
    const buf = await fs.readFile(f.absPath);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    if (buf.byteLength !== f.size) {
      // The stat said one thing, the read returned another — likely a concurrent writer.
      // Surface this rather than committing inconsistent metadata.
      throw new Error(`File size changed during read: ${f.relPath} (stat=${f.size}, read=${buf.byteLength})`);
    }
    out.push({ path: f.relPath, sha256, size: buf.byteLength });
  }
  return out;
}
