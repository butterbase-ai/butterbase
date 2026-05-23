# Reverse-Move KV Fix — Design

**Date:** 2026-05-23
**Branch base:** `feat/kv-plan-6-move-app-kv` (the Plan 6 branch)
**Related:** `docs/superpowers/notes/2026-05-24-kv-reverse-move-gap.md` (Task 8 fallback this fix supersedes)

## Problem

`runReverseMove`'s fast path promotes the original-source Postgres replica back to primary but does not touch KV. After a fast-path reverse-move:

- `apps.region` and `user_app_index.region` → original-source.
- `app_kv_credentials.region` → forward-dest (unchanged since forward move).

KV reads and writes route via `app_kv_credentials.region`, so they land in the forward-dest region while Postgres lives in original-source. This is a split-region state. No data loss, but every KV op pays cross-region latency until a separate move runs.

Plan 6 Task 8 documented the gap and emitted a `log.warn`. This spec closes the gap.

## Goals

- Fast-path reverse-move migrates KV from forward-dest back to original-source.
- Existing forward-saga behavior unchanged.
- Slow-path reverse-move (already saga-driven, already correct) unchanged.

## Non-goals

- **No write block.** Per design decision, the fast path stays "fast." KV writes during the dump+restore window may land on the (about-to-be-stale) forward-dest region and be lost on the flip. Documented user-visible trade-off; matches the "best-effort" semantic of the fast path.
- **No PG-rollback on KV failure.** If KV reverse-migration fails after PG promotion, the app is split (PG on source, KV on dest). The error bubbles up; the caller retries. PG promotion is not re-reverted.
- **No reverse-replication setup for KV.** Forward saga sets up Postgres source-as-replica; we do not mirror that for KV. Reverse always re-dumps.

## Architecture

Extract three pure helpers from the existing saga steps. `runReverseMove`'s fast path calls them inline. Slow path is untouched.

```
step-dump-kv.ts
  export dumpKvFromRegion(opts) → { key, records }
  executeDumpKv (StepHandler) — thin wrapper over the helper

step-restore-kv.ts
  export restoreKvIntoRegion(opts) → { records }
    · runs empty-dest guard (kept)
    · streams gunzip + RESTORE REPLACE per record
    · UPDATE app_kv_credentials SET region = toKvRegion(flipTo)
  executeRestoreKv (StepHandler) — thin wrapper

kv-scope.ts (NEW)
  export clearKvScope(region, appId) → Promise<number>
    · SCAN+UNLINK {appId}:* across DB 0 and DB 1
    · returns count deleted

reverse-move.ts (fast path)
  dump → clear → restore (with flip), inline calls to the helpers above
```

### Helper signatures

```ts
// step-dump-kv.ts
export interface DumpKvOpts {
  sourceRegion: string;
  appId: string;
  migrationId: string;
  log: { info: Function };
  uploadFn?: (key: string, body: Readable) => Promise<{ key: string; bytes: number }>;
  kvBaseOptsForRegion?: (region: string) => Omit<RedisClientOptions, 'db'>;
}
export async function dumpKvFromRegion(opts: DumpKvOpts): Promise<{ key: string; records: number }>;

// step-restore-kv.ts
export interface RestoreKvOpts {
  destRegion: string;
  sourceRegionForBucket: string;
  appId: string;
  key: string;
  controlPool: pg.Pool;
  flipTo: string;
  log: { info: Function };
  downloadFn?: (key: string) => Promise<Readable>;
  kvBaseOptsForRegion?: (region: string) => Omit<RedisClientOptions, 'db'>;
}
export async function restoreKvIntoRegion(opts: RestoreKvOpts): Promise<{ records: number }>;

// kv-scope.ts
export async function clearKvScope(
  region: string,
  appId: string,
  baseOpts?: Omit<RedisClientOptions, 'db'>,
): Promise<number>;
```

`flipTo` is explicit (not derived from `destRegion`) so the helper cannot accidentally flip routing to the wrong region. Forward saga and reverse fast path happen to pass the same value as `destRegion`, but the indirection makes the dependency unit-testable and intent visible.

`clearKvScope` uses `UNLINK` (async free) rather than `DEL` to avoid blocking Redis on large key sets. `RedisClient` already exposes `unlink([keys])`.

### Fast-path data flow

```
runReverseMove (fast path), inserted between promoteSourceToPrimary and updateUserAppIndexRegion:

  try {
    const { key, records: dumped } = await dumpKvFromRegion({
      sourceRegion: forward.dest_region,
      appId:        forward.app_id,
      migrationId:  `${forward.id}-reverse`,
      log:          ctx.log,
    });
    const cleared = await clearKvScope(forward.source_region, forward.app_id);
    const { records: restored } = await restoreKvIntoRegion({
      destRegion:            forward.source_region,
      sourceRegionForBucket: forward.dest_region,
      appId:                 forward.app_id,
      key,
      controlPool:           ctx.controlPool,
      flipTo:                forward.source_region,
      log:                   ctx.log,
    });
    ctx.log?.info?.({ dumped, restored, cleared }, '[reverse-move] kv migrated back to source');
  } catch (err) {
    ctx.log?.error?.(
      { forwardMigrationId: forward.id, err: (err as Error).message },
      '[reverse-move] KV reverse-migration failed after PG promotion; manual reconcile required',
    );
    throw err;
  }
```

The dump → clear → restore sequence runs BEFORE `updateUserAppIndexRegion`. `user_app_index` is what makes the new region authoritative for routing lookups — placing the KV work first means user-facing routes never observe "PG on source, KV still on dest" in the success path.

### Pre-clear rationale

After a forward move, the original-source's KV scope still holds stale keys (Plan 6 leaves them as a cold copy). The empty-dest guard inside `restoreKvIntoRegion` would otherwise abort. Three considered options:

1. **(chosen) Pre-clear** — SCAN+UNLINK `{appId}:*` on original-source across both DBs before restore. Provably empty dest. Stale data is permanently gone.
2. Skip the guard, rely on `RESTORE REPLACE` — leaves "ghost" keys that existed pre-forward but not in the current dump (e.g., user deleted them while on EU). Wrong semantics.
3. Mode flag on `restoreKvIntoRegion` — works but couples concerns; the helper would now own clearing behavior that's specific to reverse callers.

## Error handling

| Failure point                         | Outcome                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `dumpKvFromRegion` throws             | PG already promoted; throw. Split state. Caller retries.                |
| `clearKvScope` throws                 | Same as above. Source KV may be partially cleared; retry replays clear. |
| `restoreKvIntoRegion` throws          | Same. Source KV partially populated; non-empty-dest guard prevents corruption on retry — retry must call clearKvScope again first. |
| `controlPool.query` (the flip) throws | KV data is on source but routing still points at dest. Retry by re-running restore (REPLACE is idempotent; flip is idempotent). |

The "must clearKvScope again" caveat for restore retries means the reverse-move's three-step sequence (dump → clear → restore) is naturally idempotent if re-run from the top. We do not need separate idempotence checkpoints because the operation is short and synchronous.

## Testing

### Helper unit tests
- `step-dump-kv.test.ts` — add cases for `dumpKvFromRegion`: returns `{key, records}` shape; `migrationId` is interpolated into the R2 key.
- `step-restore-kv.test.ts` — add cases for `restoreKvIntoRegion`: `flipTo` is what gets written to `app_kv_credentials.region` (via `toKvRegion`), not `destRegion`; non-empty-dest guard still fires.
- `kv-scope.test.ts` (new) — integration test gated on `KV_REDIS_URL_US`. Seeds keys across DB 0 and DB 1, asserts `clearKvScope` returns the right count and leaves the scope empty.

### Fast-path reverse-move test
Extend `reverse-move.test.ts` with one test that injects `dumpKvFromRegion`, `clearKvScope`, `restoreKvIntoRegion` via the ctx. Add them to `ReverseMoveCtx` as optional fns, defaulting to the real exports — same pattern as `writeSubdomainMapping` etc. Verify call order (dump → clear → restore) and region swap. Also verify that an error from any step bubbles up.

### Slow-path verification
No new tests. The slow path uses `runReverseMoveSlowPath` → saga driver → `executeDumpKv`/`executeRestoreKv` (handler wrappers around the new helpers). Existing tests cover it.

### Live smoke (deferred if local can't drive it)
Add a Section H to `docs/superpowers/smoke/2026-05-23-kv-plan-6-smoke.md`: forward US→EU then fast-path reverse EU→US, verifying KV ends up back on US with `_meta:bytes` intact. Fast-path reverse requires `source_replica_state === 'replicating'` which needs real Neon physical replication. If local stack can't drive it, document as "fast-path live smoke pending stage" and rely on the unit test for the call-order verification.

## Cleanup

- Remove the `log.warn` in `runReverseMove` fast path that was added by Task 8.
- Update `docs/superpowers/notes/2026-05-24-kv-reverse-move-gap.md`: add a "Resolved" header at the top pointing at this spec and the implementation commits. Preserve the body for audit trail.

## File summary

**Created:**
- `services/control-api/src/services/kv/kv-scope.ts` — `clearKvScope` helper.
- `services/control-api/src/services/kv/kv-scope.test.ts` — gated integration test.

**Modified:**
- `services/control-api/src/services/move-app/step-dump-kv.ts` — extract `dumpKvFromRegion`; `executeDumpKv` becomes thin wrapper.
- `services/control-api/src/services/move-app/step-restore-kv.ts` — extract `restoreKvIntoRegion`; `executeRestoreKv` becomes thin wrapper.
- `services/control-api/src/services/move-app/step-dump-kv.test.ts` — add helper-level cases.
- `services/control-api/src/services/move-app/step-restore-kv.test.ts` — add helper-level cases.
- `services/control-api/src/services/move-app/reverse-move.ts` — inline dump → clear → restore in fast path; add injection points to `ReverseMoveCtx`; remove Task 8 warn log.
- `services/control-api/src/services/move-app/reverse-move.test.ts` — fast-path KV flow test.
- `docs/superpowers/notes/2026-05-24-kv-reverse-move-gap.md` — add resolved header.
- `docs/superpowers/smoke/2026-05-23-kv-plan-6-smoke.md` — optional Section H.

**Deleted:** none.
