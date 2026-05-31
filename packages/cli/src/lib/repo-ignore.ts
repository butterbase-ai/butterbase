// submodules/butterbase-oss/packages/cli/src/lib/repo-ignore.ts
import fs from 'fs-extra';
import path from 'path';
import ignore, { type Ignore } from 'ignore';

/** Hardcoded defaults that always apply unless explicitly un-ignored in .butterbaseignore. */
export const HARDCODED_IGNORES = [
  '.git/',
  'node_modules/',
  'dist/',
  '.next/',
  '.turbo/',
  '.DS_Store',
  // The bound-app config and its caches.
  '.butterbase/',
];

/**
 * Load ignore rules from `root`.
 *
 * Precedence (highest wins): .butterbaseignore > .gitignore > HARDCODED_IGNORES.
 * The `ignore` package treats later add()s as overriding earlier ones, and supports `!path`
 * negations to un-ignore. So we add in order defaults → .gitignore → .butterbaseignore.
 */
export async function loadIgnoreRules(root: string): Promise<Ignore> {
  const ig = ignore();
  ig.add(HARDCODED_IGNORES);

  const gitIgnore = path.join(root, '.gitignore');
  if (await fs.pathExists(gitIgnore)) {
    ig.add(await fs.readFile(gitIgnore, 'utf8'));
  }

  const bbIgnore = path.join(root, '.butterbaseignore');
  if (await fs.pathExists(bbIgnore)) {
    ig.add(await fs.readFile(bbIgnore, 'utf8'));
  }

  return ig;
}

/**
 * Test whether a posix-style relative path is ignored.
 * Pass directory paths with a trailing slash, e.g. `foo/`.
 */
export function isIgnored(ig: Ignore, posixRelPath: string): boolean {
  // ignore() panics on leading "/"; strip it defensively.
  return ig.ignores(posixRelPath.replace(/^\/+/, ''));
}
