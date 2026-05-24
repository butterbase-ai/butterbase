# Reverse-Move KV Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `runReverseMove`'s fast path migrate KV from forward-dest back to original-source, closing the split-region gap left by Plan 6 Task 8.

**Architecture:** Extract `dumpKvFromRegion` and `restoreKvIntoRegion` as pure helpers from the existing saga steps. Add a new `clearKvScope` helper that SCAN+UNLINKs `{appId}:*` across both DBs. Fast-path reverse-move calls dump → clear → restore inline. The existing saga handlers become thin wrappers preserving current behavior; the slow path (already saga-driven) is unchanged.

**Tech Stack:** Same as Plan 6 — `ioredis` via `RedisClient` wrapper, `@aws-sdk/client-s3` + `Upload`, Node `zlib`/`readline`/`stream`, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-23-reverse-move-kv-fix-design.md` (committed at `bea8af4`).

**Scope NOT in this plan:**
- Write block during fast-path reverse. Per spec, best-effort: writes during the dump+restore window may be lost on the flip. Documented user-visible trade-off.
- PG rollback on KV failure. If KV reverse fails after PG promotion the error bubbles; caller retries.
- Reverse-replication for KV. Always re-dumps.

---

## Pre-Execution Context

**Repo layout:**
- Code: `/Users/kenneth/Documents/butterbase_backup/butterbase/submodules/butterbase-oss/`
- Branch: continue on `feat/kv-plan-6-move-app-kv` (Plan 6's branch). All commits land here.

**What Plan 6 shipped that this plan integrates with:**
- `services/control-api/src/services/move-app/step-dump-kv.ts` — currently exports `executeDumpKv` (StepHandler), `kvBaseOptsForRegion(region)`, internal helpers `bucketForRegion`, `defaultS3Client`, `defaultUpload`, `shouldSkipKey`, `defaultIterateRecords`. This plan promotes the body of `executeDumpKv` into an exported `dumpKvFromRegion(opts)` function. The handler becomes a wrapper.
- `services/control-api/src/services/move-app/step-restore-kv.ts` — currently exports `toKvRegion(region)`, `executeRestoreKv` (StepHandler), internal helpers `bucketForRegion`, `defaultS3Client`, `defaultDownload`, `defaultBaseOpts`, `assertDestEmpty`. This plan promotes the body of `executeRestoreKv` into an exported `restoreKvIntoRegion(opts)` function. The handler becomes a wrapper.
- `services/control-api/src/services/move-app/reverse-move.ts` — has a fast path that promotes the original-source's Postgres replica and emits a `log.warn` about the KV gap. This plan removes the warn and inserts the dump→clear→restore call sequence between `promoteSourceToPrimary` and `updateUserAppIndexRegion`.
- `services/control-api/src/services/kv/redis-client.ts` — already exposes `unlink([keys])`, `scan(cursor, match, count)`, `dump(key)`, `restore(key, ttlMs, payload, opts?)`, `select(db)` is NOT available (existing convention: open fresh `RedisClient.connect({...baseOpts, db})` per DB).
- `services/control-api/src/services/move-app/migration-store.ts` — `HAPPY_PATH_ORDER` already includes `dumping_kv` and `restoring_kv`. No saga-level changes here.
- `docs/superpowers/notes/2026-05-24-kv-reverse-move-gap.md` — the Task 8 fallback note. This plan adds a "Resolved" header pointing at the new commits.

**Existing substrate (REUSE, do not reinvent):**
- The `kvBaseOptsForRegion` helper in `step-dump-kv.ts` is the canonical URL-parsing entry point. Both helpers and `clearKvScope` should accept it via injection (test seam) but default to the export.
- The S3 upload/download conventions live in `step-dump-kv.ts` (upload) and `step-restore-kv.ts` (download). Helpers extracted in Tasks 1 + 2 keep these as defaults but expose `uploadFn` / `downloadFn` injection.
- `toKvRegion` (exported from `step-restore-kv.ts`) is the only place that maps long-form → short-form. `restoreKvIntoRegion` must call it on `flipTo` before the SQL UPDATE.

**Critical traps:**
- **Per-DB clients.** Plan 6 went out of its way NOT to call `.select(db)` on the shared `kvRedisFor()` connection (race-condition with concurrent ops). All three helpers in this plan open fresh `RedisClient.connect({...baseOpts, db})` per DB and close in `finally`. Do not switch back to a shared `.select()` pattern.
- **`flipTo` must use `toKvRegion`.** The helper takes long-form regions (e.g. `'us-east-1'`) but `app_kv_credentials.region` stores short form (e.g. `'us'`). Plan 6's `step-restore-kv` already maps via `toKvRegion`; the extracted helper must preserve this. Tests must assert short form is written.
- **Pre-clear before restore.** The reverse fast path's original-source KV scope contains stale keys from before the forward move. The `restoreKvIntoRegion` helper's empty-dest guard would throw `non_empty_dest`. Pre-clear with `clearKvScope` to satisfy the guard AND to remove ghost keys (keys present pre-forward but absent in current dump).
- **`clearKvScope` returns count, not keys.** Returning the actual keys would be a memory hazard on large scopes. Just the count for logging.
- **Idempotence by replay.** The three-step sequence (dump → clear → restore → flip) is naturally idempotent if re-run from the top. We do NOT add per-step checkpoints in `runReverseMove` — fast path is short and synchronous. If a step fails, error bubbles; user retries by re-invoking reverse-move; we re-dump and re-clear from scratch.
- **`RestoreKvOpts.flipTo` is explicit.** Pass it separately from `destRegion` so the helper cannot accidentally flip routing to the wrong region. Forward saga and reverse fast path both pass the same value as `destRegion` — that's a coincidence, not an invariant.
- **PassThrough/gzip race.** The dump helper's existing pattern writes lines into a `PassThrough`, pipes to `createGzip`, awaits the upload promise. Plan 6 spec compliance verified the pipeline doesn't race. Preserve the pattern verbatim in the extraction.

**Verification rule (per `feedback_verify_with_build.md`):** full `pnpm -r build` for control-api. Live smoke is optional for this plan — the fast-path reverse needs real Neon physical replication to drive `source_replica_state === 'replicating'`. Unit tests with injection seams cover the call-order invariant.

---

## File Structure

**Created:**
- `services/control-api/src/services/kv/kv-scope.ts` — `clearKvScope(region, appId, baseOpts?) → Promise<number>`. SCAN+UNLINK `{appId}:*` across DB 0 and DB 1; returns count deleted.
- `services/control-api/src/services/kv/kv-scope.test.ts` — gated integration test against real KV Redis.

**Modified:**
- `services/control-api/src/services/move-app/step-dump-kv.ts` — extract `dumpKvFromRegion(opts)`; `executeDumpKv` becomes a thin wrapper.
- `services/control-api/src/services/move-app/step-dump-kv.test.ts` — add 2 cases for the exported helper.
- `services/control-api/src/services/move-app/step-restore-kv.ts` — extract `restoreKvIntoRegion(opts)`; `executeRestoreKv` becomes a thin wrapper. Move `defaultBaseOpts` → import `kvBaseOptsForRegion` from `step-dump-kv.ts` for single source of truth.
- `services/control-api/src/services/move-app/step-restore-kv.test.ts` — add 2 cases for the exported helper.
- `services/control-api/src/services/move-app/reverse-move.ts` — remove Task 8 `log.warn`; add `dumpKvFromRegion`/`clearKvScope`/`restoreKvIntoRegion` injection points to `ReverseMoveCtx`; inline dump → clear → restore between `promoteSourceToPrimary` and `updateUserAppIndexRegion`.
- `services/control-api/src/services/move-app/reverse-move.test.ts` — replace the "emits a warn log" test with "fast path calls dump → clear → restore in order with correct regions"; ensure the not-completed and slow-path tests still pass.
- `docs/superpowers/notes/2026-05-24-kv-reverse-move-gap.md` — prepend a "Resolved" header pointing at this plan's commits.

**Deleted:** none.

---

## Tasks

### Task 1: Extract `dumpKvFromRegion` helper from `step-dump-kv.ts`

**Files:**
- Modify: `services/control-api/src/services/move-app/step-dump-kv.ts`
- Modify: `services/control-api/src/services/move-app/step-dump-kv.test.ts`

- [ ] **Step 1: Read the current `step-dump-kv.ts`**

Read the file end-to-end. Identify the body of `executeDumpKv` from the line `const key = \`move-app/${m.id}/dump.kv.jsonl.gz\`;` onward, including the upload-promise + iterator drain + return. This becomes the body of `dumpKvFromRegion`.

- [ ] **Step 2: Add the failing test for the extracted helper**

Append to `step-dump-kv.test.ts` inside the existing `describe('executeDumpKv', ...)` block, or create a new sibling `describe('dumpKvFromRegion', ...)` block at the file level. Pick the latter — clearer separation. Add:

```ts
import { dumpKvFromRegion } from './step-dump-kv.js';
import { gunzipSync } from 'node:zlib';
import type { Readable } from 'node:stream';

describe('dumpKvFromRegion (exported helper)', () => {
  it('returns { key, records } and uploads to move-app/<migrationId>/dump.kv.jsonl.gz', async () => {
    const chunks: Buffer[] = [];
    const uploadFn = async (k: string, body: Readable) => {
      for await (const c of body) chunks.push(c as Buffer);
      return { key: k, bytes: chunks.reduce((s, c) => s + c.length, 0) };
    };
    const records = (async function* () {
      yield { db: 0 as const, key: '{a}:u:x', ttl_ms: -1, payload_b64: 'AAA=' };
      yield { db: 0 as const, key: '{a}:u:y', ttl_ms: 5000, payload_b64: 'BAA=' };
    })();

    const res = await dumpKvFromRegion({
      sourceRegion: 'us-east-1',
      appId: 'a',
      migrationId: 'mig-extracted-1',
      log: { info: vi.fn() },
      uploadFn,
      kvBaseOptsForRegion: () => ({ host: 'unused', port: 0, password: '' }),
      kvDumpRecords: () => records,
    });

    expect(res).toEqual({ key: 'move-app/mig-extracted-1/dump.kv.jsonl.gz', records: 2 });
    const lines = gunzipSync(Buffer.concat(chunks)).toString('utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).key).toBe('{a}:u:x');
  });

  it('migrationId param is interpolated into the R2 key (not a literal string)', async () => {
    const seen: string[] = [];
    await dumpKvFromRegion({
      sourceRegion: 'us-east-1',
      appId: 'a',
      migrationId: 'CUSTOM-ID-XYZ',
      log: { info: vi.fn() },
      uploadFn: async (k, body) => {
        seen.push(k);
        for await (const _ of body) { /* drain */ }
        return { key: k, bytes: 0 };
      },
      kvBaseOptsForRegion: () => ({ host: 'x', port: 0, password: '' }),
      kvDumpRecords: () => (async function* () { /* empty */ })(),
    });
    expect(seen[0]).toBe('move-app/CUSTOM-ID-XYZ/dump.kv.jsonl.gz');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```
cd /Users/kenneth/Documents/butterbase_backup/butterbase/submodules/butterbase-oss
pnpm --filter @butterbase/control-api test step-dump-kv -t "dumpKvFromRegion"
```

Expected: FAIL with `dumpKvFromRegion is not a function` or import resolution error.

- [ ] **Step 4: Extract the helper**

In `step-dump-kv.ts`, define a new interface and exported function ABOVE `executeDumpKv`:

```ts
export interface DumpKvOpts {
  sourceRegion: string;
  appId: string;
  migrationId: string;
  log: { info: (...args: any[]) => void };
  /** Test seam — overrides the default S3 upload. */
  uploadFn?: (key: string, body: Readable) => Promise<{ key: string; bytes: number }>;
  /** Test seam — provides a custom record iterator (skips Redis entirely). */
  kvDumpRecords?: (region: string, appId: string) => AsyncIterable<KvDumpRecord>;
  /** Test seam — overrides KV connection opts for the default iterator. */
  kvBaseOptsForRegion?: (region: string) => Omit<RedisClientOptions, 'db'>;
}

/**
 * Pure helper: dumps an app's KV scope from `sourceRegion` to R2 as a gzipped
 * JSON-lines file and returns the object key + record count.
 *
 * Used by:
 *   - `executeDumpKv` (saga StepHandler wrapper)
 *   - `runReverseMove` fast path (KV reverse-migration)
 */
export async function dumpKvFromRegion(opts: DumpKvOpts): Promise<{ key: string; records: number }> {
  const uploadFn = opts.uploadFn
    ? opts.uploadFn
    : (k: string, body: Readable) => defaultUpload(opts.sourceRegion, k, body);
  const iter = opts.kvDumpRecords
    ? opts.kvDumpRecords(opts.sourceRegion, opts.appId)
    : defaultIterateRecords(
        (opts.kvBaseOptsForRegion ?? kvBaseOptsForRegion)(opts.sourceRegion),
        opts.appId,
      );

  const key = `move-app/${opts.migrationId}/dump.kv.jsonl.gz`;
  const lines = new PassThrough();
  const gz = createGzip();
  lines.pipe(gz);
  const uploadPromise = uploadFn(key, gz);

  let recordCount = 0;
  try {
    for await (const rec of iter) {
      lines.write(serializeRecord(rec) + '\n');
      recordCount++;
    }
    lines.end();
  } catch (e) {
    lines.destroy(e as Error);
    throw e;
  }

  const upResult = await uploadPromise;
  opts.log.info(
    { migrationId: opts.migrationId, key: upResult.key, records: recordCount },
    'kv dump uploaded',
  );
  return { key: upResult.key, records: recordCount };
}
```

Then rewrite `executeDumpKv` as a thin wrapper:

```ts
export const executeDumpKv: StepHandler = async (ctx, m) => {
  if (m.dest_resources.kv_dump_object_key) {
    return { next: 'restoring_kv', patch: {} };
  }
  const cx = ctx as unknown as DumpKvCtx & typeof ctx;
  const { key, records } = await dumpKvFromRegion({
    sourceRegion: m.source_region,
    appId: m.app_id,
    migrationId: m.id,
    log: ctx.log,
    uploadFn: cx.uploadKvDump,
    kvDumpRecords: cx.kvDumpRecords,
    kvBaseOptsForRegion: cx.kvBaseOptsForRegion,
  });
  return {
    next: 'restoring_kv',
    patch: { kv_dump_object_key: key, kv_dump_records: records },
  };
};
```

The existing internal helpers (`defaultUpload`, `defaultIterateRecords`, `shouldSkipKey`, `bucketForRegion`, `defaultS3Client`, `kvBaseOptsForRegion`) stay in place. `DumpKvCtx` stays — `executeDumpKv` still reads from it.

- [ ] **Step 5: Run all `step-dump-kv` tests**

```
cd /Users/kenneth/Documents/butterbase_backup/butterbase/submodules/butterbase-oss
RUN_DB_TESTS=1 KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  pnpm --filter @butterbase/control-api test step-dump-kv
```

Expected: all existing handler-level tests still pass; the 2 new helper-level tests pass.

- [ ] **Step 6: Build**

```
pnpm --filter @butterbase/control-api build
```

Expected: clean (no errors).

- [ ] **Step 7: Commit**

```
git add services/control-api/src/services/move-app/step-dump-kv.ts \
        services/control-api/src/services/move-app/step-dump-kv.test.ts
git commit -m "refactor(move-app): extract dumpKvFromRegion helper from executeDumpKv"
```

(No `Co-Authored-By` trailer.)

---

### Task 2: Extract `restoreKvIntoRegion` helper from `step-restore-kv.ts`

**Files:**
- Modify: `services/control-api/src/services/move-app/step-restore-kv.ts`
- Modify: `services/control-api/src/services/move-app/step-restore-kv.test.ts`

- [ ] **Step 1: Read the current `step-restore-kv.ts`**

Identify the body of `executeRestoreKv` from the `assertDestEmpty(...)` call onward through the routing-flip UPDATE and `log.info`. This becomes the body of `restoreKvIntoRegion`.

- [ ] **Step 2: Add the failing tests for the extracted helper**

Append to `step-restore-kv.test.ts` a new `describe('restoreKvIntoRegion (exported helper)', ...)` block:

```ts
import { restoreKvIntoRegion } from './step-restore-kv.js';

describe('restoreKvIntoRegion (exported helper)', () => {
  it('flips app_kv_credentials.region to toKvRegion(flipTo), not destRegion', async () => {
    const controlPool: any = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const downloadKvDump = async () => Readable.from([Buffer.alloc(0)]); // empty dump → 0 records
    // Make assertDestEmpty pass: kvBaseOptsForRegion → opts that point at a real empty KV scope.
    const empty: Omit<RedisClientOptions, 'db'> = { host: 'localhost', port: 0, password: '' };

    // To avoid touching real Redis, override the dest scan via a different test seam:
    // we cannot bypass assertDestEmpty without injecting deeper. Use the gated integration
    // test (next case) for the empty-dest path. Here we only verify the flip SQL is correct
    // by short-circuiting via a fake controlPool that records the call.
    // For the unit test, gate this case on KV_REDIS_URL_US so assertDestEmpty has something
    // to scan (empty scope under a random appId is empty by default).
    if (!process.env.KV_REDIS_URL_US) return; // skip in CI without KV

    const url = new URL(process.env.KV_REDIS_URL_US);
    const base: Omit<RedisClientOptions, 'db'> = {
      host: url.hostname,
      port: Number(url.port) || 6379,
      password: url.password ? decodeURIComponent(url.password) : '',
    };

    await restoreKvIntoRegion({
      destRegion: 'us-east-1',
      sourceRegionForBucket: 'eu-west-1',
      appId: `flip-test-${crypto.randomUUID()}`,
      key: 'mock-key',
      controlPool,
      flipTo: 'eu-west-1', // distinct from destRegion to prove flipTo is used
      log: { info: vi.fn() },
      downloadFn: downloadKvDump,
      kvBaseOptsForRegion: () => base,
    });

    const updateCall = controlPool.query.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('UPDATE app_kv_credentials'),
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall[1][0]).toBe('eu'); // toKvRegion('eu-west-1') → 'eu'
  });

  it('non-empty dest guard still fires (rejects with non_empty_dest)', async () => {
    if (!process.env.KV_REDIS_URL_US) return; // gated integration

    const url = new URL(process.env.KV_REDIS_URL_US);
    const base: Omit<RedisClientOptions, 'db'> = {
      host: url.hostname,
      port: Number(url.port) || 6379,
      password: url.password ? decodeURIComponent(url.password) : '',
    };
    const appId = `nonempty-test-${crypto.randomUUID()}`;

    // Seed a non-_meta:bytes key to trip the guard.
    const c = await RedisClient.connect({ ...base, db: 0 });
    try {
      await c.set(`{${appId}}:u:stale`, 'x');
    } finally {
      await c.close();
    }

    const controlPool: any = { query: vi.fn() };
    await expect(restoreKvIntoRegion({
      destRegion: 'us-east-1',
      sourceRegionForBucket: 'eu-west-1',
      appId,
      key: 'mock',
      controlPool,
      flipTo: 'us-east-1',
      log: { info: vi.fn() },
      downloadFn: async () => Readable.from([]),
      kvBaseOptsForRegion: () => base,
    })).rejects.toThrow(/non_empty_dest/);

    // Cleanup
    const c2 = await RedisClient.connect({ ...base, db: 0 });
    try { await c2.del([`{${appId}}:u:stale`]); } finally { await c2.close(); }
  });
});
```

(Adjust imports at the top of the test file if `RedisClient`, `Readable`, `crypto` aren't already imported.)

- [ ] **Step 3: Run the test to verify it fails**

```
pnpm --filter @butterbase/control-api test step-restore-kv -t "restoreKvIntoRegion"
```

Expected: FAIL with `restoreKvIntoRegion is not a function` or import error.

- [ ] **Step 4: Extract the helper**

In `step-restore-kv.ts`, add the interface and exported function ABOVE `executeRestoreKv`:

```ts
export interface RestoreKvOpts {
  destRegion: string;
  sourceRegionForBucket: string;
  appId: string;
  key: string;
  controlPool: import('pg').Pool;
  /** Long-form region whose toKvRegion() value is written to app_kv_credentials.region. */
  flipTo: string;
  log: { info: (...args: any[]) => void };
  downloadFn?: (key: string) => Promise<Readable>;
  kvBaseOptsForRegion?: (region: string) => Omit<RedisClientOptions, 'db'>;
}

/**
 * Pure helper: downloads the KV dump at `key` from `sourceRegionForBucket`,
 * restores into `destRegion`'s Redis (asserts dest scope empty first), then
 * flips `app_kv_credentials.region` to `toKvRegion(flipTo)`.
 *
 * Used by:
 *   - `executeRestoreKv` (saga StepHandler wrapper)
 *   - `runReverseMove` fast path
 */
export async function restoreKvIntoRegion(opts: RestoreKvOpts): Promise<{ records: number }> {
  const baseOptsFn = opts.kvBaseOptsForRegion ?? defaultBaseOpts;
  const destBase = baseOptsFn(opts.destRegion);

  await assertDestEmpty(destBase, opts.appId);

  const body = opts.downloadFn
    ? await opts.downloadFn(opts.key)
    : await defaultDownload(opts.sourceRegionForBucket, opts.key);

  const gunzipped = body.pipe(createGunzip());
  const rl = createInterface({ input: gunzipped, crlfDelay: Infinity });

  const clients = new Map<0 | 1, RedisClient>();
  async function clientForDb(db: 0 | 1): Promise<RedisClient> {
    let c = clients.get(db);
    if (!c) {
      c = await RedisClient.connect({ ...destBase, db });
      clients.set(db, c);
    }
    return c;
  }

  let restored = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const rec = parseRecord(line);
      const c = await clientForDb(rec.db);
      const ttl = rec.ttl_ms < 0 ? 0 : rec.ttl_ms;
      await c.restore(rec.key, ttl, payloadToBuffer(rec.payload_b64), { replace: true });
      restored++;
    }
  } finally {
    for (const c of clients.values()) await c.close();
  }

  await opts.controlPool.query(
    'UPDATE app_kv_credentials SET region = $1, rotated_at = now() WHERE app_id = $2',
    [toKvRegion(opts.flipTo), opts.appId],
  );

  opts.log.info({ appId: opts.appId, restored }, 'kv restored + routing flipped');
  return { records: restored };
}
```

Then rewrite `executeRestoreKv` as a thin wrapper:

```ts
export const executeRestoreKv: StepHandler = async (ctx, m) => {
  if (m.dest_resources.kv_restored_at) {
    return { next: 'copying_blobs', patch: {} };
  }
  const cx = ctx as unknown as RestoreKvCtx & typeof ctx;
  const key = m.dest_resources.kv_dump_object_key as string | undefined;
  if (!key) {
    throw new Error(`restore_kv: missing kv_dump_object_key on migration ${m.id}`);
  }
  const { records } = await restoreKvIntoRegion({
    destRegion: m.dest_region,
    sourceRegionForBucket: m.source_region,
    appId: m.app_id,
    key,
    controlPool: ctx.controlPool,
    flipTo: m.dest_region,
    log: ctx.log,
    downloadFn: cx.downloadKvDump,
    kvBaseOptsForRegion: cx.kvBaseOptsForRegion,
  });
  return {
    next: 'copying_blobs',
    patch: {
      kv_restored_at: new Date().toISOString(),
      kv_restored_records: records,
    },
  };
};
```

Keep `defaultBaseOpts`, `defaultDownload`, `bucketForRegion`, `defaultS3Client`, `assertDestEmpty`, `toKvRegion` exactly as they are.

- [ ] **Step 5: Run all `step-restore-kv` tests**

```
RUN_DB_TESTS=1 \
  KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  KV_REDIS_URL_EU=redis://:butterbase_dev_kv@localhost:6391 \
  NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  pnpm --filter @butterbase/control-api test step-restore-kv
```

Expected: all existing handler-level tests pass; the 2 new helper-level tests pass.

- [ ] **Step 6: Build**

```
pnpm --filter @butterbase/control-api build
```

Expected: clean.

- [ ] **Step 7: Commit**

```
git add services/control-api/src/services/move-app/step-restore-kv.ts \
        services/control-api/src/services/move-app/step-restore-kv.test.ts
git commit -m "refactor(move-app): extract restoreKvIntoRegion helper from executeRestoreKv"
```

(No `Co-Authored-By` trailer.)

---

### Task 3: Create `kv-scope.ts` with `clearKvScope`

**Files:**
- Create: `services/control-api/src/services/kv/kv-scope.ts`
- Create: `services/control-api/src/services/kv/kv-scope.test.ts`

- [ ] **Step 1: Add the failing test**

Create `services/control-api/src/services/kv/kv-scope.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RedisClient } from './redis-client.js';
import { clearKvScope } from './kv-scope.js';

const RUN_KV_TESTS = !!process.env.KV_REDIS_URL_US;
const describeKv = RUN_KV_TESTS ? describe : describe.skip;

function baseOptsFromEnv() {
  const u = new URL(process.env.KV_REDIS_URL_US!);
  return {
    host: u.hostname,
    port: Number(u.port) || 6379,
    password: u.password ? decodeURIComponent(u.password) : '',
  };
}

describeKv('clearKvScope', () => {
  const appId = `scope-test-${randomUUID()}`;
  const base = baseOptsFromEnv();

  beforeEach(async () => {
    const c0 = await RedisClient.connect({ ...base, db: 0 });
    const c1 = await RedisClient.connect({ ...base, db: 1 });
    try {
      await c0.set(`{${appId}}:u:a`, 'va');
      await c0.set(`{${appId}}:u:b`, 'vb');
      await c0.set(`{${appId}}:_meta:bytes`, '42');
      await c1.set(`{${appId}}:u:eph`, 've');
    } finally {
      await c0.close();
      await c1.close();
    }
  });

  afterEach(async () => {
    // Defensive cleanup if a test threw before clearing.
    const c0 = await RedisClient.connect({ ...base, db: 0 });
    const c1 = await RedisClient.connect({ ...base, db: 1 });
    try {
      let cur = '0';
      do {
        const [next, ks] = await c0.scan(cur, `{${appId}}:*`, 500);
        cur = next;
        if (ks.length) await c0.del(ks);
      } while (cur !== '0');
      cur = '0';
      do {
        const [next, ks] = await c1.scan(cur, `{${appId}}:*`, 500);
        cur = next;
        if (ks.length) await c1.del(ks);
      } while (cur !== '0');
    } finally {
      await c0.close();
      await c1.close();
    }
  });

  it('deletes all {appId}:* keys across both DBs and returns the count', async () => {
    const count = await clearKvScope('us-east-1', appId, base);
    expect(count).toBe(4);

    // Verify scope is empty
    const c0 = await RedisClient.connect({ ...base, db: 0 });
    const c1 = await RedisClient.connect({ ...base, db: 1 });
    try {
      const [, k0] = await c0.scan('0', `{${appId}}:*`, 500);
      const [, k1] = await c1.scan('0', `{${appId}}:*`, 500);
      expect(k0).toEqual([]);
      expect(k1).toEqual([]);
    } finally {
      await c0.close();
      await c1.close();
    }
  });

  it('returns 0 when the scope has no keys', async () => {
    const emptyAppId = `empty-scope-${randomUUID()}`;
    const count = await clearKvScope('us-east-1', emptyAppId, base);
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  pnpm --filter @butterbase/control-api test kv-scope
```

Expected: FAIL with `Cannot find module './kv-scope.js'`.

- [ ] **Step 3: Implement `clearKvScope`**

Create `services/control-api/src/services/kv/kv-scope.ts`:

```ts
// services/control-api/src/services/kv/kv-scope.ts
// SCAN+UNLINK helper for clearing an app's KV scope across DB 0 + DB 1.
// Used by reverse-move (fast path) to pre-empty the destination before restore.

import { RedisClient, type RedisClientOptions } from './redis-client.js';
import { kvBaseOptsForRegion } from '../move-app/step-dump-kv.js';

/**
 * Delete every `{appId}:*` key on both DB 0 and DB 1 of the given region's
 * KV substrate. Uses UNLINK (async free) to avoid blocking Redis on large
 * scopes. Returns the count of keys removed across both DBs.
 *
 * Idempotent: a scope that is already empty returns 0.
 */
export async function clearKvScope(
  region: string,
  appId: string,
  baseOpts?: Omit<RedisClientOptions, 'db'>,
): Promise<number> {
  const opts = baseOpts ?? kvBaseOptsForRegion(region);
  const match = `{${appId}}:*`;
  let total = 0;

  for (const db of [0, 1] as const) {
    const c = await RedisClient.connect({ ...opts, db });
    try {
      let cursor = '0';
      do {
        const [next, keys] = await c.scan(cursor, match, 500);
        cursor = next;
        if (keys.length > 0) {
          total += await c.unlink(keys);
        }
      } while (cursor !== '0');
    } finally {
      await c.close();
    }
  }
  return total;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```
KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  pnpm --filter @butterbase/control-api test kv-scope
```

Expected: 2 passed (or 2 skipped if `KV_REDIS_URL_US` isn't set).

- [ ] **Step 5: Build**

```
pnpm --filter @butterbase/control-api build
```

Expected: clean.

- [ ] **Step 6: Commit**

```
git add services/control-api/src/services/kv/kv-scope.ts \
        services/control-api/src/services/kv/kv-scope.test.ts
git commit -m "feat(kv): clearKvScope helper — SCAN+UNLINK {appId}:* across both DBs"
```

(No `Co-Authored-By` trailer.)

---

### Task 4: Wire fast-path reverse-move; remove warn log; update gap doc

**Files:**
- Modify: `services/control-api/src/services/move-app/reverse-move.ts`
- Modify: `services/control-api/src/services/move-app/reverse-move.test.ts`
- Modify: `docs/superpowers/notes/2026-05-24-kv-reverse-move-gap.md`

- [ ] **Step 1: Update the failing test (replace the warn-log test)**

In `reverse-move.test.ts`, delete the test `'fast path: emits a warn log noting the KV split-region gap'` (lines ~87-133 in the current file). Replace with a new test that verifies the fast path calls dump → clear → restore in order:

```ts
  it('fast path: dumps, clears, restores KV between promoteSourceToPrimary and updateUserAppIndexRegion', async () => {
    (getMigration as any).mockResolvedValue({
      id: 'fwd-kv-1',
      app_id: 'app-x',
      user_id: 'u-1',
      source_region: 'us-east-1',
      dest_region: 'eu-west-1',
      current_step: 'completed',
      source_replica_state: 'replicating',
    });
    (createMigration as any).mockResolvedValue('rev-kv-1');
    (markCompleted as any).mockResolvedValue(undefined);

    const sourcePool = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT subdomain')) return { rows: [{ subdomain: 'demo' }] };
        return { rows: [] };
      }),
    };
    const destPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };

    const order: string[] = [];
    const promoteSourceToPrimary = vi.fn().mockImplementation(async () => { order.push('promote'); });
    const dumpKvFromRegion = vi.fn().mockImplementation(async (opts: any) => {
      order.push('dump');
      expect(opts.sourceRegion).toBe('eu-west-1');           // dump from forward-dest
      expect(opts.appId).toBe('app-x');
      expect(opts.migrationId).toBe('fwd-kv-1-reverse');
      return { key: 'move-app/fwd-kv-1-reverse/dump.kv.jsonl.gz', records: 3 };
    });
    const clearKvScope = vi.fn().mockImplementation(async (region: string, appId: string) => {
      order.push('clear');
      expect(region).toBe('us-east-1');                       // clear original-source
      expect(appId).toBe('app-x');
      return 2;
    });
    const restoreKvIntoRegion = vi.fn().mockImplementation(async (opts: any) => {
      order.push('restore');
      expect(opts.destRegion).toBe('us-east-1');              // restore to original-source
      expect(opts.sourceRegionForBucket).toBe('eu-west-1');   // bucket lives at forward-dest
      expect(opts.flipTo).toBe('us-east-1');
      expect(opts.key).toBe('move-app/fwd-kv-1-reverse/dump.kv.jsonl.gz');
      return { records: 3 };
    });
    const updateUserAppIndexRegion = vi.fn().mockImplementation(async () => { order.push('updateIndex'); });

    const ctx: any = {
      controlPool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
      runtimePoolFor: (r: string) => (r === 'us-east-1' ? sourcePool : destPool),
      writeSubdomainMapping: vi.fn(),
      writeDomainMapping: vi.fn(),
      listCustomDomains: vi.fn().mockResolvedValue([]),
      invalidateCacheAllRegions: vi.fn(),
      updateUserAppIndexRegion,
      waitForReplicationCaughtUp: vi.fn(),
      promoteSourceToPrimary,
      dumpKvFromRegion,
      clearKvScope,
      restoreKvIntoRegion,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    const res = await runReverseMove(ctx, { forwardMigrationId: 'fwd-kv-1', userId: 'u-1' });
    expect(res.path).toBe('fast');
    // Ordering invariant: promote → dump → clear → restore → updateIndex
    expect(order).toEqual(['promote', 'dump', 'clear', 'restore', 'updateIndex']);
  });

  it('fast path: KV failure bubbles up (does not swallow)', async () => {
    (getMigration as any).mockResolvedValue({
      id: 'fwd-err-1',
      app_id: 'app-x',
      user_id: 'u-1',
      source_region: 'us-east-1',
      dest_region: 'eu-west-1',
      current_step: 'completed',
      source_replica_state: 'replicating',
    });
    (createMigration as any).mockResolvedValue('rev-err-1');

    const sourcePool = { query: vi.fn().mockResolvedValue({ rows: [{ subdomain: 'd' }] }) };
    const destPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const logError = vi.fn();

    const ctx: any = {
      controlPool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
      runtimePoolFor: (r: string) => (r === 'us-east-1' ? sourcePool : destPool),
      writeSubdomainMapping: vi.fn(),
      writeDomainMapping: vi.fn(),
      listCustomDomains: vi.fn().mockResolvedValue([]),
      invalidateCacheAllRegions: vi.fn(),
      updateUserAppIndexRegion: vi.fn(),
      waitForReplicationCaughtUp: vi.fn(),
      promoteSourceToPrimary: vi.fn(),
      dumpKvFromRegion: vi.fn().mockRejectedValue(new Error('s3 boom')),
      clearKvScope: vi.fn(),
      restoreKvIntoRegion: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: logError },
    };

    await expect(
      runReverseMove(ctx, { forwardMigrationId: 'fwd-err-1', userId: 'u-1' }),
    ).rejects.toThrow(/s3 boom/);
    expect(logError).toHaveBeenCalledOnce();
    const [obj, msg] = logError.mock.calls[0];
    expect(obj).toMatchObject({ forwardMigrationId: 'fwd-err-1' });
    expect(msg).toContain('KV reverse-migration failed');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```
pnpm --filter @butterbase/control-api test reverse-move
```

Expected: the two new tests FAIL (the ctx fields `dumpKvFromRegion`/`clearKvScope`/`restoreKvIntoRegion` aren't read by `runReverseMove` yet, so the spies are never called). Existing tests continue to pass.

- [ ] **Step 3: Wire the fast-path call sequence**

In `reverse-move.ts`:

(a) Update `ReverseMoveCtx` to add the three injection points (all optional, default to the real exports):

```ts
import type pg from 'pg';
import { getMigration, createMigration, markCompleted } from './migration-store.js';
import { runReverseMoveSlowPath } from './reverse-move-slow-path.js';
import { dumpKvFromRegion as defaultDumpKvFromRegion } from './step-dump-kv.js';
import { restoreKvIntoRegion as defaultRestoreKvIntoRegion } from './step-restore-kv.js';
import { clearKvScope as defaultClearKvScope } from '../kv/kv-scope.js';

export interface ReverseMoveCtx {
  controlPool: pg.Pool;
  runtimePoolFor: (region: string) => pg.Pool;
  writeSubdomainMapping: (subdomain: string, appId: string, region: string) => Promise<void>;
  writeDomainMapping: (hostname: string, appId: string, region: string) => Promise<void>;
  listCustomDomains: (region: string, appId: string) => Promise<Array<{ hostname: string }>>;
  invalidateCacheAllRegions: (appId: string) => Promise<void>;
  updateUserAppIndexRegion: (controlPool: pg.Pool, appId: string, region: string) => Promise<void>;
  waitForReplicationCaughtUp: (region: string, appId: string, migrationId: string) => Promise<void>;
  promoteSourceToPrimary: (region: string, appId: string, migrationId: string) => Promise<void>;
  /** Optional log surface — fast path emits info on success and error on failure. */
  log?: { info?: (obj: any, msg: string) => void; warn?: (obj: any, msg: string) => void; error?: (obj: any, msg: string) => void };
  /** Test seam — defaults to the saga's dumpKvFromRegion. */
  dumpKvFromRegion?: typeof defaultDumpKvFromRegion;
  /** Test seam — defaults to the kv-scope helper. */
  clearKvScope?: typeof defaultClearKvScope;
  /** Test seam — defaults to the saga's restoreKvIntoRegion. */
  restoreKvIntoRegion?: typeof defaultRestoreKvIntoRegion;
}
```

(b) Remove the Task-8 `log.warn` block. Inside the fast-path branch (after `await ctx.promoteSourceToPrimary(...)` and BEFORE `await ctx.updateUserAppIndexRegion(...)`), insert:

```ts
    // ── KV reverse-migration (closes the Task 8 gap) ──────────────────────
    // Dump from the (current) KV region, clear the original-source's scope
    // so the restore guard passes, then restore + flip routing back.
    // Best-effort (no write block) per spec: any KV writes during this
    // window may land on the about-to-be-stale region.
    const dumpKv = ctx.dumpKvFromRegion ?? defaultDumpKvFromRegion;
    const clearKv = ctx.clearKvScope ?? defaultClearKvScope;
    const restoreKv = ctx.restoreKvIntoRegion ?? defaultRestoreKvIntoRegion;
    try {
      const { key, records: dumped } = await dumpKv({
        sourceRegion: forward.dest_region,
        appId:        forward.app_id,
        migrationId:  `${forward.id}-reverse`,
        log:          { info: ctx.log?.info ?? (() => {}) },
      });
      const cleared = await clearKv(forward.source_region, forward.app_id);
      const { records: restored } = await restoreKv({
        destRegion:            forward.source_region,
        sourceRegionForBucket: forward.dest_region,
        appId:                 forward.app_id,
        key,
        controlPool:           ctx.controlPool,
        flipTo:                forward.source_region,
        log:                   { info: ctx.log?.info ?? (() => {}) },
      });
      ctx.log?.info?.(
        { forwardMigrationId: forward.id, appId: forward.app_id, dumped, restored, cleared },
        '[reverse-move] kv migrated back to source',
      );
    } catch (err) {
      ctx.log?.error?.(
        { forwardMigrationId: forward.id, err: (err as Error).message },
        '[reverse-move] KV reverse-migration failed after PG promotion; manual reconcile required',
      );
      throw err;
    }
```

Remove the old `ctx.log?.warn?.(...)` block that the Task 8 commit added.

- [ ] **Step 4: Run reverse-move tests**

```
pnpm --filter @butterbase/control-api test reverse-move
```

Expected: 4 passed (existing 3 + the new dump→clear→restore ordering test; the warn-log test is REPLACED, not added). Plus the new failure-bubbles test → 5 total.

- [ ] **Step 5: Run the full slice (KV + move-app) to make sure nothing regressed**

```
RUN_DB_TESTS=1 \
  KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  KV_REDIS_URL_EU=redis://:butterbase_dev_kv@localhost:6391 \
  NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  pnpm --filter @butterbase/control-api test kv move-app
```

Expected: all green (Plan 6 ended with 303 passing / 7 skipped / 0 failures on this slice; this plan should not change that count downward).

- [ ] **Step 6: Build**

```
pnpm --filter @butterbase/control-api build
```

Expected: clean.

- [ ] **Step 7: Update the gap doc**

Prepend to `docs/superpowers/notes/2026-05-24-kv-reverse-move-gap.md`:

```markdown
> **Resolved 2026-05-23** — `runReverseMove` fast path now performs the KV reverse-migration inline via `dumpKvFromRegion` → `clearKvScope` → `restoreKvIntoRegion`. See plan `docs/superpowers/plans/2026-05-23-reverse-move-kv-fix.md` and spec `docs/superpowers/specs/2026-05-23-reverse-move-kv-fix-design.md`. The original gap description is preserved below for audit.

---
```

Leave the rest of the doc as-is.

- [ ] **Step 8: Commit**

```
git add services/control-api/src/services/move-app/reverse-move.ts \
        services/control-api/src/services/move-app/reverse-move.test.ts \
        docs/superpowers/notes/2026-05-24-kv-reverse-move-gap.md
git commit -m "fix(move-app): fast-path reverse-move migrates KV back to source"
```

(No `Co-Authored-By` trailer.)

---

### Task 5: Final verification

- [ ] **Step 1: Full control-api test run**

```
cd /Users/kenneth/Documents/butterbase_backup/butterbase/submodules/butterbase-oss
RUN_DB_TESTS=1 \
  KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  KV_REDIS_URL_EU=redis://:butterbase_dev_kv@localhost:6391 \
  NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  pnpm --filter @butterbase/control-api test 2>&1 | tail -8
```

Expected: KV + move-app slice green. Total failure count NOT increased vs Plan 6 baseline (96 pre-existing failures across non-KV files; matches the count Plan 6 ended on).

- [ ] **Step 2: Full build of control-api + sdk**

```
pnpm --filter @butterbase/control-api build
pnpm --filter @butterbase/sdk build
```

Expected: both clean.

- [ ] **Step 3: Docker rebuild + restart**

```
cd /Users/kenneth/Documents/butterbase_backup/butterbase
docker compose -f docker-compose.local.yml build control-api
docker compose -f docker-compose.local.yml up -d control-api
sleep 6
docker compose -f docker-compose.local.yml logs --tail=20 control-api
```

Expected: `Server listening at http://...:4000`. No new ERROR lines. No reference to `reverse-move` warn log.

- [ ] **Step 4: If fixups were needed, commit them**

```
cd /Users/kenneth/Documents/butterbase_backup/butterbase/submodules/butterbase-oss
git status
# If anything is uncommitted:
git commit -am "chore(move-app): reverse-move kv fix verify fixups"
```

---

## Self-Review Checklist

1. **Pure helpers extracted** — `dumpKvFromRegion` (Task 1), `restoreKvIntoRegion` (Task 2). ✅
2. **`clearKvScope` exists** — Task 3 creates it as a standalone module under `kv/`. ✅
3. **Fast-path call order** — promote → dump → clear → restore → updateIndex. Asserted by Task 4 Step 1 test. ✅
4. **`flipTo` separate from `destRegion`** — explicit param on `RestoreKvOpts`. Test asserts it controls the SQL UPDATE value. ✅
5. **`toKvRegion` applied to `flipTo`** — `restoreKvIntoRegion` passes `toKvRegion(opts.flipTo)` to the SQL. Test asserts short form. ✅
6. **UNLINK not DEL** — `clearKvScope` uses `c.unlink(keys)` (async free). ✅
7. **Errors bubble** — Task 4 Step 1 second test asserts the `dumpKvFromRegion` rejection propagates and `log.error` fires once. ✅
8. **Warn log + gap doc cleanup** — Task 4 Step 3 removes the warn; Step 7 prepends Resolved header. ✅
9. **Slow path untouched** — no changes to `reverse-move-slow-path.ts` or to `step-registry.ts`. Existing slow-path test (`'slow path: source_replica_state=none → creates swapped-direction migration'`) continues to pass. ✅
10. **Existing handlers unchanged externally** — `executeDumpKv` and `executeRestoreKv` keep the same return shape and `dest_resources` reads/writes. Tests verify by NOT modifying handler-level assertions. ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-23-reverse-move-kv-fix.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review.
2. **Inline Execution** — batch with checkpoints via `superpowers:executing-plans`.

Which approach?
