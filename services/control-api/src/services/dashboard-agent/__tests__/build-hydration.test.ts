/**
 * `build-hydration.ts` — the control-api half of the build-and-observe loop.
 *
 * Its whole job is to turn "the working tree as it stands right now" into
 * something a CREDENTIAL-LESS sandbox can fetch: a list of presigned,
 * blob-scoped, time-limited GET urls, plus the dependency-cache key.
 *
 * THE ONE REQUIREMENT THAT OUTRANKS THE REST is the `credential` block at the
 * bottom. The `bb_sk_*` this module authenticates with can wipe the app repo
 * (`DELETE /v1/:app_id/repo` shares `authorizeRepoWrite` with commit), and the
 * sandbox runs model-authored code with unrestricted egress. So the key must
 * be attached to control-api calls and to NOTHING ELSE — in particular it must
 * never appear in the value this function returns, which is precisely the
 * value that crosses into the guest.
 *
 * Note what this module does NOT do, deliberately: it never COMMITS. It uploads
 * the blobs the server says it is missing so they are fetchable, and stops. No
 * snapshot is created, no `latest` pointer moves, and no reader of this app
 * sees anything change because the operator asked for a build.
 */
import { describe, it, expect, vi } from 'vitest';

import { createBuildHydrator } from '../build-hydration.js';
import { WorkingTreeCache } from '../working-tree.js';

const CONV = 'conv_1';
const APP = 'app_abc';
const JWT = 'bb_sk_liveDEADBEEFdeadbeefDEADBEEFdeadbeef';

/**
 * A fetch double that answers the three control-api routes and the presigned
 * S3 PUTs, and records every request so the credential assertions can inspect
 * where the header actually went.
 */
function harness(opts: { missing?: string[] } = {}) {
  const calls: { url: string; method: string; auth: string | null; body: string | null }[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: u,
      method: init?.method ?? 'GET',
      auth: headers.authorization ?? null,
      body: typeof init?.body === 'string' ? init.body : null,
    });

    if (u.includes('/repo/snapshots/prepare')) {
      const manifest = JSON.parse(String(init!.body)) as { files: { sha256: string }[] };
      const missing = opts.missing ?? manifest.files.map((f) => f.sha256);
      return new Response(JSON.stringify({
        snapshot_id: 'snap_1',
        missing_blobs: [...new Set(missing)].map((sha) => ({ sha256: sha, uploadUrl: `https://s3.example/put/${sha}?sig=p` })),
      }), { status: 200 });
    }
    if (u.includes('/repo/build-cache')) {
      const { lockfile_hash } = JSON.parse(String(init!.body)) as { lockfile_hash: string };
      return new Response(JSON.stringify({
        downloadUrl: `https://s3.example/cache/${lockfile_hash}.tar?sig=cg`,
        uploadUrl: `https://s3.example/cache/${lockfile_hash}.tar?sig=cp`,
        expiresIn: 600,
      }), { status: 200 });
    }
    if (u.includes('/repo/blobs/batch')) {
      const { shas } = JSON.parse(String(init!.body)) as { shas: string[] };
      return new Response(JSON.stringify({
        blobs: shas.map((sha) => ({ sha256: sha, downloadUrl: `https://s3.example/get/${sha}?sig=g` })),
      }), { status: 200 });
    }
    return new Response('', { status: 200 });
  });

  const cache = new WorkingTreeCache();
  return { calls, fetchImpl, cache };
}

function hydratorFor(h: ReturnType<typeof harness>) {
  return createBuildHydrator({
    cache: h.cache,
    baseUrl: 'http://control.local',
    fetchImpl: h.fetchImpl as unknown as typeof fetch,
  });
}

describe('createBuildHydrator — presigned urls for the current tree', () => {
  it('returns one url per file, addressed by the file path', async () => {
    const h = harness();
    h.cache.write(CONV, APP, 'package.json', '{"name":"x"}');
    h.cache.write(CONV, APP, 'src/App.tsx', 'export default () => null');

    const r = await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });

    expect(r.files.map((f) => f.path).sort()).toEqual(['package.json', 'src/App.tsx']);
    for (const f of r.files) expect(f.url).toMatch(/^https:\/\/s3\.example\/get\//);
  });

  it('uploads only the blobs the server says it is missing', async () => {
    const h = harness({ missing: [] });
    h.cache.write(CONV, APP, 'a.ts', 'const a = 1');
    await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });
    expect(h.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('PUTs a missing blob before presigning it', async () => {
    const h = harness();
    h.cache.write(CONV, APP, 'a.ts', 'const a = 1');
    await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });
    const puts = h.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toContain('s3.example/put/');
    // Ordering matters: presigning a blob that is not stored yet returns
    // nothing for it (the batch route filters on `exists`).
    const putIdx = h.calls.findIndex((c) => c.method === 'PUT');
    const batchIdx = h.calls.findIndex((c) => c.url.includes('/blobs/batch'));
    expect(putIdx).toBeLessThan(batchIdx);
  });

  it('NEVER commits — no snapshot is created by asking for a build', async () => {
    const h = harness();
    h.cache.write(CONV, APP, 'a.ts', 'const a = 1');
    await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });
    expect(h.calls.some((c) => c.url.includes('/snapshots/commit'))).toBe(false);
  });

  it('presigns each distinct sha once even when paths share content', async () => {
    const h = harness();
    h.cache.write(CONV, APP, 'a.ts', 'export {}');
    h.cache.write(CONV, APP, 'b.ts', 'export {}');
    const r = await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });
    const batch = h.calls.find((c) => c.url.includes('/blobs/batch'))!;
    expect((JSON.parse(batch.body!) as { shas: string[] }).shas).toHaveLength(1);
    // ...but both paths still get a url.
    expect(r.files).toHaveLength(2);
    expect(r.files[0].url).toBe(r.files[1].url);
  });

  it('refuses to build an empty workspace rather than shipping a no-op', async () => {
    const h = harness();
    await expect(hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT }))
      .rejects.toThrow(/no files/i);
  });

  it('throws with the server status when a blob has no download url', async () => {
    const h = harness();
    h.fetchImpl.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/prepare')) return new Response(JSON.stringify({ snapshot_id: 's', missing_blobs: [] }), { status: 200 });
      if (u.includes('/blobs/batch')) return new Response(JSON.stringify({ blobs: [] }), { status: 200 });
      return new Response('', { status: 200 });
    });
    h.cache.write(CONV, APP, 'a.ts', 'x');
    await expect(hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT }))
      .rejects.toThrow(/download url/i);
  });

  it('surfaces a 403 rather than laundering it into an empty build', async () => {
    const h = harness();
    h.fetchImpl.mockImplementation(async () => new Response('forbidden', { status: 403 }));
    h.cache.write(CONV, APP, 'a.ts', 'x');
    await expect(hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT }))
      .rejects.toThrow(/403/);
  });
});

describe('createBuildHydrator — the dependency cache key', () => {
  it('hashes the lockfile when there is one', async () => {
    const h = harness();
    h.cache.write(CONV, APP, 'package.json', '{"name":"x"}');
    h.cache.write(CONV, APP, 'package-lock.json', '{"lockfileVersion":3}');
    const r = await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });
    expect(r.installKey).toMatch(/^[a-f0-9]{64}$/);

    // Editing source must not invalidate the install cache.
    h.cache.write(CONV, APP, 'src/x.ts', 'changed');
    const again = await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });
    expect(again.installKey).toBe(r.installKey);
  });

  it('falls back to package.json when there is no lockfile', async () => {
    // dashboard-agent-template ships no lockfile. deploy.ts:40-43 makes the
    // same fallback, and this must agree with it or the sandbox and the
    // build-runner would key their caches differently.
    const h = harness();
    h.cache.write(CONV, APP, 'package.json', '{"dependencies":{"react":"18"}}');
    const a = await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });
    expect(a.installKey).toMatch(/^[a-f0-9]{64}$/);

    h.cache.write(CONV, APP, 'package.json', '{"dependencies":{"react":"19"}}');
    const b = await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });
    expect(b.installKey).not.toBe(a.installKey);
  });

  it('changes when the lockfile changes', async () => {
    const h = harness();
    h.cache.write(CONV, APP, 'package-lock.json', 'v1');
    const a = await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });
    h.cache.write(CONV, APP, 'package-lock.json', 'v2');
    const b = await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });
    expect(b.installKey).not.toBe(a.installKey);
  });
});

describe('createBuildHydrator — the shared R2 node_modules cache', () => {
  it('mints a GET and a PUT url for the cache, keyed on the SAME hash as the install key', async () => {
    // The sharing guarantee, at this end: the operator asks for the cache
    // object the build-runner will read (`cache/<appId>/<lockfileHash>.tar`,
    // r2.ts `buildCacheKey`). Asking on a different hash than the one the
    // sandbox installs against would warm a cache nobody reads.
    const h = harness();
    h.cache.write(CONV, APP, 'package-lock.json', '{"lockfileVersion":3}');
    const r = await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });

    expect(r.cache).toBeDefined();
    expect(r.cache!.getUrl).toContain(r.installKey);
    expect(r.cache!.putUrl).toContain(r.installKey);

    const req = h.calls.find((c) => c.url.includes('/repo/build-cache'))!;
    expect(JSON.parse(req.body!)).toEqual({ lockfile_hash: r.installKey });
  });

  it('still builds when the cache presign fails — the cache is advisory', async () => {
    // A build that cannot be accelerated is a slow build. A build that REFUSES
    // to run because a cache url could not be minted is a broken operator, and
    // the cache is a performance layer, not a dependency.
    const h = harness();
    const inner = h.fetchImpl.getMockImplementation()!;
    h.fetchImpl.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('/repo/build-cache')) return new Response('nope', { status: 500 });
      return inner(url, init);
    });
    h.cache.write(CONV, APP, 'a.ts', 'x');

    const r = await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });
    expect(r.files).toHaveLength(1);
    expect(r.cache).toBeNull();
  });
});

describe('credential — the service key reaches control-api and nothing else', () => {
  it('is attached to control-api calls', async () => {
    const h = harness();
    h.cache.write(CONV, APP, 'a.ts', 'x');
    await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });
    const api = h.calls.filter((c) => c.url.startsWith('http://control.local'));
    expect(api.length).toBeGreaterThan(0);
    for (const c of api) expect(c.auth).toBe(`Bearer ${JWT}`);
  });

  it('is NEVER attached to a presigned storage host', async () => {
    // A presigned url is already authorized; bolting an org service key onto
    // an arbitrary storage host leaks it off-platform. Same rule repo-http.ts
    // states for its own bare `doFetch`.
    const h = harness();
    h.cache.write(CONV, APP, 'a.ts', 'x');
    await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });
    const s3 = h.calls.filter((c) => c.url.includes('s3.example'));
    expect(s3.length).toBeGreaterThan(0);
    for (const c of s3) expect(c.auth).toBeNull();
  });

  it('is absent from the RETURNED value — the thing that crosses into the guest', async () => {
    // THE assertion. Everything this returns is handed to a sandbox running
    // model-authored code with unrestricted egress. Includes the cache urls:
    // they are inside the same guarantee, not alongside it.
    const h = harness();
    h.cache.write(CONV, APP, 'package.json', '{}');
    h.cache.write(CONV, APP, 'src/a.ts', 'x');
    const r = await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });
    expect(r.cache).not.toBeNull();

    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain(JWT);
    expect(serialized).not.toContain('bb_sk_');
    expect(serialized).not.toMatch(/authorization|bearer/i);
  });

  it('returns files carrying exactly {path, url} and nothing else', async () => {
    // Shape assertion, so a future field cannot smuggle anything across by
    // being added without anyone noticing which side of the boundary it is on.
    const h = harness();
    h.cache.write(CONV, APP, 'a.ts', 'x');
    const r = await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });
    for (const f of r.files) expect(Object.keys(f).sort()).toEqual(['path', 'url']);
  });

  it('does not return file CONTENT either', async () => {
    // Not a credential rule, a size rule — but the same boundary. Content goes
    // to storage once and is fetched by the guest directly; it must not also
    // travel through the tool result.
    const h = harness();
    h.cache.write(CONV, APP, 'secret-ish.ts', 'const TOKEN = "sentinel-content-value"');
    const r = await hydratorFor(h).hydrate({ convId: CONV, appId: APP, jwt: JWT });
    expect(JSON.stringify(r)).not.toContain('sentinel-content-value');
  });
});
