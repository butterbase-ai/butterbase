/**
 * `repo-http.ts` — the repo I/O path used by AUTONOMOUS OPERATOR turns.
 *
 * WHY A SECOND IMPLEMENTATION OF `RepoSync` AT ALL
 * ------------------------------------------------
 * The operator could not read or persist app source at all. `repo-sync.ts`
 * reaches the repo through `manage_repo` over MCP, and on an operator turn that
 * call goes through `turnMcp` (loop.ts), which admits only an 'allow' verdict.
 * `manage_repo` sits at 'approval' in operator-policy.ts, so hydration was
 * refused on EVERY operator turn at EVERY yolo setting — the operator started
 * each turn with an empty working tree and lost everything at turn end.
 *
 * WHY HTTP RATHER THAN CALLING repo-storage.ts IN-PROCESS
 * -------------------------------------------------------
 * The in-process route was tried first and abandoned. `repo-storage.ts` takes
 * `appId` as a plain parameter and performs no authorization of its own, so
 * going straight to it means writing a THIRD repo authorizer — and a
 * reimplemented tenancy check on a path that both reads and writes, running
 * unattended on an org service key, is precisely where a cross-org leak would
 * appear. The HTTP routes already authorize correctly (routes/repo.ts:57,136 →
 * `requireUserId` + `authorizeRepoWrite`), and that is the same code path
 * humans use, so it stays exercised.
 *
 * The MCP-only 1 MB push cap (mcp-server manage-repo.ts) is not a property of
 * the repo at all — its own error text says "Use `butterbase repo push` for
 * larger snapshots", and the CLI reaches these same HTTP routes without it. The
 * real limits (100 MB/snapshot, 10 MB/file, the per-app storage quota) live in
 * repo-manifest validation and the prepare handler, and this client inherits
 * every one of them for free by going through the routes.
 *
 * WHAT AUTHENTICATES IT
 * ---------------------
 * The `jwt` argument already threaded through every `RepoSync` method. For an
 * operator turn that value is the org's `bb_sk_*` service key
 * (operator-credential.ts → operator-turn.ts → `runAgentTurn({ jwt })`), and
 * plugins/auth.ts resolves `bb_sk_*` via `ApiKeyService.validateApiKey` into
 * `{ userId: key.user_id, organizationId: key.organization_id }`. So
 * `requireUserId` is satisfied and `authorizeRepoWrite` takes branch 1 of
 * `AppResolver.resolveApp` — "app in caller's active org". Tenancy is enforced
 * by the existing middleware; nothing here re-decides it.
 *
 * THE SURFACE THIS CLIENT DELIBERATELY DOES NOT IMPLEMENT
 * -------------------------------------------------------
 * `DELETE /v1/:app_id/repo` (wipe). The same credential authorizes it — wipe
 * uses the identical `authorizeRepoWrite` — so this client not having a `wipe`
 * method is a scope decision, not a security boundary, and it is called out
 * here so nobody mistakes it for one. Wipe is irreversible. See the report.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkingTreeCache } from '../working-tree.js';
import { createHttpRepoSync } from '../repo-http.js';

const CONV = 'conv-1';
const APP = 'app-1';
const KEY = 'bb_sk_operator_key';
const BASE = 'https://api.test';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** Records every request so tests can assert on method, path, auth and body. */
function mkFetch(routes: Array<{ match: RegExp; method?: string; handler: Handler }>) {
  const calls: Array<{ url: string; method: string; auth?: string; body?: unknown }> = [];
  const impl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown;
    if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    else if (init?.body !== undefined) body = init.body;
    calls.push({ url, method, auth: headers.authorization ?? headers.Authorization, body });

    for (const r of routes) {
      if (r.match.test(url) && (!r.method || r.method === method)) return r.handler(url, init);
    }
    throw new Error(`unrouted ${method} ${url}`);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const shaOf = (cache: WorkingTreeCache, path: string) => cache.get(CONV, APP)!.get(path)!.sha256;

let cache: WorkingTreeCache;
beforeEach(() => {
  cache = new WorkingTreeCache();
});

// ---------------------------------------------------------------------------
// Phase 1 — hydration
// ---------------------------------------------------------------------------

describe('createHttpRepoSync — pullLatest', () => {
  it('hydrates the cache from the latest manifest + batch-presigned GETs', async () => {
    const shaA = 'a'.repeat(64);
    const shaB = 'b'.repeat(64);
    const { impl, calls } = mkFetch([
      {
        match: /\/repo\/snapshots\/latest$/,
        handler: () => json({
          snapshot_id: 'snap_1',
          manifest: { v: 1, files: [
            { path: 'src/App.tsx', sha256: shaA, size: 11 },
            { path: 'package.json', sha256: shaB, size: 11 },
          ] },
        }),
      },
      {
        match: /\/repo\/blobs\/batch$/,
        handler: () => json({ blobs: [
          { sha256: shaA, size: 11, downloadUrl: 'https://s3/a' },
          { sha256: shaB, size: 11, downloadUrl: 'https://s3/b' },
        ] }),
      },
      { match: /^https:\/\/s3\/a$/, handler: () => new Response('APP_CONTENT') },
      { match: /^https:\/\/s3\/b$/, handler: () => new Response('PKG_CONTENT') },
    ]);

    const sync = createHttpRepoSync({ cache, baseUrl: BASE, fetchImpl: impl });
    const r = await sync.pullLatest({ convId: CONV, appId: APP, jwt: KEY });

    expect(r.hydrated).toBe(true);
    expect(cache.read(CONV, APP, 'src/App.tsx')).toBe('APP_CONTENT');
    expect(cache.read(CONV, APP, 'package.json')).toBe('PKG_CONTENT');

    // The control-api calls must carry the turn credential. The presigned S3
    // GETs must NOT — a presigned URL is already authorized, and attaching the
    // org service key to an arbitrary storage host leaks it off-platform.
    const apiCalls = calls.filter(c => c.url.startsWith(BASE));
    expect(apiCalls).toHaveLength(2);
    for (const c of apiCalls) expect(c.auth).toBe(`Bearer ${KEY}`);
    for (const c of calls.filter(c => c.url.startsWith('https://s3/'))) {
      expect(c.auth).toBeUndefined();
    }
  });

  it('de-duplicates shas before asking for download urls', async () => {
    // Content-addressed storage: two paths with identical content share one
    // blob. Asking for the same sha twice wastes a presign and, at scale,
    // pushes past the endpoint's 1000-sha batch limit for no reason.
    const sha = 'c'.repeat(64);
    let batchBody: any = null;
    const { impl } = mkFetch([
      {
        match: /\/repo\/snapshots\/latest$/,
        handler: () => json({
          snapshot_id: 'snap_1',
          manifest: { files: [
            { path: 'a.txt', sha256: sha, size: 4 },
            { path: 'b.txt', sha256: sha, size: 4 },
          ] },
        }),
      },
      {
        match: /\/repo\/blobs\/batch$/,
        handler: (_u, init) => {
          batchBody = JSON.parse(init!.body as string);
          return json({ blobs: [{ sha256: sha, size: 4, downloadUrl: 'https://s3/c' }] });
        },
      },
      { match: /^https:\/\/s3\/c$/, handler: () => new Response('SAME') },
    ]);

    const sync = createHttpRepoSync({ cache, baseUrl: BASE, fetchImpl: impl });
    await sync.pullLatest({ convId: CONV, appId: APP, jwt: KEY });

    expect(batchBody.shas).toEqual([sha]);
    expect(cache.read(CONV, APP, 'a.txt')).toBe('SAME');
    expect(cache.read(CONV, APP, 'b.txt')).toBe('SAME');
  });

  it('reports hydrated=false and leaves the cache untouched when the app has no snapshots', async () => {
    // The route 404s when `latest` is unset. That is the normal state of a
    // brand-new app, not an error — `ensureHydrated` scaffolds from a template
    // on a false here, and MUST NOT see a throw, or it would skip the scaffold.
    const { impl } = mkFetch([
      { match: /\/repo\/snapshots\/latest$/, handler: () => json({ error: 'RESOURCE_NOT_FOUND' }, 404) },
    ]);

    const sync = createHttpRepoSync({ cache, baseUrl: BASE, fetchImpl: impl });
    const r = await sync.pullLatest({ convId: CONV, appId: APP, jwt: KEY });

    expect(r.hydrated).toBe(false);
    expect(cache.get(CONV, APP)).toBeUndefined();
  });

  it('reports hydrated=false for a snapshot with an empty file list', async () => {
    // Mirrors repo-sync.ts's `files.length === 0` check exactly, so downstream
    // scaffold behaviour is identical whichever implementation is in play.
    const { impl } = mkFetch([
      { match: /\/repo\/snapshots\/latest$/, handler: () => json({ snapshot_id: 's', manifest: { files: [] } }) },
    ]);

    const sync = createHttpRepoSync({ cache, baseUrl: BASE, fetchImpl: impl });
    expect(await sync.pullLatest({ convId: CONV, appId: APP, jwt: KEY })).toEqual({ hydrated: false });
    expect(cache.get(CONV, APP)).toBeUndefined();
  });

  it('THROWS on a 403 rather than reporting an empty repo', async () => {
    // The distinction that matters for tenancy: "you may not see this app" must
    // never be laundered into "this app has no files". A false here would send
    // the turn down the scaffold path and then try to PUSH a template into
    // someone else's app.
    const { impl } = mkFetch([
      { match: /\/repo\/snapshots\/latest$/, handler: () => json({ error: 'forbidden' }, 403) },
    ]);

    const sync = createHttpRepoSync({ cache, baseUrl: BASE, fetchImpl: impl });
    await expect(sync.pullLatest({ convId: CONV, appId: APP, jwt: KEY })).rejects.toThrow(/403/);
  });

  it('pullSnapshot fetches the requested snapshot id', async () => {
    const sha = 'd'.repeat(64);
    const { impl, calls } = mkFetch([
      {
        match: /\/repo\/snapshots\/snap_old$/,
        handler: () => json({ snapshot_id: 'snap_old', manifest: { files: [{ path: 'a.ts', sha256: sha, size: 3 }] } }),
      },
      { match: /\/repo\/blobs\/batch$/, handler: () => json({ blobs: [{ sha256: sha, size: 3, downloadUrl: 'https://s3/d' }] }) },
      { match: /^https:\/\/s3\/d$/, handler: () => new Response('OLD') },
    ]);

    const sync = createHttpRepoSync({ cache, baseUrl: BASE, fetchImpl: impl });
    const r = await sync.pullSnapshot({ convId: CONV, appId: APP, snapshotId: 'snap_old', jwt: KEY });

    expect(r.hydrated).toBe(true);
    expect(cache.read(CONV, APP, 'a.ts')).toBe('OLD');
    expect(calls[0].url).toBe(`${BASE}/v1/${APP}/repo/snapshots/snap_old`);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — push
// ---------------------------------------------------------------------------

/** prepare → PUT missing blobs → commit, with recording. */
function mkPushFetch(opts: { missing: (files: any[]) => any[]; commitStatus?: number; commitBody?: unknown }) {
  const state: { prepareBody?: any; commitBody?: any; puts: Array<{ url: string; body: unknown }> } = { puts: [] };
  const { impl, calls } = mkFetch([
    {
      match: /\/repo\/snapshots\/prepare$/,
      handler: (_u, init) => {
        state.prepareBody = JSON.parse(init!.body as string);
        const missing = opts.missing(state.prepareBody.files);
        return json({ snapshot_id: 'snap_new', total_bytes: 1, file_count: state.prepareBody.files.length, missing_blobs: missing });
      },
    },
    {
      match: /\/repo\/snapshots\/commit$/,
      handler: (_u, init) => {
        state.commitBody = JSON.parse(init!.body as string);
        return json(opts.commitBody ?? { snapshot_id: 'snap_new' }, opts.commitStatus ?? 200);
      },
    },
    {
      match: /^https:\/\/s3\/upload\//,
      method: 'PUT',
      handler: (u, init) => { state.puts.push({ url: u, body: init!.body }); return new Response('', { status: 200 }); },
    },
  ]);
  return { impl, calls, state };
}

describe('createHttpRepoSync — flush', () => {
  it('is a no-op when nothing changed against the baseline', async () => {
    cache.write(CONV, APP, 'a.ts', 'A');
    const baseline = cache.snapshotBaseline(CONV, APP);
    const { impl } = mkFetch([]);

    const sync = createHttpRepoSync({ cache, baseUrl: BASE, fetchImpl: impl });
    expect(await sync.flush({ convId: CONV, appId: APP, jwt: KEY, baseline })).toEqual({
      pushed: 0, deleted: 0, newSnapshotId: null,
    });
    expect(impl).not.toHaveBeenCalled();
  });

  it('pushes the FULL current tree, not just the changed files', async () => {
    // A snapshot manifest REPLACES its predecessor; it does not inherit from
    // it. Sending only the diff would silently drop every file the turn did not
    // touch on the next pull. Same anti-regression assertion as
    // repo-sync.test.ts's "turn 2 flush preserves files that were untouched".
    cache.write(CONV, APP, 'a.ts', 'A');
    cache.write(CONV, APP, 'b.ts', 'B');
    const baseline = cache.snapshotBaseline(CONV, APP);
    cache.write(CONV, APP, 'a.ts', 'A2');
    cache.write(CONV, APP, 'c.ts', 'C');

    const { impl, state } = mkPushFetch({ missing: () => [] });
    const sync = createHttpRepoSync({ cache, baseUrl: BASE, fetchImpl: impl });
    const r = await sync.flush({ convId: CONV, appId: APP, jwt: KEY, baseline });

    expect(r).toEqual({ pushed: 3, deleted: 0, newSnapshotId: 'snap_new' });
    expect(state.prepareBody.files.map((f: any) => f.path).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('sends the sha256 and utf8 byte size the server will verify against', async () => {
    // The server HEADs each blob and rejects the commit when the stored object
    // size disagrees with the manifest. A multi-byte character makes
    // `content.length` (UTF-16 code units) differ from the byte length, which
    // is what actually lands in S3.
    cache.write(CONV, APP, 'u.txt', 'héllo');
    const { impl, state } = mkPushFetch({ missing: () => [] });

    const sync = createHttpRepoSync({ cache, baseUrl: BASE, fetchImpl: impl });
    await sync.flush({ convId: CONV, appId: APP, jwt: KEY, baseline: new Map() });

    const entry = state.prepareBody.files[0];
    expect(entry.size).toBe(Buffer.byteLength('héllo', 'utf8'));
    expect(entry.size).not.toBe('héllo'.length);
    expect(entry.sha256).toBe(shaOf(cache, 'u.txt'));
  });

  it('uploads only the blobs prepare reports missing, then commits the same manifest', async () => {
    cache.write(CONV, APP, 'a.ts', 'A');
    cache.write(CONV, APP, 'b.ts', 'B');
    const shaA = shaOf(cache, 'a.ts');

    const { impl, state } = mkPushFetch({
      missing: () => [{ sha256: shaA, uploadUrl: `https://s3/upload/${shaA}` }],
    });
    const sync = createHttpRepoSync({ cache, baseUrl: BASE, fetchImpl: impl });
    await sync.flush({ convId: CONV, appId: APP, jwt: KEY, baseline: new Map() });

    expect(state.puts).toHaveLength(1);
    expect(state.puts[0].url).toBe(`https://s3/upload/${shaA}`);
    expect(Buffer.from(state.puts[0].body as ArrayBuffer as never).toString('utf8')).toBe('A');

    // commit must resend the IDENTICAL manifest object prepare validated —
    // the snapshot id is a hash of the canonicalised manifest, so any
    // divergence commits a different snapshot than the one prepared.
    expect(state.commitBody.manifest).toEqual(state.prepareBody);
  });

  it('throws when a presigned upload fails, so the flush is not reported as success', async () => {
    cache.write(CONV, APP, 'a.ts', 'A');
    const shaA = shaOf(cache, 'a.ts');
    const { impl } = mkFetch([
      {
        match: /\/repo\/snapshots\/prepare$/,
        handler: () => json({ snapshot_id: 'snap_new', missing_blobs: [{ sha256: shaA, uploadUrl: 'https://s3/upload/x' }] }),
      },
      { match: /^https:\/\/s3\/upload\//, method: 'PUT', handler: () => new Response('nope', { status: 500 }) },
    ]);

    const sync = createHttpRepoSync({ cache, baseUrl: BASE, fetchImpl: impl });
    await expect(sync.flush({ convId: CONV, appId: APP, jwt: KEY, baseline: new Map() })).rejects.toThrow(/500/);
  });

  it('surfaces a 413 quota rejection from prepare instead of swallowing it', async () => {
    // The per-app storage quota (routes/repo.ts) is enforced in `prepare`. This
    // client must not bypass or hide it — the operator gets the same 413 a
    // human would, and the loop's flush wrapper logs it.
    cache.write(CONV, APP, 'big.ts', 'x');
    const { impl } = mkFetch([
      {
        match: /\/repo\/snapshots\/prepare$/,
        handler: () => json({ error: 'storage_quota_exceeded', current_bytes: 99, limit_bytes: 100, manifest_bytes: 50 }, 413),
      },
    ]);

    const sync = createHttpRepoSync({ cache, baseUrl: BASE, fetchImpl: impl });
    await expect(sync.flush({ convId: CONV, appId: APP, jwt: KEY, baseline: new Map() }))
      .rejects.toThrow(/413|storage_quota_exceeded/);
  });

  it('reports deletions and skips the push when the tree is now empty', async () => {
    // Mirrors repo-sync.ts: an empty tree is not pushed. Deleting every file
    // via a snapshot with zero files is a destructive operation that no
    // end-of-turn flush should perform implicitly.
    cache.write(CONV, APP, 'a.ts', 'A');
    const baseline = cache.snapshotBaseline(CONV, APP);
    cache.delete(CONV, APP, 'a.ts');
    const { impl } = mkFetch([]);

    const sync = createHttpRepoSync({ cache, baseUrl: BASE, fetchImpl: impl });
    expect(await sync.flush({ convId: CONV, appId: APP, jwt: KEY, baseline })).toEqual({
      pushed: 0, deleted: 1, newSnapshotId: null,
    });
    expect(impl).not.toHaveBeenCalled();
  });
});

describe('createHttpRepoSync — pushCurrentTree', () => {
  it('pushes unconditionally, with no baseline short-circuit', async () => {
    // The rewind endpoint's contract: after pullSnapshot overwrites the cache
    // with an older snapshot, push that state back out so it becomes latest.
    // There is no "changed" to compare against.
    cache.write(CONV, APP, 'a.ts', 'A');
    const { impl, state } = mkPushFetch({ missing: () => [] });

    const sync = createHttpRepoSync({ cache, baseUrl: BASE, fetchImpl: impl });
    expect(await sync.pushCurrentTree({ convId: CONV, appId: APP, jwt: KEY })).toEqual({
      snapshotId: 'snap_new', filesPushed: 1,
    });
    expect(state.prepareBody.files).toHaveLength(1);
  });
});
