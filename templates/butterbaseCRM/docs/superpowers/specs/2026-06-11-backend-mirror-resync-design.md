# Backend Mirror Resync — Design

**Date:** 2026-06-11
**App:** `app_44zjayftl7b3`
**Goal:** Make `backend/` byte-for-byte match the live Butterbase app, and fix `sync.sh` so this never silently drifts again.

## Problem

`backend/` is documented as a read-only mirror of live, but it has drifted badly:

- 40 function folders locally vs 32 on live.
- 9 local-only orphans (substrate outbox/backfill/pull/import/sync/reconcile, `crm-upsert-company`, `crm-upsert-person`) — leftover from the substrate-only refactor; not deployed.
- 1 live-only (`agent-proposals-expire` cron) — never pulled down.
- Many overlapping handlers are `M` vs the pinned snapshot, so local handler source ≠ deployed source.
- Root cause: `backend/sync.sh` hardcodes only 3 function names (`summarize-company`, `invite-member`, `accept-invite`). Everything else has been drifting since.
- `backend/README.md` still claims the app has 3 functions.

## Approach

Pure mirror operation. No semantic changes to handler code, schema, or RLS.

### Steps

1. **Inventory live functions** via `GET /v1/{app}/functions`. Capture the full list.
2. **Nuke `backend/functions/*`** entirely.
3. **Re-pull each live function:** `GET /v1/{app}/functions/<name>` → write `handler.ts` from `.code` and `function.json` with `{name, description, trigger, timeoutMs, memoryLimitMb, deployedAt}` plus any cron fields. Bail loudly if `.code` is missing/empty.
4. **Re-pull non-function state** by running the existing sync.sh blocks: `schema.json`, `rls/policies.json`, `auth/config.json`, `integrations/integrations.json`, `storage.json`, `realtime.json`, `ai.json`.
5. **Rewrite `sync.sh`** so it:
   - Enumerates functions dynamically (no hardcoded list).
   - Prunes local function folders for names not present on live.
   - Keeps the same per-function file shape (`handler.ts` + `function.json`).
   - Prints a reminder that `rls/policies.sql` is hand-maintained.
6. **Update `backend/README.md`**: drop the "3 functions" claim and the stale function-by-function tree; replace with "see `functions/` for the current set; `sync.sh` enumerates dynamically."

### Explicitly out of scope

- `butterbase repo push` afterward. Snapshot reconciliation is a separate decision.
- `rls/policies.sql` regeneration (hand-maintained — flagged for eyeball after).
- Frontend.
- `docs/known-limitations.md`, the substrate-only-refactor spec.
- Any semantic change to handler logic.

## Risks

- **Live API returns shape we don't expect.** Mitigation: assert `.code` is a non-empty string per function; fail the run and print the offending payload.
- **`agent-proposals-expire` cron metadata.** Make sure `function.json` captures whatever cron scheduling fields the API exposes — likely `trigger`, `cron_schedule`, or similar. Don't filter it down to the same allowlist as HTTP funcs without checking.
- **Orphan folder deletion is irreversible.** Acceptable — they're the documented refactor leftovers and git history has them.

## Verification

After running:
- `comm` of `ls backend/functions/` vs `butterbase functions list` shows no differences.
- `butterbase repo status` shows only the differences we'd expect (working tree vs old pinned snapshot, not vs live).
- Spot-check 2 handlers (one HTTP, one cron) by re-fetching via curl and `diff`-ing against the written file.
