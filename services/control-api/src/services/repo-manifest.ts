import { z } from 'zod';
import { createHash } from 'crypto';

export const REPO_TOTAL_BYTES_LIMIT = 100 * 1024 * 1024;  // 100 MB
export const REPO_FILE_BYTES_LIMIT = 10 * 1024 * 1024;    // 10 MB
export const REPO_MAX_PATH_BYTES = 4096;
export const REPO_RETAIN_SNAPSHOTS = 5;

// sha256 hex string (lowercase, 64 chars)
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

const fileEntrySchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(SHA256_HEX_RE),
  size: z.number().int().nonnegative(),
  mode: z.number().int().optional(),
});

export const manifestInputSchema = z.object({
  files: z.array(fileEntrySchema).max(50_000),
  message: z.string().max(1000).optional(),
});

export type ManifestInput = z.infer<typeof manifestInputSchema>;
export type FileEntry = z.infer<typeof fileEntrySchema>;

export interface ValidatedManifest {
  snapshotId: string;
  files: FileEntry[];
  message?: string;
  totalBytes: number;
  canonicalJson: string;
}

export class RepoManifestError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'RepoManifestError';
  }
}

export function validateRelativePath(p: string): void {
  if (p.length === 0) throw new RepoManifestError('repo_path_empty', 'Path is empty');
  if (Buffer.byteLength(p, 'utf8') > REPO_MAX_PATH_BYTES) {
    throw new RepoManifestError('repo_path_too_long', `Path exceeds ${REPO_MAX_PATH_BYTES} bytes: ${p}`);
  }
  if (p.startsWith('/')) throw new RepoManifestError('repo_path_absolute', `Path is absolute: ${p}`);
  if (p.includes('\\')) throw new RepoManifestError('repo_path_backslash', `Path contains backslash: ${p}`);
  if (p.includes('\0')) throw new RepoManifestError('repo_path_null_byte', `Path contains null byte`);
  const segs = p.split('/');
  for (const seg of segs) {
    if (seg === '..') throw new RepoManifestError('repo_path_traversal', `Path contains '..': ${p}`);
    if (seg === '.') throw new RepoManifestError('repo_path_dot_segment', `Path contains '.' segment: ${p}`);
    if (seg.length === 0) throw new RepoManifestError('repo_path_empty_segment', `Path has empty segment: ${p}`);
  }
}

function canonicalize(files: FileEntry[], message: string | undefined): string {
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const normalized = sorted.map(f => f.mode === undefined
    ? { path: f.path, sha256: f.sha256, size: f.size }
    : { path: f.path, sha256: f.sha256, size: f.size, mode: f.mode });
  const payload: Record<string, unknown> = { v: 1, files: normalized };
  if (message !== undefined) payload.message = message;
  return JSON.stringify(payload);
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function validateManifest(input: unknown): ValidatedManifest {
  const parsed = manifestInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new RepoManifestError('repo_manifest_invalid', 'Manifest schema invalid', parsed.error.errors);
  }
  const { files, message } = parsed.data;

  const seenPaths = new Set<string>();
  let total = 0;
  for (const f of files) {
    validateRelativePath(f.path);
    if (seenPaths.has(f.path)) {
      throw new RepoManifestError('repo_path_duplicate', `Duplicate path: ${f.path}`);
    }
    seenPaths.add(f.path);
    if (f.size > REPO_FILE_BYTES_LIMIT) {
      throw new RepoManifestError('repo_file_too_large',
        `File exceeds ${REPO_FILE_BYTES_LIMIT} bytes: ${f.path} (${f.size} bytes)`,
        { path: f.path, size: f.size, limit: REPO_FILE_BYTES_LIMIT });
    }
    total += f.size;
  }
  if (total > REPO_TOTAL_BYTES_LIMIT) {
    throw new RepoManifestError('repo_too_large',
      `Total manifest size ${total} exceeds ${REPO_TOTAL_BYTES_LIMIT}`,
      { totalBytes: total, limit: REPO_TOTAL_BYTES_LIMIT });
  }

  const canonicalJson = canonicalize(files, message);
  const snapshotId = sha256Hex(canonicalJson);

  return { snapshotId, files, message, totalBytes: total, canonicalJson };
}

export function blobsReferenced(files: FileEntry[]): Set<string> {
  return new Set(files.map(f => f.sha256));
}
