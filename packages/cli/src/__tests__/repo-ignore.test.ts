// submodules/butterbase-oss/packages/cli/src/__tests__/repo-ignore.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { loadIgnoreRules, isIgnored, HARDCODED_IGNORES } from '../lib/repo-ignore.js';
import { validateRelativePath, toPosixRelative, PathError } from '../lib/repo-paths.js';

let dir = '';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-ignore-'));
});
afterEach(async () => {
  await fs.remove(dir);
});

describe('repo-ignore', () => {
  it('applies hardcoded defaults with no ignore files present', async () => {
    const ig = await loadIgnoreRules(dir);
    for (const p of ['node_modules/foo', '.git/HEAD', 'dist/bundle.js', '.DS_Store', '.next/build', '.turbo/cache']) {
      expect(isIgnored(ig, p)).toBe(true);
    }
    expect(isIgnored(ig, 'src/index.ts')).toBe(false);
  });

  it('layers .gitignore on top of defaults', async () => {
    await fs.writeFile(path.join(dir, '.gitignore'), 'build/\n*.log\n', 'utf8');
    const ig = await loadIgnoreRules(dir);
    expect(isIgnored(ig, 'build/x.js')).toBe(true);
    expect(isIgnored(ig, 'app.log')).toBe(true);
    expect(isIgnored(ig, 'src/app.ts')).toBe(false);
  });

  it('.butterbaseignore can negate a default ignore', async () => {
    // Per gitignore spec, to un-ignore a file inside an ignored directory you must negate
    // the directory first, then re-ignore it, then negate the specific file — or simply
    // negate a non-directory default (e.g. .DS_Store) which works directly.
    await fs.writeFile(path.join(dir, '.butterbaseignore'), '!.DS_Store\n', 'utf8');
    const ig = await loadIgnoreRules(dir);
    // Other defaults still apply.
    expect(isIgnored(ig, 'dist/other.js')).toBe(true);
    // The negation lifted .DS_Store out of the ignored set.
    expect(isIgnored(ig, '.DS_Store')).toBe(false);
  });

  it('ignores the .butterbase/ config directory by default', async () => {
    expect(HARDCODED_IGNORES).toContain('.butterbase/');
    const ig = await loadIgnoreRules(dir);
    expect(isIgnored(ig, '.butterbase/config.json')).toBe(true);
  });
});

describe('repo-paths', () => {
  for (const bad of ['', '/abs', '..', 'a/../b', './a', 'a/.', 'back\\slash', 'null\0byte']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => validateRelativePath(bad)).toThrow(PathError);
    });
  }
  for (const ok of ['a', 'src/index.ts', 'deep/nested/dir/file.tsx']) {
    it(`accepts ${JSON.stringify(ok)}`, () => {
      expect(() => validateRelativePath(ok)).not.toThrow();
    });
  }
  it('toPosixRelative converts Windows separators', () => {
    expect(toPosixRelative('a\\b\\c')).toBe('a/b/c');
    expect(toPosixRelative('a/b/c')).toBe('a/b/c');
  });
});
