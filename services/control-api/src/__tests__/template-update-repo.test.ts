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

  it('preserves invalid UTF-8 bytes outside the match span', () => {
    // 0xFF and a lone 0x80 continuation byte are not valid UTF-8 on their own;
    // a toString('utf8') round trip would replace them with U+FFFD and corrupt
    // the buffer on the way back out. Byte-level replacement must leave them
    // exactly as they are.
    const before = Buffer.from([0xff, 0x80, 0x41]); // 0xFF, 0x80, 'A'
    const needle = Buffer.from('app_src', 'utf8');
    const after = Buffer.from([0x42, 0x43]); // 'B', 'C'
    const content = Buffer.concat([before, needle, after]);

    const out = rewriteBlob(content, 'weird.map', 'app_src', 'app_dst');

    expect(out.changed).toBe(true);
    const expected = Buffer.concat([before, Buffer.from('app_dst', 'utf8'), after]);
    expect(out.content).toEqual(expected);
    // The untouched prefix/suffix bytes are byte-identical, not just equal length.
    expect(out.content.subarray(0, before.length)).toEqual(before);
    expect(out.content.subarray(out.content.length - after.length)).toEqual(after);
  });

  it('replaces multiple occurrences in one buffer', () => {
    const content = Buffer.from('app_src, app_src, and app_src again');
    const out = rewriteBlob(content, 'a.ts', 'app_src', 'app_dst');
    expect(out.changed).toBe(true);
    expect(out.content.toString()).toBe('app_dst, app_dst, and app_dst again');
  });

  it('replaces back-to-back occurrences without dropping or duplicating bytes', () => {
    const content = Buffer.from('app_srcapp_src');
    const out = rewriteBlob(content, 'a.ts', 'app_src', 'app_dst');
    expect(out.changed).toBe(true);
    expect(out.content.toString()).toBe('app_dstapp_dst');
  });

  it('replaces a match at offset 0', () => {
    const content = Buffer.from('app_src tail');
    const out = rewriteBlob(content, 'a.ts', 'app_src', 'app_dst');
    expect(out.content.toString()).toBe('app_dst tail');
  });

  it('replaces a match at the very end of the buffer', () => {
    const content = Buffer.from('head app_src');
    const out = rewriteBlob(content, 'a.ts', 'app_src', 'app_dst');
    expect(out.content.toString()).toBe('head app_dst');
  });

  it('does not recurse when the replacement contains the search term', () => {
    const content = Buffer.from('id=app_src;id=app_src;');
    const out = rewriteBlob(content, 'a.ts', 'app_src', 'app_src_v2');
    expect(out.changed).toBe(true);
    expect(out.content.toString()).toBe('id=app_src_v2;id=app_src_v2;');
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
