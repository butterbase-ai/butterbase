import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export function detectPackageManagerAndLockfile(projectDir: string): {
  packageManager: 'npm' | 'pnpm' | 'yarn';
  lockfileHash: string;
} {
  const candidates: Array<['pnpm' | 'yarn' | 'npm', string]> = [
    ['pnpm', 'pnpm-lock.yaml'],
    ['yarn', 'yarn.lock'],
    ['npm', 'package-lock.json'],
  ];
  for (const [pm, file] of candidates) {
    const full = path.join(projectDir, file);
    if (existsSync(full)) {
      const h = createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 32);
      return { packageManager: pm, lockfileHash: h };
    }
  }
  const pkg = path.join(projectDir, 'package.json');
  if (!existsSync(pkg)) throw new Error('No lockfile or package.json found');
  const h = createHash('sha256').update(readFileSync(pkg)).digest('hex').slice(0, 32);
  return { packageManager: 'npm', lockfileHash: h };
}
