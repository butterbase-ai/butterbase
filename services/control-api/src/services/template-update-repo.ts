import { createHash } from 'node:crypto';
import { REWRITEABLE_EXTENSIONS } from './clone-replay.js';

export interface RepoManifestEntry { path: string; sha256: string; size: number }

function extOf(p: string): string {
  const name = p.toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot) : '';
}

/**
 * Replace every occurrence of `needle` in `buf` with `replacement`, operating
 * purely on bytes rather than round-tripping through a decoded string.
 *
 * A file with a "rewriteable" extension (.ts, .json, .svg, ...) is not
 * guaranteed to be valid UTF-8 end to end — e.g. a source map can carry a
 * base64/binary-ish payload, or a text file can embed a stray invalid byte
 * sequence outside the app-id occurrence we care about. `Buffer.toString('utf8')`
 * silently replaces any invalid sequence with U+FFFD, and converting that
 * string back to a Buffer bakes the corruption in permanently — even in
 * regions the rewrite never intended to touch. Searching/splicing at the
 * Buffer level replaces only the exact byte range of each match and leaves
 * every other byte in the file untouched, so no round trip risk exists.
 */
function replaceBytes(buf: Buffer, needle: Buffer, replacement: Buffer): Buffer {
  const parts: Buffer[] = [];
  let start = 0;
  let idx: number;
  while ((idx = buf.indexOf(needle, start)) !== -1) {
    parts.push(buf.subarray(start, idx));
    parts.push(replacement);
    start = idx + needle.length;
  }
  parts.push(buf.subarray(start));
  return Buffer.concat(parts);
}

export function rewriteBlob(
  content: Buffer, path: string, sourceAppId: string, destAppId: string,
): { content: Buffer; changed: boolean } {
  if (!REWRITEABLE_EXTENSIONS.has(extOf(path))) return { content, changed: false };

  const needle = Buffer.from(sourceAppId, 'utf8');
  if (!content.includes(needle)) return { content, changed: false };

  const replacement = Buffer.from(destAppId, 'utf8');
  const rewritten = replaceBytes(content, needle, replacement);
  return { content: rewritten, changed: true };
}

export async function rewriteManifestEntries(
  entries: RepoManifestEntry[],
  fetchBlob: (sha: string) => Promise<Buffer>,
  putBlob: (sha: string, content: Buffer) => Promise<void>,
  sourceAppId: string,
  destAppId: string,
): Promise<RepoManifestEntry[]> {
  const out: RepoManifestEntry[] = [];
  for (const e of entries) {
    const original = await fetchBlob(e.sha256);
    const { content, changed } = rewriteBlob(original, e.path, sourceAppId, destAppId);
    if (!changed) { out.push(e); continue; }
    const newSha = createHash('sha256').update(content).digest('hex');
    await putBlob(newSha, content);
    out.push({ path: e.path, sha256: newSha, size: content.length });
  }
  return out;
}
