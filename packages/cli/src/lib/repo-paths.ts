// submodules/butterbase-oss/packages/cli/src/lib/repo-paths.ts

/**
 * Mirror of the server's path validation (services/control-api/src/services/repo-manifest.ts).
 * Keeping it duplicated rather than imported keeps the CLI free of a server import; the rules
 * are simple enough that drift risk is low (and would surface as a 400 from prepare anyway).
 */
export const REPO_MAX_PATH_BYTES = 4096;

export class PathError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PathError';
  }
}

export function validateRelativePath(p: string): void {
  if (p.length === 0) throw new PathError('repo_path_empty', 'Path is empty');
  if (Buffer.byteLength(p, 'utf8') > REPO_MAX_PATH_BYTES) {
    throw new PathError('repo_path_too_long', `Path exceeds ${REPO_MAX_PATH_BYTES} bytes: ${p}`);
  }
  if (p.startsWith('/')) throw new PathError('repo_path_absolute', `Path is absolute: ${p}`);
  if (p.includes('\\')) throw new PathError('repo_path_backslash', `Path contains backslash: ${p}`);
  if (p.includes('\0')) throw new PathError('repo_path_null_byte', `Path contains null byte`);
  for (const seg of p.split('/')) {
    if (seg === '..') throw new PathError('repo_path_traversal', `Path contains '..': ${p}`);
    if (seg === '.') throw new PathError('repo_path_dot_segment', `Path contains '.' segment: ${p}`);
    if (seg.length === 0) throw new PathError('repo_path_empty_segment', `Path has empty segment: ${p}`);
  }
}

/** Convert a possibly-Windows path (`a\\b`) to forward-slash form for the manifest. */
export function toPosixRelative(rel: string): string {
  return rel.split(/[\\/]+/).join('/');
}
