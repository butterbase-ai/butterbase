import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { rewriteBlob, rewriteManifestEntries } from '../services/template-update-repo.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('rewriteBlob', () => {
  it('rewrites the app id in a rewriteable file', () => {
    const out = rewriteBlob(Buffer.from('const id = "app_src";'), 'src/config.ts', 'app_src', 'app_dst');
    expect(out.content.toString()).toBe('const id = "app_dst";');
    expect(out.changed).toBe(true);
  });

  it('leaves binary extensions untouched', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const out = rewriteBlob(png, 'logo.png', 'app_src', 'app_dst');
    expect(out.changed).toBe(false);
    expect(out.content).toEqual(png);
  });

  it('leaves files without the source id untouched', () => {
    const out = rewriteBlob(Buffer.from('hello'), 'a.ts', 'app_src', 'app_dst');
    expect(out.changed).toBe(false);
  });
});

describe('rewriteManifestEntries', () => {
  it('re-hashes rewritten blobs and stores them under the new sha', async () => {
    const original = Buffer.from('url = "app_src"');
    const store = new Map<string, Buffer>([[sha(original), original]]);
    const put: string[] = [];

    const out = await rewriteManifestEntries(
      [{ path: 'cfg.ts', sha256: sha(original), size: original.length }],
      async (s) => store.get(s)!,
      async (s, c) => { store.set(s, c); put.push(s); },
      'app_src', 'app_dst',
    );

    const expected = Buffer.from('url = "app_dst"');
    expect(out[0].sha256).toBe(sha(expected));
    expect(out[0].size).toBe(expected.length);
    expect(put).toEqual([sha(expected)]);
  });

  it('leaves untouched entries with their original sha and does not re-put them', async () => {
    const b = Buffer.from('nothing here');
    const put: string[] = [];
    const out = await rewriteManifestEntries(
      [{ path: 'a.ts', sha256: sha(b), size: b.length }],
      async () => b,
      async (s) => { put.push(s); },
      'app_src', 'app_dst',
    );
    expect(out[0].sha256).toBe(sha(b));
    expect(put).toEqual([]);
  });
});
