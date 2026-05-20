# Multi-Region Cutover — Remaining Deployment Phases

**Date:** 2026-05-13
**Owner:** Ken
**Branch / image:** `registry.fly.io/butterbase-platform:multi-region-20260513-131752`
**Scope:** Take Butterbase from single-region prod (Fly `iad` + Neon us-east-1 unified control DB) to the spec'd topology (1 platform primary + 1 standby + N runtime + N data DBs, Fly in `iad` and `sjc`, with move-app feature flags on).

This runbook covers ONLY the remaining deployment work. Implementation Phases 1–6 are merged and tested (73 E2E tests passing, see `docs/superpowers/plans/2026-05-11-multi-region-phase-6-user-ready.md` execution report).

---

## State at start of this runbook

**Done (pre-cutover, already executed):**
- Neon projects created, all four renamed to `butterbase-{platform,platform-standby,runtime,data,control-api}-db` per convention.
- Standby control DB schema pre-seeded byte-exact from prod (`pg_dump --schema-only`).
- Migrations 062–065 applied to prod + standby in lockstep (additive `CREATE TABLE`s for outbox, leases, user_app_index, app_migrations).
- Phase 2 runtime data pre-copied: 38 runtime tables, 84,199 rows from prod control DB → `runtime-use1` via `scripts/deploy/phase2-dump-use1.sh`.
- Upstash Redis created in `sea` (us-west-2 nearest).
- R2 bucket `butterbase-move-dumps` created on existing account (R2 is global, single account is correct).
- 17 Fly secrets staged on `butterbase-platform` (NEON_*_PROJECT_ID_*, REDIS_URL_*, R2_*, BUTTERBASE_REGIONS, BUTTERBASE_FLY_REGION_MAP, MOVE_APP_DRIVER_ENABLED=true, MOVE_APP_REPLICATION_ENABLED=true).
- Fly monolith image built and pushed (control-api + dashboard-api + cron-scheduler via PM2 ecosystem).

**Known issue (deferred, not blocking launch):**
- DR replication `platform_dr_sub` apply worker won't stay alive in non-`neondb` databases on Neon. Filed at `docs/issues/2026-05-13-neon-logical-replication-apply-worker-fragility.md`. Workaround for v1: Neon PITR for control-DB DR (10–20 min RTO).

---

## Remaining Phases

| Phase | What | Customer impact | Reversible? |
|---|---|---|---|
| A | Pre-flight smoke test (one-off machine) | none | yes |
| B | Cutover maintenance window — deploy new image, re-sync data, apply 060 | 30–60 min read-only | yes until step B.7 |
| C | Scale out to `sjc` (us-west-2) | none, additive | yes |
| D | Bake-in 24–48h | none | yes |
| E | Drop redundant runtime tables from control DB (apply 061) | none | NO (PITR-only) |
| F | Post-launch DR fix (Neon ticket loop) | none | n/a |

---

## Phase A — Pre-flight smoke test

**Goal:** prove the new image boots with the staged secrets before touching prod.

```bash
flyctl machine run registry.fly.io/butterbase-platform:multi-region-20260513-131752 \
  --app butterbase-platform \
  --region iad \
  --rm \
  --env BUTTERBASE_SMOKE_TEST=true
```

Watch logs for ~90s. Expect, in order:
1. Boot-config check passes (fails fast if any required env is missing — Phase 1 Task 1).
2. `runtime-database` plugin connects to NEON_RUNTIME_PROJECT_ID_US_EAST_1 and reports row count for `apps`.
3. `region-resolver` cache initialises against Redis.
4. PM2 reports all three procs up: control-api on :3000, dashboard-api on :3001, cron-scheduler running.
5. Cron-scheduler logs `acquired regional lock for us-east-1` (Redis-backed; Phase 2 Task 18).

**Abort criteria:** any boot-config FAIL line, any pool-routing error referencing `controlPool` for a runtime table (Phase 6 Stage 3 bugs — should be fixed, but watch for regressions), any unhandled promise rejection.

If clean: tear the one-off machine down (it auto-removes on `--rm`) and proceed to Phase B.

---

## Phase B — Cutover maintenance window

**Pre-window checklist (T-24h):**
- [ ] Status-page incident drafted (not yet posted): "Scheduled maintenance, brief read-only window for multi-region migration."
- [ ] Announce in `your team incident channel` + email customers with active subscriptions.
- [ ] Verify `neon-cli` and `flyctl` authenticated locally.
- [ ] Confirm Neon PITR retention covers the window (it does — default 7 days).
- [ ] Have the rollback path open in a second terminal (see Rollback section).

**Window: 60 minutes wall-clock target. 30 min likely.**

### B.1 — Open the window

```bash
# Post the status-page incident.
# Set the dashboard banner via env var or feature flag (TBD: which channel — operator decides).
```

### B.2 — Block writes

Two options; pick one based on whether the maintenance-mode middleware was actually merged (it was TBD in Phase 2 Task 15's runbook).

**Option B.2.a (preferred if middleware merged):**
```bash
flyctl secrets set --app butterbase-platform MAINTENANCE_MODE=true
# Triggers rolling restart automatically; ~60s drain.
```

**Option B.2.b (fallback, more disruptive):**
```bash
flyctl scale count 0 --app butterbase-platform
# Returns 503 at Fly proxy. Faster but less graceful (in-flight requests killed).
```

Confirm writes are blocked: `curl https://api.butterbase.ai/v1/health` returns 503.

### B.3 — Re-sync runtime data (delta since pre-copy)

The pre-copy at 2026-05-13 ~13:17 is now hours stale. Re-run the same dump+restore to overwrite with current state. Idempotent (TRUNCATE + COPY).

```bash
./scripts/deploy/phase2-dump-use1.sh
```

Expect: same 38 tables, row counts ≥ pre-copy counts. If any table errors, abort and roll back (B.2 → unset MAINTENANCE_MODE).

**Time budget:** ~5 min for 84k rows; scales linearly. Most of the window is this step.

### B.4 — Apply migration 060 (drop cross-tier FKs)

```bash
tsx scripts/deploy/apply-control-migrations.mts \
  --target prod --only 060_drop_runtime_table_fks
tsx scripts/deploy/apply-control-migrations.mts \
  --target standby --only 060_drop_runtime_table_fks
```

This drops FK constraints from `subscriptions.app_id`, `usage_meters.app_id`, `billing_events.app_id`, `app_functions.deployed_by`, etc. — the columns stay; integrity becomes logical (orphan-cleanup cron handles drift). Both sides MUST get this in lockstep so a future failover doesn't surprise us.

### B.5 — Deploy the new image

```bash
flyctl deploy --image registry.fly.io/butterbase-platform:multi-region-20260513-131752 \
  --app butterbase-platform \
  --strategy immediate \
  --wait-timeout 300
```

`--strategy immediate` because we're already in a maintenance window — no point in rolling.

Watch logs from a second terminal. Boot-config check is the first thing to pass/fail.

### B.6 — Unblock writes + smoke test

```bash
flyctl secrets unset --app butterbase-platform MAINTENANCE_MODE
# OR: flyctl scale count <original-count> --app butterbase-platform
```

Run the smoke sweep (in this order — fail any → roll back):
- [ ] `curl https://api.butterbase.ai/v1/health` → 200
- [ ] Dashboard loads, "List my apps" returns the user's apps with `region: 'us-east-1'`.
- [ ] One known customer app responds to a real request (pick a low-traffic app you own).
- [ ] AI request hits quota-enforcement: local read of `user_billing_state`, no cross-region call. Verify via control-api logs (`region-resolver: local hit`).
- [ ] Outbox drain worker logs `applied version N to us-east-1`.
- [ ] No `pool-routing: control pool used for runtime table` errors anywhere.

### B.7 — Close the window

- [ ] Status-page incident → resolved.
- [ ] `your team incident channel` update.
- [ ] Tag the commit: `git tag prod/multi-region-cutover-2026-05-13`.

**After this point**: rollback requires Neon PITR (60 min RTO). The runtime tables in control DB are still present until Phase E, so a code-level rollback (re-deploy old image) is technically possible — but the runtime DB has now diverged from control (new writes go to runtime). Treat as one-way after the first write.

---

## Phase C — Scale out to `sjc` (us-west-2)

**Trigger:** any time after Phase B succeeds. Additive — does not affect existing `iad` machines.

### C.1 — Create the `sjc` machines

```bash
flyctl scale count 2 --region sjc --app butterbase-platform
```

(2 machines for HA; adjust to match `iad` count.)

### C.2 — Verify

- [ ] Both `sjc` machines pass boot-config (will fail fast if NEON_RUNTIME_PROJECT_ID_US_WEST_2 isn't set — it is, was staged in pre-flight).
- [ ] `cron-scheduler` on `sjc` acquires the `us-west-2` lock (NOT the `us-east-1` lock — distributed Redis lock prevents double-firing).
- [ ] An app with `region='us-west-2'` (none exist yet, but a test app you create now should route there) gets provisioned into `runtime-usw2` + `data-usw2`.

### C.3 — Validate Fly-Replay routing

Create a test app pinned to `us-west-2`. Hit its API endpoint from a client in `us-east-1`:
- [ ] First request: returns `Fly-Replay: region=sjc` header, then 200 from sjc.
- [ ] Subsequent requests: Cloudflare honors the replay region; latency drops.

---

## Phase D — Bake-in (24–48h)

**Monitor:**
- [ ] No `pool-routing` errors.
- [ ] Outbox drain lag < 30s (alert threshold).
- [ ] Lease grant/burn/reclaim metrics sane: no stuck `active` leases past `expires_at + 30s`.
- [ ] Cross-tier orphan-cleanup cron runs daily, reports zero or expected orphans.
- [ ] No surprise spikes in 503s or 5xx.

**Do NOT proceed to Phase E** if any of:
- Replication lag growing unbounded (Neon ticket pending — see Phase F).
- Any reader still hits control DB for runtime tables (would crash on Phase E).
- Customer-reported regressions.

---

## Phase E — Drop runtime tables from control DB (migration 061)

**Pre-flight (REQUIRED):**
- [ ] Take a Neon PITR-pinned snapshot of prod control DB. This is the only restore path for 061 — it is IRREVERSIBLE without DB restore.
- [ ] Confirm Phase D bake-in is clean.
- [ ] Re-run the readers/writers audit (Phase 2 Task 8) one more time on `main` to catch any new code that snuck in still reading runtime tables from control:
  ```bash
  rg "controlPool|controlDb" services/control-api/src --type ts | grep -iE 'apps|app_users|app_oauth|app_functions'
  ```
  Expected: zero hits.

### E.1 — Apply 061 to prod + standby

```bash
tsx scripts/deploy/apply-control-migrations.mts \
  --target prod --only 061_post_cutover_drop_runtime_tables
tsx scripts/deploy/apply-control-migrations.mts \
  --target standby --only 061_post_cutover_drop_runtime_tables
```

This drops the now-orphan runtime tables (`apps`, `app_users`, `app_oauth_configs`, ...) from the platform DB. Disk shrinks. No customer impact if Phase D was clean.

### E.2 — Verify

- [ ] No errors in control-api logs.
- [ ] `\dt` in psql against control DB shows only platform-tier tables.
- [ ] Smoke sweep from B.6 still passes.

---

## Phase F — Post-launch DR fix

**Context:** `platform_dr_sub` apply worker fragility — see `docs/issues/2026-05-13-neon-logical-replication-apply-worker-fragility.md`.

**Sequence:**
1. File the report with Neon support (paste the markdown, attach `/tmp/neon-replication-diag.txt`).
2. Track their guidance. Possible outcomes:
   - **Neon fixes the apply worker for non-`neondb` databases** → drop and recreate `platform_dr_sub`, re-pre-seed via `scripts/deploy/preseed-standby.sh`, resume continuous replication.
   - **They confirm it's a hard restriction** → rename standby's working DB to `neondb` (requires recreating the Neon project; can do in a no-impact window since standby is currently passive).
   - **They suggest a setting** → apply, retry.
3. Once replication runs cleanly for 48h, document the steady-state DR plan in `docs/runbooks/platform-db-failover.md` (referenced by spec but does not yet exist; create from the spec's Failover section).
4. Schedule a planned-failover drill within 30 days (spec: quarterly).

---

## Rollback paths

| At point | How to roll back |
|---|---|
| Before B.5 (deploy) | Unset MAINTENANCE_MODE, re-scale. No state changed. |
| B.5–B.7 (new image live, pre-write) | `flyctl deploy --image <previous-tag>`. Runtime DB diverges from control with zero rows of drift (no traffic yet). |
| After B.7 (new image taking writes) | Old image: `flyctl deploy --image <previous-tag>`. Old image reads runtime tables from control DB → it will be stale for any writes that went to runtime in the new image. Acceptable only if rollback happens within minutes; otherwise PITR. |
| After Phase E | PITR-restore control DB from snapshot taken at E.0. ~60 min RTO. |

---

## Open items not in this runbook

- **Dashboard maintenance banner channel** — exact mechanism is TBD. Operator decides at B.1.
- **Status-page provider** — assumed manual update; if there's an API, automate.
- **Cutover script** — this runbook is currently human-driven. Once we've done it once, fold the deterministic steps (B.2–B.6) into `scripts/deploy/cutover.sh` for any future region adds.
- **Customer-facing release notes** — write after Phase D succeeds, before Phase E (so "multi-region is live" doesn't go out while we still have a known data-shape change pending).
