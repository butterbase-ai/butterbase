import { describe, it, expect } from 'vitest';
import {
  validateManifest,
  validateRelativePath,
  RepoManifestError,
  REPO_FILE_BYTES_LIMIT,
  REPO_TOTAL_BYTES_LIMIT,
  blobsReferenced,
} from './repo-manifest.js';

const sha = (n: number) => n.toString(16).padStart(64, '0');

describe('validateRelativePath', () => {
  for (const bad of ['', '/abs', '..', 'a/../b', './a', 'a/.', 'back\\slash', 'null\0byte']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => validateRelativePath(bad)).toThrow(RepoManifestError);
    });
  }
  it('rejects > 4 KB path', () => {
    try {
      validateRelativePath('a/'.repeat(2100));
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RepoManifestError);
      expect((err as RepoManifestError).code).toBe('repo_path_too_long');
    }
  });
  for (const ok of ['a', 'src/index.ts', 'deep/nested/dir/file.tsx', 'with-dash_and.dot/x']) {
    it(`accepts ${JSON.stringify(ok)}`, () => {
      expect(() => validateRelativePath(ok)).not.toThrow();
    });
  }
});

describe('validateManifest', () => {
  it('hashes the same tree to the same snapshot id regardless of input order', () => {
    const a = validateManifest({
      files: [
        { path: 'b.ts', sha256: sha(1), size: 10 },
        { path: 'a.ts', sha256: sha(2), size: 20 },
      ],
    });
    const b = validateManifest({
      files: [
        { path: 'a.ts', sha256: sha(2), size: 20 },
        { path: 'b.ts', sha256: sha(1), size: 10 },
      ],
    });
    expect(a.snapshotId).toBe(b.snapshotId);
  });

  it('changes snapshot id when any file content (sha) changes', () => {
    const a = validateManifest({ files: [{ path: 'a.ts', sha256: sha(1), size: 1 }] });
    const b = validateManifest({ files: [{ path: 'a.ts', sha256: sha(2), size: 1 }] });
    expect(a.snapshotId).not.toBe(b.snapshotId);
  });

  it('rejects duplicate paths', () => {
    try {
      validateManifest({
        files: [
          { path: 'a.ts', sha256: sha(1), size: 1 },
          { path: 'a.ts', sha256: sha(2), size: 2 },
        ],
      });
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RepoManifestError);
      expect((err as RepoManifestError).code).toBe('repo_path_duplicate');
    }
  });

  it('rejects a single file > REPO_FILE_BYTES_LIMIT', () => {
    try {
      validateManifest({
        files: [{ path: 'big.bin', sha256: sha(1), size: REPO_FILE_BYTES_LIMIT + 1 }],
      });
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RepoManifestError);
      expect((err as RepoManifestError).code).toBe('repo_file_too_large');
    }
  });

  it('rejects total > REPO_TOTAL_BYTES_LIMIT', () => {
    const file = (n: number) => ({ path: `f${n}.bin`, sha256: sha(n), size: REPO_FILE_BYTES_LIMIT });
    const files = Array.from({ length: 11 }, (_, i) => file(i));
    try {
      validateManifest({ files });
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RepoManifestError);
      expect((err as RepoManifestError).code).toBe('repo_too_large');
    }
  });

  it('blobsReferenced returns distinct shas', () => {
    const m = validateManifest({ files: [
      { path: 'a', sha256: sha(1), size: 1 },
      { path: 'b', sha256: sha(1), size: 1 },
      { path: 'c', sha256: sha(2), size: 1 },
    ]});
    expect(blobsReferenced(m.files).size).toBe(2);
  });
});
