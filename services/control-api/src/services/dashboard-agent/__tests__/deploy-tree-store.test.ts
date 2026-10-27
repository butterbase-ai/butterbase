/**
 * Deploy-tree snapshots (Office deploy-approval fix, Task 1).
 *
 * The failure this closes: an operator proposes `deploy_frontend`, the approval
 * row records only an `inline_code` digest, and Fly routes the later resolve to
 * a different API machine whose `WorkingTreeCache` is empty. The approved
 * operation is real but there is nothing to deploy.
 *
 * The store persists the exact proposed tree under the approval id, so any
 * instance can rehydrate it. These tests use a fake Redis: the store's job is
 * serialization, key scoping and TTL, not Redis itself.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createDeployTreeStore,
  DEPLOY_TREE_KEY_PREFIX,
  DEPLOY_TREE_TTL_SECONDS,
  type DeployTreeRedis,
} from '../deploy-tree-store.js';
import type { WorkingTree } from '../working-tree.js';

type Stored = { value: Buffer; ttl: number };

/** Minimal ioredis surface the store uses. */
function fakeRedis() {
  const data = new Map<string, Stored>();
  const redis: DeployTreeRedis = {
    async set(key, value, mode, ttl) {
      if (mode !== 'EX') throw new Error('the store must write with an expiry');
      data.set(key, { value: Buffer.isBuffer(value) ? value : Buffer.from(value), ttl });
      return 'OK';
    },
    async getBuffer(key) {
      return data.get(key)?.value ?? null;
    },
  };
  return { redis, data };
}

function tree(files: Array<{ path: string; content: string }>): WorkingTree {
  const t: WorkingTree = new Map();
  for (const f of files) {
    t.set(f.path, {
      path: f.path,
      content: f.content,
      sha256: createHash('sha256').update(f.content, 'utf8').digest('hex'),
    });
  }
  return t;
}

const SAMPLE = tree([
  { path: 'package.json', content: '{"scripts":{"build":"vite build"}}' },
  { path: 'index.html', content: '<div id="root"></div>' },
  { path: 'src/main.tsx', content: 'console.log("hello")' },
]);

describe('deploy-tree store', () => {
  it('round-trips a tree through a SECOND store instance sharing the same Redis', async () => {
    const { redis } = fakeRedis();
    const writer = createDeployTreeStore({ redis });
    const reader = createDeployTreeStore({ redis });

    expect(await writer.save('approval-1', SAMPLE)).toBe(true);
    const loaded = await reader.load('approval-1');

    expect(loaded).not.toBeNull();
    expect(Array.from(loaded!.keys()).sort()).toEqual([
      'index.html',
      'package.json',
      'src/main.tsx',
    ]);
    for (const [path, file] of SAMPLE) {
      expect(loaded!.get(path)?.content).toBe(file.content);
      expect(loaded!.get(path)?.sha256).toBe(file.sha256);
    }
  });

  it('keys by approval id and writes a 24-hour expiry', async () => {
    const { redis, data } = fakeRedis();
    await createDeployTreeStore({ redis }).save('approval-xyz', SAMPLE);

    const entry = data.get(`${DEPLOY_TREE_KEY_PREFIX}approval-xyz`);
    expect(entry).toBeDefined();
    expect(entry!.ttl).toBe(DEPLOY_TREE_TTL_SECONDS);
    expect(DEPLOY_TREE_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it('compresses the value instead of storing source in plain text', async () => {
    const { redis, data } = fakeRedis();
    await createDeployTreeStore({ redis }).save('approval-1', SAMPLE);

    const value = data.get(`${DEPLOY_TREE_KEY_PREFIX}approval-1`)!.value;
    // gzip magic: 0x1f 0x8b
    expect(value[0]).toBe(0x1f);
    expect(value[1]).toBe(0x8b);
    expect(value.includes(Buffer.from('console.log'))).toBe(false);
  });

  it('returns null for an approval with no snapshot', async () => {
    const { redis } = fakeRedis();
    expect(await createDeployTreeStore({ redis }).load('never-saved')).toBeNull();
  });

  it('returns null for a corrupted value rather than guessing', async () => {
    const { redis, data } = fakeRedis();
    data.set(`${DEPLOY_TREE_KEY_PREFIX}approval-1`, { value: Buffer.from('not gzip'), ttl: 60 });
    expect(await createDeployTreeStore({ redis }).load('approval-1')).toBeNull();
  });

  it('refuses to save a missing or empty tree', async () => {
    const { redis, data } = fakeRedis();
    const store = createDeployTreeStore({ redis });

    expect(await store.save('approval-1', undefined)).toBe(false);
    expect(await store.save('approval-2', new Map())).toBe(false);
    expect(data.size).toBe(0);
  });

  it('recomputes each digest on load instead of trusting the payload', async () => {
    const { redis } = fakeRedis();
    const writer = createDeployTreeStore({ redis });
    await writer.save('approval-1', SAMPLE);

    const loaded = await createDeployTreeStore({ redis }).load('approval-1');
    const content = loaded!.get('src/main.tsx')!.content;
    expect(loaded!.get('src/main.tsx')!.sha256).toBe(
      createHash('sha256').update(content, 'utf8').digest('hex'),
    );
  });
});
