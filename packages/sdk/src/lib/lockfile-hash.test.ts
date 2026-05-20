import { describe, it, expect } from 'vitest';
import { computeLockfileHash } from './lockfile-hash';

describe('computeLockfileHash', () => {
  it('detects pnpm-lock.yaml and hashes its content', async () => {
    const files: Record<string, string> = { '/project/pnpm-lock.yaml': 'lock content' };
    const reader = async (p: string) => files[p] ?? null;
    const r = await computeLockfileHash('/project', reader);
    expect(r.packageManager).toBe('pnpm');
    expect(r.lockfileHash).toMatch(/^[a-f0-9]{32}$/);
  });

  it('falls back to yarn.lock when pnpm-lock is missing', async () => {
    const reader = async (p: string) => p.endsWith('yarn.lock') ? 'yarn content' : null;
    const r = await computeLockfileHash('/project', reader);
    expect(r.packageManager).toBe('yarn');
  });

  it('falls back to package-lock.json when both pnpm and yarn are missing', async () => {
    const reader = async (p: string) => p.endsWith('package-lock.json') ? 'npm content' : null;
    const r = await computeLockfileHash('/project', reader);
    expect(r.packageManager).toBe('npm');
  });

  it('prioritizes pnpm over yarn when both are present', async () => {
    const files: Record<string, string> = {
      '/p/pnpm-lock.yaml': 'pnpm', '/p/yarn.lock': 'yarn',
    };
    const reader = async (p: string) => files[p] ?? null;
    const r = await computeLockfileHash('/p', reader);
    expect(r.packageManager).toBe('pnpm');
  });

  it('throws when no lockfile is found', async () => {
    await expect(computeLockfileHash('/p', async () => null))
      .rejects.toThrow(/no lockfile/i);
  });

  it('produces stable hashes for the same content', async () => {
    const reader = async (p: string) => p.endsWith('pnpm-lock.yaml') ? 'same' : null;
    const a = await computeLockfileHash('/x', reader);
    const b = await computeLockfileHash('/x', reader);
    expect(a.lockfileHash).toBe(b.lockfileHash);
  });
});
