const LOCKFILES: Array<{ file: string; pm: 'pnpm' | 'yarn' | 'npm' }> = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'package-lock.json', pm: 'npm' },
];

export interface LockfileResult {
  packageManager: 'pnpm' | 'yarn' | 'npm';
  lockfileHash: string;
}

export type FileReader = (path: string) => Promise<string | null>;

async function sha256Hex32(s: string): Promise<string> {
  const enc = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/**
 * Detect the project's package manager + compute the first-32-hex-chars of
 * sha256 of its lockfile. Pass a `FileReader` so this works in Node (fs/promises)
 * and in browser (drag-drop, File API).
 */
export async function computeLockfileHash(
  projectDir: string,
  read: FileReader,
): Promise<LockfileResult> {
  for (const { file, pm } of LOCKFILES) {
    const content = await read(`${projectDir}/${file}`);
    if (content !== null) {
      return { packageManager: pm, lockfileHash: await sha256Hex32(content) };
    }
  }
  throw new Error(
    'no lockfile found (expected pnpm-lock.yaml | yarn.lock | package-lock.json)',
  );
}
