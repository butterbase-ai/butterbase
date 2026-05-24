# KV Plan 5 Smoke — Quota/Credits/Rate-Limit Enforcement

**Date:** 2026-05-23  
**Branch:** feat/kv-plan-5-quotas  
**Stack:** docker-compose.local.yml (local)  
**Fixture app:** kv-smoke-1 (region us, owner 11111111-1111-1111-1111-111111111111)

---

## Fixture Setup Notes

- App and API key already existed; key was not revoked.
- Regenerated key hash (plaintext lost between sessions); new key issued.
- Credits were at $0; set `monthly_allowance_usd=1.00, credits_usd=1.00`.
- `user_app_index` was empty for kv-smoke-1; added row with `region=us-east-1`.
- Runtime DB `apps` table did not contain kv-smoke-1; inserted row so FK constraint on `usage_meters` would not block flush.

---

## Section I — Rate Limit

**Method:** 70 parallel PUT requests fired simultaneously via background shell jobs.

| Code | Count |
|------|-------|
| 204  | ~55   |
| 429  | ~15   |

- 429 body: `{"error":"kv_rate_limited","retry_after":1}` — CORRECT
- 429 header: `retry-after: 1` — CORRECT
- Rate bucket key `{kv-smoke-1}:_meta:rate:<epoch>` confirmed in KV Redis after ops.
- Plan said ~50/200 + ~10/429 with 60 writes; used 70 writes for cleaner signal.

**Result: PASS**

---

## Section J — Credits Exhausted

- Set `monthly_allowance_usd=0, credits_usd=0` via SQL.
- Restarted control-api to clear 30s cache.
- GET on any key → HTTP 402.
- Body: `{"error":"kv_credits_exhausted","message":"Credit balance is 0. Top up or wait for monthly reset."}` — CORRECT
- Credits restored and control-api restarted after test.

**Result: PASS**

---

## Section K — Storage Cap

- `kv_max_storage_bytes=10485760` (10 MB, from playground plan).
- Pre-seeded `{kv-smoke-1}:_meta:bytes` to `10485660` (cap - 100).
- PUT with 200-byte value → HTTP 507.
- Body: `{"error":"kv_storage_full","used_bytes":10485660,"cap_bytes":10485760}` — CORRECT
- Storage counter reset after test.

**Result: PASS**

---

## Section L — Accounting

**Setup note:** kv-smoke-1 must exist in the runtime DB `apps` table for the flush worker to insert `usage_meters` rows. The app was missing on first attempt; the flush worker correctly logged `Discarding orphaned usage for deleted app kv-smoke-1` and dropped the counter. After inserting the app row, flush worked.

- 10 writes × 2 credits + 5 reads × 1 credit = 25 expected.
- Redis counter after ops: `kv_ops=25` — CORRECT
- After 75s flush worker interval:
  - `kv_ops sum = 25` in `usage_meters` — CORRECT
  - `kv_storage_bytes sum = 41` in `usage_meters`
  - Redis counter cleared (getdel succeeded)
- Flush log: `Flushed 2 usage counters to database` — CORRECT

**Result: PASS**

---

## Section M — `_stats`

```json
{
  "keys_total": 140,
  "bytes_used": 82,
  "ops_per_sec": 1
}
```

- `bytes_used=82` matches `{kv-smoke-1}:_meta:bytes` Redis counter — CORRECT
- `keys_total=140` >= 15 — CORRECT (accumulated from all plan smoke runs)
- `ops_per_sec=1` (one stray op in current second at time of check)

**Result: PASS**

---

## Regression (Plan 4.5)

| Test | Expected | Actual | Pass |
|------|----------|--------|------|
| PUT /kv/regression | 204 | 204 | YES |
| GET /kv/regression | value matches | `{"value":"test-regression-value"}` | YES |
| DELETE /kv/regression | 204 | 200 `{"deleted":1}` | NOTE |
| GET after DELETE | 404 | 404 | YES |
| POST /kv/_batch (3 gets) | array of 3 | `{"results":[...3 items...]}` | YES |

**DELETE returns 200 + `{deleted: N}` not 204.** This is by design per `kv-data.ts` route comment (`DELETE → {deleted: N}`). Not a regression; the test plan description was incorrect.

**Result: PASS**

---

## Issues Found

1. **Fixture gap:** kv-smoke-1 must exist in both the control DB `apps` table AND the runtime DB `apps` table for accounting flush to work. The smoke fixture recipe should include inserting into the runtime DB, or the reconcile worker should handle orphaned apps more gracefully.

2. **Region mismatch:** `apps.region='us'` (short form) but `user_app_index.region` and `urlsByRegion` keys use `us-east-1` (full form). Inserted user_app_index with `us-east-1`; apps table still shows `us`. The `resolveKvAuth` path that falls back to the apps table gets region `us`, which maps to `KV_REDIS_URL_US` — that works. The `getRuntimeDbForApp` path reads from `user_app_index` which was set to `us-east-1` — that also works. No functional bug, but inconsistency worth noting.

---

## Overall

**ALL_GREEN** — all five sections (I, J, K, L, M) and regression checks passed.
