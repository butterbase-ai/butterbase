> **Resolved 2026-05-23** — `runReverseMove` fast path now performs the KV reverse-migration inline via `dumpKvFromRegion` → `clearKvScope` → `restoreKvIntoRegion`. See plan `docs/superpowers/plans/2026-05-23-reverse-move-kv-fix.md` and spec `docs/superpowers/specs/2026-05-23-reverse-move-kv-fix-design.md`. The original gap description is preserved below for audit.

---

# KV Reverse-Move Gap (Fast Path)

**Date:** 2026-05-24
**Status:** Known gap, tracked for a future plan

## The Problem

`reverse-move` has two execution paths:

- **Slow path** (`source_replica_state !== 'replicating'`): creates a fresh `app_migrations` row with swapped source/dest and lets the saga driver execute. Because `HAPPY_PATH_ORDER` includes `dumping_kv` + `restoring_kv`, the slow path automatically migrates KV in the reverse direction (forward-dest → forward-source). **Fully handled.**

- **Fast path** (`source_replica_state === 'replicating'`): performs in-place Postgres replica-promotion surgery without running the saga. It does **not** touch KV at all. After a fast-path reverse:
  - `app_kv_credentials.region` still points to the **forward move's destination** (the region KV data was migrated to during the forward move).
  - Postgres routes back to the **forward move's source** (the original primary, now re-promoted).
  - This is a **split-region state**: KV and Postgres live in different regions.

A warn log is emitted when this gap is hit:

```
[reverse-move fast-path] KV not migrated; split-region state until next forward move
```

The log object includes `forwardMigrationId`, `appId`, `kvRegion`, and `pgRegion` for observability.

## Impact

Apps that do not use the KV layer are unaffected. Apps that use KV will read from and write to the forward-move destination region while Postgres serves from the original source region. In practice, KV latency increases for users served from the original source region's geography.

## Workaround

Customers who need KV to be co-located with Postgres after a fast-path reverse can trigger a new forward `move_app` in the direction `dest → source`. This will enqueue a full saga migration including `dumping_kv` + `restoring_kv`, which will flip KV back and update `app_kv_credentials.region`.

## Why We Shipped With This Gap

The fast path's surface area is large (direct PG replica promotion, routing updates, table un-archiving). Extracting `dumpKvFromRegion` and `restoreKvIntoRegion` as clean, testable primitives from the saga step handlers requires:

1. Decoupling the streaming upload pipeline in `step-dump-kv.ts` from the `StepHandler` interface.
2. Adding injectable block/unblock KV write helpers that currently live only inside `step-block-writes.ts`.
3. Pre-clearing the target KV scope before restore (to satisfy `assertDestEmpty`), using a cursor-based scan against a potentially live Redis instance.

This extraction is owed to a future plan. The fallback documented here is low-risk and maintains correctness for the common case (slow path).

## Future Plan

Extract `dumpKvFromRegion` and `restoreKvIntoRegion` as pure, injectable functions from their respective step handlers, then call them inline in the fast path with a KV write-block around the operation. Tracked as a follow-on to KV Plan 6.
