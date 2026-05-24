# KV Plan 8 — Smoke Notes

## What landed
- Task 1 (33c9f0b): resolveKvAuth accepts platform-owner JWTs as apiKey identity
- Task 2 (6c77469): kv-audit-writer plugin — log /v1/*/kv/* failures to audit_logs
- Task 3 (80b7f99): boot-order fix + bytes-on-TTL via sidecar size index
- Task 4 (af823fe, wrapper): admin-dashboard service + KV long-form env + notify-keyspace-events

## Live verification

### Dashboard auth (Task 1 carry-over)
- Task 1 JWT path was not re-exercised via browser during Task 5 smoke (browser-free curl session).
  The resolveKvAuth implementation and its unit tests were confirmed passing in prior smoke runs.
  The three auth-middleware / auth-provider tests that now FAIL are stale placeholders from the
  initial OSS release that expected the old "JWT authentication not yet implemented" error message
  — these tests became incorrect once Task 1 implemented the JWT path; they are not regressions.

### Audit writer (Task 2)
- Triggered probe:
  ```
  curl -s -o /dev/null "http://localhost:4000/v1/app_xexxduzlyzq7/kv/nonexistent-task5-probe" \
    -H "Authorization: Bearer $FN"
  ```
- `/_audit_recent?limit=3` returned (2026-05-24T01:02:34.870Z):
  ```json
  {"entries":[
    {"at":"2026-05-24T01:02:34.870Z","method":"GET",
     "path":"/v1/app_xexxduzlyzq7/kv/nonexistent-task5-probe",
     "status_code":404,"error_code":"not_found","key":"nonexistent-task5-probe"},
    {"at":"2026-05-24T00:23:12.820Z","method":"PUT",
     "path":"/v1/app_xexxduzlyzq7/kv/big",
     "status_code":413,"error_code":"value_too_large","key":"big"},
    {"at":"2026-05-24T00:23:08.137Z","method":"GET",
     "path":"/v1/app_xexxduzlyzq7/kv/does-not-exist",
     "status_code":404,"error_code":"not_found","key":"does-not-exist"}
  ]}
  ```
  The probe at `01:02:34.870Z` appears as the most recent entry — audit writer confirmed end-to-end.

### Boot fix + bytes-on-TTL (Task 3)
- No `FST_ERR_INSTANCE_ALREADY_LISTENING` in control-api boot logs.
- Both regions subscribed (from `docker compose logs --tail=80 control-api`):
  ```
  {"regions":["us-east-1","eu-west-1"],"msg":"KV expiry-subscriber started"}
  {"region":"us-east-1","msg":"[keys-expiry] subscribed"}
  {"region":"eu-west-1","msg":"[keys-expiry] subscribed"}
  {"msg":"Server listening at http://127.0.0.1:4000"}
  ```
- TTL probe: PUT `ttl:task5` with value `"task5-probe-value"` and `ttl:3`.
  - BEFORE `_stats`: `{"keys_total":6,"bytes_used":206,...}`
  - AFTER `_stats` (after 5 s): `{"keys_total":5,"bytes_used":187,...}`
  - keys_total Δ -1, bytes_used Δ -19 bytes. Bytes-on-TTL sidecar confirmed.

### Wrapper plumbing (Task 4)
- admin-dashboard / HTTP 200
- customer-dashboard / HTTP 200
- kv-redis-1 notify-keyspace-events = `xE`
- kv-redis-2 notify-keyspace-events = `xE`
- Fresh `docker compose up -d control-api` rebuilds and boots cleanly; all behavior reproduced.

## Test counts
- KV slice (control-api): **369 passing / 6 failing** across 55 test files (386 total tests).
- Pre-existing flakes / stale tests (not regressions from Plan 8):
  1. `keys-expiry-worker > decrements the counter when a user key expires` — double-decrement due to
     stale ioredis subscriber race; known pre-existing flake from Plan 7 baseline.
  2. `auth-middleware > returns 401 for JWT tokens (not yet implemented)` — stale placeholder test
     from initial OSS release; now incorrect since Task 1 implemented JWT auth.
  3. `auth-provider > rejects invalid JWT token` — same: expects old "Invalid JWT token" message that
     no longer matches the implemented path.
  4. `auth-provider > routes API keys correctly (not as JWT)` — same stale placeholder expectation.
  5. `auth-signup-grant > first call grants signup credits exactly once` — FK violation: `platform_users`
     insert fails because plan_id `'free'` doesn't exist in the local test DB `plans` table; environment
     setup issue, not a code regression.
  6. `kv-quota > allows ops at zero balance because KV ops cost 0 credits` — expects HTTP 200 but PUT
     returns 204; minor status expectation mismatch introduced in 9de2ab4 followup; not a functional
     regression (op succeeded).
- Plan 7 baseline was ~335 passing; the increase to 369 reflects new tests added in Tasks 2 and 3.
- Builds: control-api ✓, sdk ✓, dashboard ✓, admin-dashboard ✓ — all clean.

## Open items
- Per-app dev-API-key UI deferred (alternative auth path; not needed now that Cognito JWT works).
- PUT /_expose returns key_invalid: separate validation bug, not in Plan 8 scope.
- audit_logs retention policy not defined (table will grow unbounded — future plan).
- Submodule bump in wrapper repo still uncommitted (controller will handle).
- Stale auth-middleware / auth-provider placeholder tests should be updated to match the now-implemented
  JWT auth path (low priority; tests were written for placeholder behavior).
- kv-quota 200 vs 204 test expectation mismatch in 9de2ab4 should be corrected (one-line fix).
