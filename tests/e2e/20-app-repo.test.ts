/**
 * E2E — app repo storage (Phase 2)
 *
 * Covers:
 *   1. prepare → upload missing blobs → commit → GET latest happy path.
 *   2. Dedup: re-pushing an existing blob is not re-uploaded.
 *   3. 413 on manifest whose total declared size exceeds 100 MB.
 *   4. 400 on path traversal in file path.
 *   5. 404 to non-owner of a private app on both prepare and GET latest.
 *   6. Public app allows anonymous GET latest.
 *   7. DELETE /repo wipes S3 and clears apps.repo_latest_snapshot.
 *   8. Retention: after 7 pushes the 2 oldest are pruned, 5 newest remain.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'crypto';
import { bootE2E, type E2EEnv } from './helpers/boot.js';
import { seedApp } from './helpers/seed.js';
import { cleanupAll } from './helpers/cleanup.js';
import { sseDispatcher } from '../../services/control-api/src/routes/hackathons-public.js';

let env: E2EEnv;

beforeAll(async () => {
  env = await bootE2E();
}, 60_000);

afterAll(async () => {
  const appAny = env.app as any;
  const intervals = ['ragWorkerInterval', 'flushInterval', 'failureNotifierInterval',
    'neonWorkerInterval', 'analyticsPullerInterval', 'nightlyInterval'];
  const timeouts = ['nightlyTimeout'];
  for (const key of intervals) if (appAny[key]) { clearInterval(appAny[key]); appAny[key] = undefined; }
  for (const key of timeouts) if (appAny[key]) { clearTimeout(appAny[key]); appAny[key] = undefined; }
  sseDispatcher.stop();
  await cleanupAll(env.controlPool);
  await env.shutdown();
}, 120_000);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function uploadToPresigned(url: string, body: string): Promise<void> {
  const res = await fetch(url, { method: 'PUT', body, headers: { 'content-type': 'application/octet-stream' } });
  if (!res.ok) throw new Error(`presigned PUT ${url} failed ${res.status}: ${await res.text()}`);
}

describe('app repo storage (Phase 2)', () => {
  it('prepare → upload missing blobs → commit → GET latest happy path', async () => {
    const { userId, appId } = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'repo-happy' });

    const fileA = 'console.log("a")\n';
    const fileB = '{"name":"hello"}\n';
    const manifest = {
      files: [
        { path: 'src/a.ts', sha256: sha256(fileA), size: Buffer.byteLength(fileA) },
        { path: 'package.json', sha256: sha256(fileB), size: Buffer.byteLength(fileB) },
      ],
      message: 'first push',
    };

    const prep = await env.app.inject({
      method: 'POST', url: `/v1/${appId}/repo/snapshots/prepare`,
      headers: { 'x-test-user-id': userId }, payload: manifest,
    });
    expect(prep.statusCode).toBe(200);
    const prepBody = prep.json() as { snapshot_id: string; missing_blobs: { sha256: string; uploadUrl: string }[] };
    expect(prepBody.missing_blobs.length).toBe(2);

    const bySha = new Map([[sha256(fileA), fileA], [sha256(fileB), fileB]]);
    for (const m of prepBody.missing_blobs) await uploadToPresigned(m.uploadUrl, bySha.get(m.sha256)!);

    const com = await env.app.inject({
      method: 'POST', url: `/v1/${appId}/repo/snapshots/commit`,
      headers: { 'x-test-user-id': userId }, payload: { manifest },
    });
    expect(com.statusCode).toBe(200);
    expect((com.json() as any).snapshot_id).toBe(prepBody.snapshot_id);

    const latest = await env.app.inject({
      method: 'GET', url: `/v1/${appId}/repo/snapshots/latest`,
      headers: { 'x-test-user-id': userId },
    });
    expect(latest.statusCode).toBe(200);
    const lb = latest.json() as { snapshot_id: string; manifest: { files: { sha256: string }[] } };
    expect(lb.snapshot_id).toBe(prepBody.snapshot_id);
    expect(lb.manifest.files.length).toBe(2);

    const cfg = await env.app.inject({
      method: 'GET', url: `/v1/${appId}/config`,
      headers: { 'x-test-user-id': userId },
    });
    expect((cfg.json() as any).repo_latest_snapshot).toBe(prepBody.snapshot_id);
  });

  it('second push of an unchanged file does not re-upload it', async () => {
    const { userId, appId } = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'repo-dedup' });
    const f = 'shared bytes\n';
    const manifest1 = { files: [{ path: 'a.txt', sha256: sha256(f), size: Buffer.byteLength(f) }] };
    const p1 = await env.app.inject({ method: 'POST', url: `/v1/${appId}/repo/snapshots/prepare`, headers: { 'x-test-user-id': userId }, payload: manifest1 });
    const p1b = p1.json() as any;
    for (const m of p1b.missing_blobs) await uploadToPresigned(m.uploadUrl, f);
    await env.app.inject({ method: 'POST', url: `/v1/${appId}/repo/snapshots/commit`, headers: { 'x-test-user-id': userId }, payload: { manifest: manifest1 } });

    const g = 'new file\n';
    const manifest2 = { files: [
      { path: 'a.txt', sha256: sha256(f), size: Buffer.byteLength(f) },
      { path: 'b.txt', sha256: sha256(g), size: Buffer.byteLength(g) },
    ]};
    const p2 = await env.app.inject({ method: 'POST', url: `/v1/${appId}/repo/snapshots/prepare`, headers: { 'x-test-user-id': userId }, payload: manifest2 });
    const p2b = p2.json() as any;
    expect(p2b.missing_blobs.map((m: any) => m.sha256)).toEqual([sha256(g)]);
  });

  it('rejects manifest > 100 MB with 413', async () => {
    const { userId, appId } = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'repo-cap' });
    const oversized = {
      files: Array.from({ length: 11 }, (_, i) => ({
        path: `f${i}.bin`,
        sha256: sha256(`s${i}`).padEnd(64, '0').slice(0, 64),
        size: 10 * 1024 * 1024,
      })),
    };
    const r = await env.app.inject({ method: 'POST', url: `/v1/${appId}/repo/snapshots/prepare`, headers: { 'x-test-user-id': userId }, payload: oversized });
    expect(r.statusCode).toBe(413);
  });

  it('rejects path traversal with 400', async () => {
    const { userId, appId } = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'repo-path' });
    const bad = { files: [{ path: '../etc/passwd', sha256: sha256('x'), size: 1 }] };
    const r = await env.app.inject({ method: 'POST', url: `/v1/${appId}/repo/snapshots/prepare`, headers: { 'x-test-user-id': userId }, payload: bad });
    expect(r.statusCode).toBe(400);
  });

  it('returns 404 to non-owner of a private app for both prepare and GET latest', async () => {
    const owner = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'repo-priv-own' });
    const other = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'repo-priv-other' });

    const prep = await env.app.inject({
      method: 'POST', url: `/v1/${owner.appId}/repo/snapshots/prepare`,
      headers: { 'x-test-user-id': other.userId }, payload: { files: [] },
    });
    expect(prep.statusCode).toBe(404);

    const latest = await env.app.inject({
      method: 'GET', url: `/v1/${owner.appId}/repo/snapshots/latest`,
      headers: { 'x-test-user-id': other.userId },
    });
    expect(latest.statusCode).toBe(404);
  });

  it('public app allows anonymous GET latest', async () => {
    const owner = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'repo-public' });

    const f = 'hi\n';
    const manifest = { files: [{ path: 'r.txt', sha256: sha256(f), size: Buffer.byteLength(f) }] };
    const p = await env.app.inject({ method: 'POST', url: `/v1/${owner.appId}/repo/snapshots/prepare`, headers: { 'x-test-user-id': owner.userId }, payload: manifest });
    for (const m of (p.json() as any).missing_blobs) await uploadToPresigned(m.uploadUrl, f);
    await env.app.inject({ method: 'POST', url: `/v1/${owner.appId}/repo/snapshots/commit`, headers: { 'x-test-user-id': owner.userId }, payload: { manifest } });

    await env.app.inject({
      method: 'PATCH', url: `/v1/${owner.appId}/config/visibility`,
      headers: { 'x-test-user-id': owner.userId }, payload: { visibility: 'public' },
    });

    const latest = await env.app.inject({
      method: 'GET', url: `/v1/${owner.appId}/repo/snapshots/latest`,
    });
    expect(latest.statusCode).toBe(200);
  });

  it('DELETE /repo wipes everything and clears apps.repo_latest_snapshot', async () => {
    const owner = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'repo-wipe' });
    const f = 'x\n';
    const manifest = { files: [{ path: 'x.txt', sha256: sha256(f), size: Buffer.byteLength(f) }] };
    const p = await env.app.inject({ method: 'POST', url: `/v1/${owner.appId}/repo/snapshots/prepare`, headers: { 'x-test-user-id': owner.userId }, payload: manifest });
    for (const m of (p.json() as any).missing_blobs) await uploadToPresigned(m.uploadUrl, f);
    await env.app.inject({ method: 'POST', url: `/v1/${owner.appId}/repo/snapshots/commit`, headers: { 'x-test-user-id': owner.userId }, payload: { manifest } });

    const del = await env.app.inject({ method: 'DELETE', url: `/v1/${owner.appId}/repo`, headers: { 'x-test-user-id': owner.userId } });
    expect(del.statusCode).toBe(200);

    const latest = await env.app.inject({ method: 'GET', url: `/v1/${owner.appId}/repo/snapshots/latest`, headers: { 'x-test-user-id': owner.userId } });
    expect(latest.statusCode).toBe(404);

    const cfg = await env.app.inject({ method: 'GET', url: `/v1/${owner.appId}/config`, headers: { 'x-test-user-id': owner.userId } });
    expect((cfg.json() as any).repo_latest_snapshot).toBe(null);
  });

  it('retention keeps the last 5 snapshots and prunes orphan blobs', async () => {
    const owner = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'repo-retain' });

    async function pushOne(label: string): Promise<string> {
      const f = `content ${label}\n`;
      const manifest = { files: [{ path: `${label}.txt`, sha256: sha256(f), size: Buffer.byteLength(f) }] };
      const p = await env.app.inject({ method: 'POST', url: `/v1/${owner.appId}/repo/snapshots/prepare`, headers: { 'x-test-user-id': owner.userId }, payload: manifest });
      for (const m of (p.json() as any).missing_blobs) await uploadToPresigned(m.uploadUrl, f);
      const c = await env.app.inject({ method: 'POST', url: `/v1/${owner.appId}/repo/snapshots/commit`, headers: { 'x-test-user-id': owner.userId }, payload: { manifest } });
      return (c.json() as any).snapshot_id;
    }

    // S3 LastModified has 1-second resolution; space pushes apart so retention sort is deterministic.
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push(await pushOne(`v${i}`));
      if (i < 6) await new Promise(r => setTimeout(r, 1100));
    }

    for (let i = 0; i < 2; i++) {
      const r = await env.app.inject({ method: 'GET', url: `/v1/${owner.appId}/repo/snapshots/${ids[i]}`, headers: { 'x-test-user-id': owner.userId } });
      expect(r.statusCode).toBe(404);
    }
    for (let i = 2; i < 7; i++) {
      const r = await env.app.inject({ method: 'GET', url: `/v1/${owner.appId}/repo/snapshots/${ids[i]}`, headers: { 'x-test-user-id': owner.userId } });
      expect(r.statusCode).toBe(200);
    }
  });

  it('lists snapshots newest-first', async () => {
    const { userId, appId } = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'repo-list' });
    // S3 LastModified is 1-second resolution; space pushes apart for stable order.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const f = `list ${i}\n`;
      const manifest = { files: [{ path: `l${i}.txt`, sha256: sha256(f), size: Buffer.byteLength(f) }] };
      const p = await env.app.inject({ method: 'POST', url: `/v1/${appId}/repo/snapshots/prepare`, headers: { 'x-test-user-id': userId }, payload: manifest });
      for (const m of (p.json() as any).missing_blobs) await uploadToPresigned(m.uploadUrl, f);
      const c = await env.app.inject({ method: 'POST', url: `/v1/${appId}/repo/snapshots/commit`, headers: { 'x-test-user-id': userId }, payload: { manifest } });
      ids.push((c.json() as any).snapshot_id);
      if (i < 2) await new Promise(r => setTimeout(r, 1100));
    }

    const r = await env.app.inject({ method: 'GET', url: `/v1/${appId}/repo/snapshots`, headers: { 'x-test-user-id': userId } });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { snapshots: { snapshot_id: string; created_at: string }[] };
    expect(body.snapshots.map(s => s.snapshot_id)).toEqual([ids[2], ids[1], ids[0]]);
  });

  it('snapshot list honors visibility (404 to non-owner on private)', async () => {
    const owner = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'repo-list-own' });
    const other = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'repo-list-other' });
    const r = await env.app.inject({
      method: 'GET', url: `/v1/${owner.appId}/repo/snapshots`,
      headers: { 'x-test-user-id': other.userId },
    });
    expect(r.statusCode).toBe(404);
  });

  it('batch-presigns multiple blob URLs in a single auth call', async () => {
    const { userId, appId } = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'repo-batch' });
    const files = ['a.txt', 'b.txt', 'c.txt'].map((path, i) => {
      const content = `batch ${i}\n`;
      return { path, content, sha: sha256(content), size: Buffer.byteLength(content) };
    });
    const manifest = { files: files.map(f => ({ path: f.path, sha256: f.sha, size: f.size })) };
    const p = await env.app.inject({ method: 'POST', url: `/v1/${appId}/repo/snapshots/prepare`, headers: { 'x-test-user-id': userId }, payload: manifest });
    for (const m of (p.json() as any).missing_blobs) await uploadToPresigned(m.uploadUrl, files.find(f => f.sha === m.sha256)!.content);
    await env.app.inject({ method: 'POST', url: `/v1/${appId}/repo/snapshots/commit`, headers: { 'x-test-user-id': userId }, payload: { manifest } });

    const r = await env.app.inject({
      method: 'POST',
      url: `/v1/${appId}/repo/blobs/batch`,
      headers: { 'x-test-user-id': userId, 'content-type': 'application/json' },
      payload: { shas: files.map(f => f.sha) },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { blobs: { sha256: string; size: number; downloadUrl: string; expiresIn: number }[] };
    expect(body.blobs).toHaveLength(3);
    for (const f of files) {
      const b = body.blobs.find(b => b.sha256 === f.sha);
      expect(b).toBeDefined();
      expect(b!.size).toBe(f.size);
      expect(b!.downloadUrl).toMatch(/^https?:\/\//);
    }
  });

  it('batch-presign rejects malformed shas and oversized batches', async () => {
    const { userId, appId } = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'repo-batch-bad' });
    const bad = await env.app.inject({ method: 'POST', url: `/v1/${appId}/repo/blobs/batch`, headers: { 'x-test-user-id': userId, 'content-type': 'application/json' }, payload: { shas: ['not-hex'] } });
    expect(bad.statusCode).toBe(400);

    const empty = await env.app.inject({ method: 'POST', url: `/v1/${appId}/repo/blobs/batch`, headers: { 'x-test-user-id': userId, 'content-type': 'application/json' }, payload: { shas: [] } });
    expect(empty.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 C3 — repo security boundaries
// ---------------------------------------------------------------------------

describe('Phase 5 C3 — repo security boundaries', () => {
  it('rejects manifest paths with traversal / null byte / leading slash / >4KB / backslash / path injection', async () => {
    const { userId, appId } = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'c3-paths' });

    const cases: Array<{ label: string; path: string }> = [
      { label: 'traversal (../../etc/passwd)', path: '../../etc/passwd' },
      { label: 'absolute path (/abs/path)', path: '/abs/path' },
      // null byte — must be literal \0 in the string
      { label: 'null byte (a\\0b)', path: 'a\0b' },
      { label: 'path longer than 4096 bytes', path: 'x'.repeat(4097) },
      { label: 'backslash (foo\\\\bar)', path: 'foo\\bar' },
      { label: 'path injection (foo/..//bar)', path: 'foo/..//bar' },
    ];

    for (const { label, path } of cases) {
      const r = await env.app.inject({
        method: 'POST',
        url: `/v1/${appId}/repo/snapshots/prepare`,
        headers: { 'x-test-user-id': userId },
        payload: { files: [{ path, sha256: 'a'.repeat(64), size: 1 }] },
      });
      expect(
        [400, 422],
        `path ${label} should be 4xx but got ${r.statusCode}: ${r.body}`,
      ).toContain(r.statusCode);
    }
  }, 60_000);

  it('rejects commit when uploaded blob size does not match manifest claim (409)', async () => {
    const { userId, appId } = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'c3-sizematch' });

    // Declare size: 10 bytes in the manifest.
    const declaredSize = 10;
    const fakeSha = 'b'.repeat(64);
    const prepReply = await env.app.inject({
      method: 'POST',
      url: `/v1/${appId}/repo/snapshots/prepare`,
      headers: { 'x-test-user-id': userId },
      payload: { files: [{ path: 'big.bin', sha256: fakeSha, size: declaredSize }] },
    });
    expect(prepReply.statusCode, `prepare failed: ${prepReply.body}`).toBe(200);
    const prepBody = prepReply.json() as { snapshot_id: string; missing_blobs: { sha256: string; uploadUrl: string }[] };
    expect(prepBody.missing_blobs.length).toBe(1);

    // PUT a body significantly larger than 10 bytes (100 KB) to the presigned URL.
    const largeBody = Buffer.alloc(100_000, 0x42);
    await fetch(prepBody.missing_blobs[0].uploadUrl, {
      method: 'PUT',
      body: largeBody,
      headers: { 'content-type': 'application/octet-stream' },
    });

    // Commit must detect the size mismatch and return 409.
    const commitReply = await env.app.inject({
      method: 'POST',
      url: `/v1/${appId}/repo/snapshots/commit`,
      headers: { 'x-test-user-id': userId },
      payload: { manifest: { files: [{ path: 'big.bin', sha256: fakeSha, size: declaredSize }] } },
    });
    expect(commitReply.statusCode, `expected 409 size-mismatch but got ${commitReply.statusCode}: ${commitReply.body}`).toBe(409);
  }, 60_000);

  it('GET /repo/snapshots/latest: 404 on private+anonymous, 200 on public+anonymous (after one snapshot)', async () => {
    // NOTE: The spec (Phase 5 C3) says private+anonymous should return 401.
    // The production implementation returns 404 instead, deliberately using AppNotFoundError
    // so as not to leak whether the app exists (security through obscurity / don't confirm app id).
    // This test codifies the ACTUAL production behavior (404), not the spec expectation (401).
    // If the behavior should change to 401, authorizeRepoRead in repo-auth.ts must be updated.

    const owner = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'c3-anon' });

    // Push one snapshot so the public path can serve a 200.
    const f = 'hello c3\n';
    const manifest = { files: [{ path: 'README.md', sha256: sha256(f), size: Buffer.byteLength(f) }] };
    const prep = await env.app.inject({
      method: 'POST', url: `/v1/${owner.appId}/repo/snapshots/prepare`,
      headers: { 'x-test-user-id': owner.userId }, payload: manifest,
    });
    for (const m of (prep.json() as any).missing_blobs) await uploadToPresigned(m.uploadUrl, f);
    await env.app.inject({
      method: 'POST', url: `/v1/${owner.appId}/repo/snapshots/commit`,
      headers: { 'x-test-user-id': owner.userId }, payload: { manifest },
    });

    // 1. Private app (default) + anonymous → 404
    //    (production does not return 401; it returns 404 to avoid leaking app existence)
    const privReply = await env.app.inject({
      method: 'GET', url: `/v1/${owner.appId}/repo/snapshots/latest`,
      // no x-test-user-id header → anonymous
    });
    expect(privReply.statusCode, `private+anon: expected 404 but got ${privReply.statusCode}`).toBe(404);

    // 2. Flip visibility to public → anonymous should get 200.
    await env.app.inject({
      method: 'PATCH', url: `/v1/${owner.appId}/config/visibility`,
      headers: { 'x-test-user-id': owner.userId }, payload: { visibility: 'public' },
    });
    const pubReply = await env.app.inject({
      method: 'GET', url: `/v1/${owner.appId}/repo/snapshots/latest`,
      // no x-test-user-id header → anonymous
    });
    expect(pubReply.statusCode, `public+anon: expected 200 but got ${pubReply.statusCode}`).toBe(200);
  }, 90_000);
});
