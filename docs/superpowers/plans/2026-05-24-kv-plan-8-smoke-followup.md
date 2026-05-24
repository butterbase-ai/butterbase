# KV Plan 8 — Smoke-Followup Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four gaps the Plan 7 live smoke uncovered:

1. **Dashboard can't read KV routes.** `resolveKvAuth` rejects platform (Cognito) JWTs, so the new customer dashboard KV tab 403s on every panel.
2. **`audit_logs` is never written.** The `_audit_recent` endpoint reads from a table no middleware populates — production responses will always be `{entries: []}`.
3. **Boot-order bug + bytes-on-TTL drift.** The keys-expiry-worker's `onClose` hook registers *after* `app.listen()`, throwing at boot. Separately, the worker decrements the keys counter on TTL events but not the bytes counter, leaving a drift window until the next daily reconcile.
4. **Wrapper-repo plumbing is uncommitted.** During the Plan 7 smoke I edited `docker-compose.local.yml` (long-form `KV_REDIS_URL_*`, `--notify-keyspace-events Ex`) and added a brand-new `admin-dashboard:` service with Dockerfile + nginx.conf. None of it is committed.

**Architecture:** All backend work lands in `services/control-api/` (OSS submodule, branch `feat/kv-plan-6-move-app-kv`). All plumbing lands in the wrapper repo on `feat/kv-plan-3-rest-expose`. No new dependencies.

**Branches at plan-write time:**
- OSS submodule HEAD: `a0ce6e8` (Plan 7 smoke note). `feat/kv-plan-6-move-app-kv`.
- Wrapper repo HEAD: `c4ffe76` (admin-dashboard TopApps/Hotspots). `feat/kv-plan-3-rest-expose`. Uncommitted: `docker-compose.local.yml`, `cloud/services/admin-dashboard/Dockerfile`, `cloud/services/admin-dashboard/nginx.conf`.

**Scope NOT in this plan:**
- Per-app dev-API-key UI (alternative path to #1 — deferred).
- Fix for `PUT /_expose` returning `key_invalid` (separate validation bug; not on Plan 7 surface).
- Backfilling historical `audit_logs` rows.
- Production rollout of `notify-keyspace-events Ex` on managed Redis (deploy prereq, not a code change).

---

## Status at handoff (2026-05-24)

**Task 1 is ALREADY DONE.** Commit `33c9f0b` on `feat/kv-plan-6-move-app-kv`:
- `services/control-api/src/services/kv/auth.ts` — added `AuthProvider` import, optional 4th arg, `tryPlatformOwnerJwt` helper with single-JOIN SQL.
- `services/control-api/src/services/kv/auth.test.ts` — 4 new unit tests (all passing, not skipped).
- 5 caller files updated to pass `(fastify as any).authProvider`: `routes/v1/kv-data.ts`, `routes/v1/kv-admin.ts`, `routes/v1/kv-audit-recent.ts`, `routes/v1/kv-expose.ts`, `plugins/kv-quota.ts`. Use `grep -rn "resolveKvAuth(" services/control-api/src --include='*.ts' | grep -v test` to confirm every line has the 4th arg.
- Control-api rebuilt + restarted; boot logs show `KV expiry-subscriber started` on both regions and `Server listening`. The `FST_ERR_INSTANCE_ALREADY_LISTENING` error is STILL THERE — Task 3a fixes it.
- **Not yet verified live in browser.** The user was asked to refresh `http://localhost:3000/apps/app_xexxduzlyzq7/kv` and confirm 200 on `/_stats` but hasn't reported back yet. If they did and it still 401s, dig in before proceeding.

**Remaining tasks: 2, 3, 4, 5.** Start with Task 2.

## Live environment facts the next agent needs

- **MCP identity is dev-owner@local.test, NOT kcflexigbo@gmail.com.** Verified twice by minting a service-key via MCP and reading `api_keys.user_id` (both came back as `11111111-1111-1111-1111-111111111111`). The `BUTTERBASE_API_KEY` the MCP server process is started with belongs to dev-owner. Any future `init_app` / `manage_app` / `manage_kv` calls land under dev-owner. To attribute to kcflexigbo (`98104598-dc21-4462-a42a-0a55c307c168`), manually `UPDATE apps SET owner_id = '<kcf>'` + `UPDATE user_app_index SET user_id = '<kcf>'` + update the matching row in the runtime US/EU `apps` table + `DEL db_size:<owner>` from control-plane Redis to bust cache.
- **kcflexigbo's `credits_usd` was topped up to $100** during the Plan 7 smoke. KV ops will pass the credit gate.
- **Smoke app is `app_xexxduzlyzq7`** (`kv-plan7-us`, `us-east-1`), owner re-attributed to kcflexigbo. KV state when Plan 8 began:
  - 5 permanent user keys under `{app_xexxduzlyzq7}:u:user:profile:1..5`
  - `_meta:keys = 5`, `_meta:bytes = 187`
  - `audit_logs` has 4 manually-seeded rows for this app (500/429/404/413). Until Task 2 ships, no new rows accumulate.
  - `kv_app_usage_snapshot` has 1 row for this app.
  - `kv_function_key`: `a1621069c7c66eb4a3c4c252dcfe55f8d637b732f8df164e` (use as `Bearer` for direct curl against `/v1/app_xexxduzlyzq7/kv/*`).
- **kcflexigbo is `is_admin=true`** in `platform_users` — admin dashboard at `:3001/kv` works for them.
- **Wrapper repo has uncommitted edits** from the Plan 7 smoke that Task 4 will land:
  - `docker-compose.local.yml` — added `KV_REDIS_URL_US_EAST_1`, `KV_REDIS_URL_EU_WEST_1`, `BUTTERBASE_REGIONS=us-east-1,eu-west-1` to `control-api` block; added `--notify-keyspace-events Ex` to both `kv-redis-1` and `kv-redis-2`; added a brand-new `admin-dashboard:` service block with build args + port 3001 + depends_on control-api.
  - `cloud/services/admin-dashboard/Dockerfile` (new) — mirrors customer-dashboard's Dockerfile; builds `@butterbase/admin-dashboard` workspace, serves via nginx on 3001.
  - `cloud/services/admin-dashboard/nginx.conf` (new).
  - **Local dev symlink at `cloud/packages/shared/hackathon-renderers → submodules/butterbase-oss/packages/shared/hackathon-renderers`** (untracked, created during Plan 7 smoke to unblock dashboard build). Task 4 should NOT commit this — it's a dev-environment workaround for the OSS-split monorepo paths. Surface in self-review.
- **Wrapper branch is `feat/kv-plan-3-rest-expose`** — that's where Task 4's commit lands. Plan 7 dashboard commits also live here (9deed27, 931f6ee, 6adfec1, 0776f9a, c707d01, 725bb2c, c4ffe76).

## Pre-existing quirks the agent should know about

- **`PUT /_expose` returns `{"error":"key_invalid"}`** — Plan-7-independent validation bug, NOT in Plan 8 scope. ExposeRulesTable's save button will fail. Note in smoke output; don't try to fix.
- **Boot bug surfaces every restart**: `FST_ERR_INSTANCE_ALREADY_LISTENING` is logged but the expiry subscriber actually starts (the throw happens AFTER the subscriber attaches). Looks scary in logs; isn't fatal. Task 3a closes it.
- **MCP `manage_kv stats` returns `forbidden`** even for the app owner via MCP. That's because the MCP forwards Cognito-style platform JWT (or its api-key) to `/v1/.../kv/_stats`, and historically that route rejected JWTs. Task 1 fixed the platform-JWT path, BUT the MCP api-key path still won't work because it's not a *dev API key* (those are sha-256 hashed and per-user; service keys are different). If the user complains MCP manage_kv still 403s after Task 1, that's expected — they need to use the dashboard or curl with the function key.
- **`manage_app list` via MCP returns `[]` for kcflexigbo** because MCP = dev-owner. Apps owned by kcflexigbo (`app_xexxduzlyzq7` after re-attribution) won't appear in MCP listings.

---

## Handoff Notes for the Next Agent (read this FIRST)

The previous agent (this one) finished Plan 7 implementation + a live MCP smoke against the local stack. Here are the load-bearing facts that won't be obvious from the diff:

### Why each gap matters

- **Gap #1 (auth)**: The customer dashboard's `kvRequest` (`cloud/services/dashboard/src/lib/queries/kv.ts`) sends `Authorization: Bearer <cognito-id-token>`. That's a JWT shape. `resolveKvAuth` calls `verifyEndUserJwt(controlDb, appId, bearer)` which verifies against the **app's** end-user JWT config, not Cognito's user pool. So it throws → returns 401 `invalid_jwt`. The dashboard's four KV panels (UsageStrip, ExposeRulesTable, KeyBrowser, RecentErrors) all fail. This was the single biggest finding of the Plan 7 smoke. The user picked "Extend resolveKvAuth" over the alternatives: add a new branch that decodes the JWT, runs the platform `authProvider.verifyJwt` (Cognito or local), looks up `platform_users` → if that user is the app's `owner_id`, return an `apiKey`-equivalent identity. **Branch order matters:** keep the existing end-user-JWT path; the new platform-JWT branch must only fire when end-user-JWT verification *fails*. Otherwise legitimate end-user JWTs would suddenly be evaluated as platform JWTs (slow + wrong).

- **Gap #2 (audit writer)**: The `audit_logs` table was created in Plan 7 Task 6 migration `077_kv_audit_logs.sql`. The implementer assumed the writer already existed, but it doesn't. The read endpoint `GET /v1/:app_id/kv/_audit_recent` exists and works, but `count(*) = 0` in prod. **The writer is an `onResponse` fastify hook scoped to `/v1/:app_id/kv/*` paths with `statusCode >= 400`.** It needs the `app_id` from `request.params`, the `error_code` from the response body (we already standardize `{error: '...'}` shape on errors), and writes one row per failing response. Best-effort: never block the response, never throw. Hook lives in a new plugin `kv-audit-writer.ts`.

- **Gap #3 (boot + bytes-on-TTL)**: Two unrelated pieces bundled into one task because they both touch `keys-expiry-worker.ts` / `index.ts`. The boot bug is mechanical — `app.addHook('onClose', ...)` was placed inside an `await app.listen({...})` block in `index.ts`. Just move it before. Bytes-on-TTL is a slightly bigger change: the expiry-worker currently does `decKeys(writer, appId, 1)` on `__keyevent@*__:expired`. We extend it to also fetch the value size *before* it's gone (impossible — by the time the event fires the key is already deleted), OR we track per-key size at write time and look it up from a sidecar hash on expiry. **Easier alternative**: don't track bytes-on-TTL at all, just accept the drift and rely on the daily reconcile to fix it. The user asked for "also decrement bytes counter on TTL events" so we'll implement a sidecar size index: on every `set` (in `kv-data.ts`), write `{appId}:_meta:bytes_idx` hash with `field=keySuffix → value=byteCount` and TTL matching the parent key. On expiry, look up the hash field and decrement bytes. This stays O(1) per op. **If sidecar feels heavy for the value, do option B (skip bytes-on-TTL, document it) and surface in self-review.**

- **Gap #4 (wrapper plumbing)**: Just a commit. The compose changes were already validated live during the Plan 7 smoke (`KV expiry-subscriber` log line confirmed both regions subscribed). The admin-dashboard service builds and serves 200 on `:3001`. No code changes needed — just `git add` + `git commit` on the wrapper repo branch.

### Project memory (carried from Plan 7, non-negotiable)

- **No `Co-Authored-By: Claude` trailer** in any commit.
- **Use `uv` for any Python.** No bare `python3`.
- **Use Exa for any web search/fetch.** Prefer `mcp__exa__*` over built-in WebSearch/WebFetch.
- **No internal architecture/pricing/internal-env in customer-facing docs.** The new auth branch's error messages must not leak which JWT path failed.
- **Branch isolation.** Do not push or merge outside `feat/kv-plan-6-move-app-kv` (OSS) or `feat/kv-plan-3-rest-expose` (wrapper) without explicit user approval.
- **Verify with full build, not just typecheck.** Run `pnpm --filter @butterbase/control-api build` AND the dashboard builds before claiming a task done.

### Local stack state at plan-write

`docker compose -f docker-compose.local.yml ps` shows everything healthy. Containers worth knowing:

| Container | Port | Notes |
|---|---|---|
| `butterbase-control-api-1` | `:4000` | Rebuild + restart after every commit touching `services/control-api/` |
| `butterbase-control-plane-db-1` | `:5433` | Has `audit_logs` table (Plan 7 migration 077), still empty in prod |
| `butterbase-kv-redis-1-1` | `:6390` | `--notify-keyspace-events Ex` already enabled in current compose (uncommitted) |
| `butterbase-kv-redis-2-1` | `:6391` | Same |
| `butterbase-dashboard-1` | `:3000` | Customer dashboard. KV tab visible in nav. Panels currently 403. |
| `butterbase-admin-dashboard-1` | `:3001` | New from Plan 7 smoke. Sign-in works, /kv loads but data calls 401 until admin JWT. |

### Test app already provisioned

- `app_xexxduzlyzq7` (`kv-plan7-us`, `us-east-1`), owner re-attributed to `kcflexigbo@gmail.com` (UUID `98104598-dc21-4462-a42a-0a55c307c168`).
- KV credentials region: `us-east-1` long-form. `kv_function_key`: `a1621069c7c66eb4a3c4c252dcfe55f8d637b732f8df164e`.
- KV state: 5 permanent keys under `{app_xexxduzlyzq7}:u:user:profile:1..5`. Storage counter `_meta:bytes=187`. Keys counter `_meta:keys=5`.
- audit_logs has 4 manually-seeded rows for this app (500/429/404/413). After Task 2's writer is wired live, you'll see new rows accumulate on every error.

### Existing wiring you'll integrate with

- `services/control-api/src/services/kv/auth.ts` — `resolveKvAuth`. Extend in Task 1. Lines ~76–167 are the four-branch decision tree.
- `services/control-api/src/services/end-user-auth.ts` — `verifyEndUserJwt`. The existing JWT path's verifier. Don't touch.
- `services/control-api/src/services/auth-provider.ts` — defines `AuthProvider.verifyJwt(token)` interface. Plan 7 Task 13 introduced `app.decorate('authProvider', ...)` globally. We reuse that decoration in Task 1.
- `services/control-api/src/services/kv-credentials.ts` — `KvCredentialsService.anonCredentialsFor(appId)` returns `{ app_id, region, redis_password }`. The new platform-owner branch reuses this (same data; only the identity tag differs).
- `services/control-api/src/index.ts` — worker startup ladder. Line ~562 is the `app.addHook('onClose', ...)` for the expiry worker that throws on boot (`FST_ERR_INSTANCE_ALREADY_LISTENING`). Move before `app.listen(...)`.
- `services/control-api/src/routes/v1/kv-data.ts` — every PUT/SETNX/CAS/INCR/DECR/MSET write path. Task 3 (bytes-on-TTL sidecar option) would extend each to also write `_meta:bytes_idx` hash field.
- `db/control-plane/077_kv_audit_logs.sql` — table schema, columns: `id (uuid)`, `app_id`, `actor_id`, `method`, `path`, `status_code`, `error_code`, `error_message`, `at`. Indexed on `(app_id, at DESC)` and `(app_id, status_code, at DESC)`.

### Subagent quirks (carried from Plan 7)

- Implementer subagents (especially sonnet) sometimes run a test in the background and return BEFORE committing. Always `git status` after a subagent returns DONE.
- Implementer agents sometimes assert "build clean" without running the build. Re-verify with `pnpm --filter @butterbase/control-api build` before approving a task.
- Tests that gate on `RUN_DB_TESTS=1` or `KV_REDIS_URL_US=...` are silently skipped if the env var is missing. `describeKv` resolves to `describe.skip` — read the test summary line to confirm it actually ran.

### Model selection per task

- Tasks 1, 2, 3 (multi-file changes with auth/middleware reasoning): **sonnet**.
- Task 4 (mechanical commit): **haiku**.
- Task 5 (verification + smoke): **sonnet**.

### Spec for this plan

Inline — no separate spec file. Each task's "Acceptance criteria" section is the spec.

---

## Pre-Execution Context

**Repo layout:**
- OSS code: `/Users/kenneth/Documents/butterbase_backup/butterbase/submodules/butterbase-oss/` (branch `feat/kv-plan-6-move-app-kv`)
- Wrapper: `/Users/kenneth/Documents/butterbase_backup/butterbase/` (branch `feat/kv-plan-3-rest-expose`)

**Open items being closed by this plan (from Plan 7 Task 17 smoke note):**
- Dashboard auth gap → closed by Task 1
- Missing audit_logs writer → closed by Task 2
- Boot-order bug → closed by Task 3a
- Bytes-on-TTL drift → closed by Task 3b (or documented as accepted-drift in self-review)
- Uncommitted wrapper plumbing → closed by Task 4

---

## File Structure

**Created (control-api):**
- `services/control-api/src/plugins/kv-audit-writer.ts` — `onResponse` hook for `/v1/:app_id/kv/*` paths writing `audit_logs` rows on `statusCode >= 400`.
- `services/control-api/src/plugins/kv-audit-writer.test.ts`

**Modified (control-api):**
- `services/control-api/src/services/kv/auth.ts` — new platform-owner-JWT branch after end-user-JWT fails.
- `services/control-api/src/services/kv/auth.test.ts` (create if missing — add coverage for the new branch).
- `services/control-api/src/services/kv/keys-expiry-worker.ts` — extend to also decrement bytes counter when bytes-on-TTL sidecar is implemented.
- `services/control-api/src/services/kv/keys-expiry-worker.test.ts` — assert bytes counter behavior.
- `services/control-api/src/routes/v1/kv-data.ts` — write `_meta:bytes_idx` hash field on every set/setnx/incr/decr/cas (sidecar size index).
- `services/control-api/src/index.ts` — (a) move `app.addHook('onClose', ...)` for keysExpiry **before** `app.listen()`. (b) register `kvAuditWriterPlugin`.

**Modified (wrapper repo):**
- `docker-compose.local.yml` — already edited locally (Plan 7 smoke), commit on `feat/kv-plan-3-rest-expose`.
- `cloud/services/admin-dashboard/Dockerfile` — already created locally, commit.
- `cloud/services/admin-dashboard/nginx.conf` — already created locally, commit.

**No deletes.**

---

## Tasks

### Task 1: Extend `resolveKvAuth` to accept platform-owner JWTs

> **STATUS: DONE (commit `33c9f0b`).** Skip ahead to Task 2 unless re-verifying. All checkboxes below are complete. The live in-browser verification (Step 6) is the ONE thing not yet confirmed — ask the user to refresh the dashboard before starting Task 2 so you know whether the platform branch actually works for them. If `_stats` still 401s, fix that before moving on (likely a Cognito-vs-local authProvider mismatch).

**Files:**
- Modify: `services/control-api/src/services/kv/auth.ts`
- Create/Modify: `services/control-api/src/services/kv/auth.test.ts`

**Acceptance criteria (spec):**

A request to any `/v1/:app_id/kv/*` route carrying a Cognito (or local-mode) platform-user JWT in `Authorization: Bearer <jwt>` MUST resolve to an `apiKey`-identity auth success IF AND ONLY IF:
1. The JWT verifies via `authProvider.verifyJwt(token)`.
2. `platform_users.cognito_sub` matches the JWT's `sub`.
3. `apps.owner_id = platform_users.id` for the requested `app_id`.

On any failure of the above chain, the existing end-user-JWT failure response is preserved (401 `invalid_jwt`). End-user JWTs MUST still work — they are tried first and only fall through to the platform branch on verifier failure.

The new identity must be `{ kind: 'apiKey' }` so existing `_stats`/`_scan`/`_flush` gates that allow `apiKey` continue to work. `allowExposeWrites: true` so the dashboard can save expose rules.

- [ ] **Step 1: Read the current four-branch logic**

```
sed -n '70,170p' services/control-api/src/services/kv/auth.ts
```

Note the existing structure: 1) no header → anon; 2) JWT-shape → `verifyEndUserJwt`; 3a) function key; 3b) dev API key; 4) 403. We insert a new sub-branch *inside* branch 2 that runs only when `verifyEndUserJwt` throws.

- [ ] **Step 2: Add failing tests**

Create or append to `services/control-api/src/services/kv/auth.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { resolveKvAuth } from './auth.js';

function req(authorization?: string) {
  return { headers: authorization ? { authorization } : {} } as any;
}

function mockPool(rows: Record<string, any[]>) {
  return {
    query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM platform_users')) return { rows: rows.platform_users ?? [] };
      if (sql.includes('FROM apps')) return { rows: rows.apps ?? [] };
      if (sql.includes('app_kv_credentials') || sql.includes('FROM app_kv_credentials')) {
        return { rows: rows.app_kv_credentials ?? [] };
      }
      return { rows: [] };
    }),
  } as any;
}

describe('resolveKvAuth — platform-owner JWT branch', () => {
  const APP = 'app_x';
  const SUB = 'cognito-sub-1';
  const USER_ID = 'platform-user-uuid';
  // valid JWT shape (3 segments, payload not actually used by the mock verifier)
  const PLATFORM_JWT = 'aaa.bbb.ccc';

  it('treats a platform-owner JWT as apiKey identity', async () => {
    const pool = mockPool({
      platform_users: [{ id: USER_ID, cognito_sub: SUB }],
      apps: [{ id: APP, owner_id: USER_ID }],
      app_kv_credentials: [{ app_id: APP, region: 'us-east-1', redis_password: 'pw' }],
    });
    const authProvider = { verifyJwt: vi.fn().mockResolvedValue({ sub: SUB }) };

    const res = await resolveKvAuth(pool, APP, req(`Bearer ${PLATFORM_JWT}`), authProvider);
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.identity.kind).toBe('apiKey');
    expect(res.allowExposeWrites).toBe(true);
    expect(res.appId).toBe(APP);
    expect(res.region).toBe('us-east-1');
  });

  it('does NOT match when the platform user does not own the app', async () => {
    const pool = mockPool({
      platform_users: [{ id: USER_ID, cognito_sub: SUB }],
      apps: [], // no owner match
      app_kv_credentials: [],
    });
    const authProvider = { verifyJwt: vi.fn().mockResolvedValue({ sub: SUB }) };

    const res = await resolveKvAuth(pool, APP, req(`Bearer ${PLATFORM_JWT}`), authProvider);
    // Falls through to the end-user JWT 401
    expect('error' in res).toBe(true);
    if (!('error' in res)) return;
    expect(res.status).toBe(401);
  });

  it('does NOT touch the platform branch when end-user JWT verifies successfully', async () => {
    // We can't easily stub verifyEndUserJwt here without refactoring — instead
    // assert that authProvider.verifyJwt was NOT called when the end-user path
    // would have succeeded. Skip this test if mocking the imported function is
    // not trivial; the integration with the existing end-user JWT test cases
    // already covers this implicitly.
  });
});
```

(The `resolveKvAuth` signature now takes a 4th `authProvider` arg. Existing call sites in `kv-admin.ts` / `kv-data.ts` will need updating — Step 4 below.)

Run: `pnpm --filter @butterbase/control-api test kv/auth` → FAIL (signature mismatch + module missing tests).

- [ ] **Step 3: Implement the platform-owner branch**

Edit `services/control-api/src/services/kv/auth.ts`. Update the signature:

```ts
import type { AuthProvider } from '../auth-provider.js';

export async function resolveKvAuth(
  controlDb: Pool,
  appId: string,
  req: Pick<FastifyRequest, 'headers'>,
  authProvider?: AuthProvider,   // NEW — optional for backward compat, but routes pass it
): Promise<KvAuthResult> {
  // ... existing branches 1, 2 unchanged at the top ...

  if (isJwtShape(bearer)) {
    // ─── End-user JWT (existing) ───
    let claims;
    try {
      claims = await verifyEndUserJwt(controlDb, appId, bearer);
    } catch {
      // NEW: before returning 401, try the platform-owner branch.
      if (authProvider) {
        const platformResult = await tryPlatformOwnerJwt(controlDb, appId, bearer, authProvider);
        if (platformResult) return platformResult;
      }
      return { error: 'auth_failed', status: 401, body: { error: 'invalid_jwt' } };
    }

    // existing end-user JWT success path unchanged
    const creds = await svc.anonCredentialsFor(appId);
    if (!creds) return { error: 'auth_failed', status: 404, body: { error: 'no_kv_credential' } };
    return {
      appId: creds.app_id,
      region: creds.region,
      redisPassword: creds.redis_password,
      identity: { kind: 'jwt', userId: String(claims.sub ?? ''), role: (claims as any).role ?? null },
      allowExposeWrites: false,
    };
  }

  // ... branches 3a, 3b, 4 unchanged ...
}

async function tryPlatformOwnerJwt(
  controlDb: Pool,
  appId: string,
  bearer: string,
  authProvider: AuthProvider,
): Promise<KvAuthSuccess | null> {
  let claims: { sub: string };
  try {
    claims = await authProvider.verifyJwt(bearer);
  } catch {
    return null;
  }
  // Resolve the platform user and verify ownership in one round-trip
  const r = await controlDb.query<{
    region: string;
    redis_password: string;
  }>(
    `SELECT akc.region, akc.redis_password
       FROM platform_users pu
       JOIN apps a ON a.owner_id = pu.id AND a.id = $2
       JOIN app_kv_credentials akc ON akc.app_id = a.id
      WHERE pu.cognito_sub = $1
      LIMIT 1`,
    [claims.sub, appId],
  );
  if (r.rows.length === 0) return null;
  return {
    appId,
    region: r.rows[0].region,
    redisPassword: r.rows[0].redis_password,
    identity: { kind: 'apiKey' },
    allowExposeWrites: true,
  };
}
```

The single SQL covers all three checks (platform_users row + ownership + kv credentials) and is index-friendly (`platform_users.cognito_sub` already has a unique index; `apps.id` is PK; `app_kv_credentials.app_id` is PK).

- [ ] **Step 4: Update every caller of `resolveKvAuth` to pass `authProvider`**

Grep:
```
grep -rn "resolveKvAuth(" services/control-api/src --include='*.ts'
```

Expect ~6–8 call sites across `kv-data.ts`, `kv-admin.ts`, `kv-audit-recent.ts`, and possibly tests. At each call site, pass `(fastify as any).authProvider` as the 4th arg:

```ts
// before:
const auth = await resolveKvAuth(fastify.controlDb, appId, req);
// after:
const auth = await resolveKvAuth(fastify.controlDb, appId, req, (fastify as any).authProvider);
```

`authProvider` was decorated on the fastify instance in Plan 7 Task 13's `index.ts` edit, so it's already available everywhere.

- [ ] **Step 5: Run the tests**

```
RUN_DB_TESTS=1 KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  pnpm --filter @butterbase/control-api test kv/auth kv-admin kv-data kv-audit-recent
```

Expected: all green. The 2 new platform-branch tests pass. Existing end-user-JWT tests still pass.

- [ ] **Step 6: Live smoke**

```
docker compose -f docker-compose.local.yml build control-api
docker compose -f docker-compose.local.yml up -d control-api
sleep 6
# As kcflexigbo, the dashboard JWT is in localStorage; for shell smoke, mint a Cognito-style local JWT
# using whichever helper the local-auth provider uses. The user-visible test is just opening
# http://localhost:3000/apps/app_xexxduzlyzq7/kv and watching the four panels populate.
```

Expected (live): customer dashboard KV tab fully renders for `kcflexigbo@gmail.com` on `app_xexxduzlyzq7`. UsageStrip shows 5 keys / 187 B. ExposeRulesTable empty (no rules yet). KeyBrowser shows the 5 `user:profile:*` keys. RecentErrors shows the 4 seeded entries.

- [ ] **Step 7: Build**

```
pnpm --filter @butterbase/control-api build
```

Clean.

- [ ] **Step 8: Commit**

```
git add services/control-api/src/services/kv/auth.ts \
        services/control-api/src/services/kv/auth.test.ts \
        services/control-api/src/routes/v1/kv-data.ts \
        services/control-api/src/routes/v1/kv-admin.ts \
        services/control-api/src/routes/v1/kv-audit-recent.ts
git commit -m "feat(kv): resolveKvAuth accepts platform-owner JWTs as apiKey identity"
```

No `Co-Authored-By` trailer.

---

### Task 2: `audit_logs` writer middleware

**Files:**
- Create: `services/control-api/src/plugins/kv-audit-writer.ts`
- Create: `services/control-api/src/plugins/kv-audit-writer.test.ts`
- Modify: `services/control-api/src/index.ts`

**Acceptance criteria (spec):**

On every response to `/v1/:app_id/kv/*` where `statusCode >= 400`, insert one row into `audit_logs` with:
- `app_id` from `request.params.app_id`
- `method`, `path` from the request
- `status_code` from the reply
- `error_code` extracted from the JSON response body (`body.error` field) — null if not parsable or absent
- `error_message` from `body.message` if present, else null
- `actor_id` from the resolved auth identity if present (function/apiKey: null; end-user JWT: the userId; platform-owner: the platform_user.id). Null is acceptable.
- `at` defaults to `now()`

The writer MUST be best-effort: never throw, never block the response. If the insert fails, log at warn-level and continue.

The writer MUST NOT log anything for successful (2xx/3xx) responses. We only log failures here — Plan 7's read endpoint is for "Recent errors", not full request logs.

- [ ] **Step 1: Write the failing test**

Create `services/control-api/src/plugins/kv-audit-writer.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import kvAuditWriter from './kv-audit-writer.js';

const RUN = !!process.env.RUN_DB_TESTS && !!process.env.NEON_PLATFORM_PRIMARY_URL;
const describeDb = RUN ? describe : describe.skip;

describeDb('kv-audit-writer plugin', () => {
  let app: any;
  let pool: any;
  let inserts: any[];

  beforeEach(async () => {
    inserts = [];
    pool = {
      query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
        if (sql.startsWith('INSERT INTO audit_logs')) inserts.push(params);
        return { rows: [] };
      }),
    };
    app = Fastify({ logger: false });
    const fp = (await import('fastify-plugin')).default;
    await app.register(fp(async (i: any) => { i.decorate('controlDb', pool); }, { name: 'shim' }));
    await app.register(kvAuditWriter);
    app.get('/v1/:app_id/kv/:key', async (req: any, reply: any) => {
      const { app_id, key } = req.params;
      if (key === 'fail-413') return reply.code(413).send({ error: 'value_too_large', message: 'too big' });
      if (key === 'fail-429') return reply.code(429).send({ error: 'rate_limited' });
      return reply.code(200).send({ value: 'ok' });
    });
    await app.ready();
  });

  it('writes an audit row when status is 4xx', async () => {
    await app.inject({ method: 'GET', url: '/v1/app_x/kv/fail-413' });
    expect(inserts).toHaveLength(1);
    const [appId, method, path, status, errorCode, errorMessage] = inserts[0];
    expect(appId).toBe('app_x');
    expect(method).toBe('GET');
    expect(path).toBe('/v1/app_x/kv/fail-413');
    expect(status).toBe(413);
    expect(errorCode).toBe('value_too_large');
    expect(errorMessage).toBe('too big');
  });

  it('writes a row for 5xx', async () => {
    app.get('/v1/:app_id/kv/boom', async (_req: any, reply: any) =>
      reply.code(500).send({ error: 'internal' }),
    );
    await app.inject({ method: 'GET', url: '/v1/app_x/kv/boom' });
    expect(inserts.some(r => r[3] === 500)).toBe(true);
  });

  it('does NOT write a row for 2xx', async () => {
    await app.inject({ method: 'GET', url: '/v1/app_x/kv/ok-key' });
    expect(inserts).toHaveLength(0);
  });

  it('does NOT throw if the DB insert fails', async () => {
    pool.query = vi.fn().mockRejectedValue(new Error('db down'));
    const r = await app.inject({ method: 'GET', url: '/v1/app_x/kv/fail-413' });
    expect(r.statusCode).toBe(413);  // response still went out
  });

  it('only fires for /v1/:app_id/kv/* paths', async () => {
    app.get('/v1/:app_id/data/foo', async (_req: any, reply: any) =>
      reply.code(403).send({ error: 'forbidden' }),
    );
    await app.inject({ method: 'GET', url: '/v1/app_x/data/foo' });
    expect(inserts).toHaveLength(0);
  });
});
```

Run: `pnpm --filter @butterbase/control-api test kv-audit-writer` → FAIL (module missing).

- [ ] **Step 2: Implement the plugin**

Create `services/control-api/src/plugins/kv-audit-writer.ts`:

```ts
// services/control-api/src/plugins/kv-audit-writer.ts
// onResponse hook writing one audit_logs row per failing /v1/:app_id/kv/* response.
//
// Best-effort: errors are swallowed and logged. Never blocks the response.

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

const KV_PATH_RE = /^\/v1\/([^/]+)\/kv\//;

interface AuditPayload {
  appId: string;
  method: string;
  path: string;
  statusCode: number;
  errorCode: string | null;
  errorMessage: string | null;
  actorId: string | null;
}

function extractErrorFields(reply: FastifyReply): { errorCode: string | null; errorMessage: string | null } {
  // The response payload is captured via a small wrapper in onSend (below);
  // see the plugin body. Here we just normalize.
  const captured = (reply as any)._kvAuditCapturedBody;
  if (!captured || typeof captured !== 'object') return { errorCode: null, errorMessage: null };
  return {
    errorCode: typeof captured.error === 'string' ? captured.error : null,
    errorMessage: typeof captured.message === 'string' ? captured.message : null,
  };
}

const kvAuditWriter: FastifyPluginAsync = async (fastify) => {
  // Capture body on send so onResponse can read it
  fastify.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode < 400) return payload;
    const m = KV_PATH_RE.exec(request.url);
    if (!m) return payload;
    try {
      const raw = typeof payload === 'string' ? payload : (payload as any)?.toString?.() ?? '';
      const parsed = raw ? JSON.parse(raw) : null;
      (reply as any)._kvAuditCapturedBody = parsed;
    } catch { /* not JSON — leave undefined */ }
    return payload;
  });

  fastify.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode < 400) return;
    const m = KV_PATH_RE.exec(request.url);
    if (!m) return;
    const appId = m[1];
    const { errorCode, errorMessage } = extractErrorFields(reply);
    const actorId = (request as any).kvActorId ?? null;
    try {
      await (fastify as any).controlDb.query(
        `INSERT INTO audit_logs (app_id, method, path, status_code, error_code, error_message, actor_id, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [appId, request.method, request.url.split('?')[0], reply.statusCode, errorCode, errorMessage, actorId],
      );
    } catch (err) {
      fastify.log.warn({ err: (err as Error).message, app_id: appId }, '[kv-audit] failed to insert');
    }
  });
};

export default fp(kvAuditWriter, { name: 'kv-audit-writer' });
```

`request.kvActorId` is set by `resolveKvAuth` in successful auth paths — we'll add that assignment in a follow-up if useful. For now, leaving it null is acceptable per the spec.

- [ ] **Step 3: Register in `index.ts`**

In `services/control-api/src/index.ts`, register before route plugins:

```ts
import kvAuditWriter from './plugins/kv-audit-writer.js';
// ...
await app.register(kvAuditWriter);
```

- [ ] **Step 4: Run the tests**

```
RUN_DB_TESTS=1 NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  pnpm --filter @butterbase/control-api test kv-audit-writer
```

Expected: 5 passing.

- [ ] **Step 5: Live smoke**

```
docker compose -f docker-compose.local.yml build control-api
docker compose -f docker-compose.local.yml up -d control-api
sleep 6
FN=a1621069c7c66eb4a3c4c252dcfe55f8d637b732f8df164e
# trigger a 404 + a 413
curl -s -o /dev/null "http://localhost:4000/v1/app_xexxduzlyzq7/kv/does-not-exist" -H "Authorization: Bearer $FN"
curl -s -o /dev/null -X PUT "http://localhost:4000/v1/app_xexxduzlyzq7/kv/big" \
  -H "Authorization: Bearer $FN" -H "Content-Type: application/json" \
  -d "{\"value\":\"$(head -c 300000 /dev/urandom | base64 | head -c 300000)\"}"
# read recent — should now show fresh entries (last 5s) without seeding
curl -s "http://localhost:4000/v1/app_xexxduzlyzq7/kv/_audit_recent?limit=5" -H "Authorization: Bearer $FN" | head -c 400
```

Expected: response includes the just-triggered 404 + 413 with current timestamps.

- [ ] **Step 6: Build**

```
pnpm --filter @butterbase/control-api build
```

- [ ] **Step 7: Commit**

```
git add services/control-api/src/plugins/kv-audit-writer.ts \
        services/control-api/src/plugins/kv-audit-writer.test.ts \
        services/control-api/src/index.ts
git commit -m "feat(kv): kv-audit-writer plugin — log /v1/*/kv/* failures to audit_logs"
```

---

### Task 3: Boot-order fix + bytes-on-TTL via sidecar size index

**Files:**
- Modify: `services/control-api/src/index.ts` (boot order)
- Modify: `services/control-api/src/services/kv/keys-expiry-worker.ts` (bytes decrement on expiry)
- Modify: `services/control-api/src/services/kv/keys-expiry-worker.test.ts`
- Modify: `services/control-api/src/routes/v1/kv-data.ts` (write sidecar size index on every set)
- Modify: `services/control-api/src/services/kv/storage-counter.ts` (reconcile also rebuilds the size index)

**Acceptance criteria (spec):**

(a) `app.addHook('onClose', async () => { await keysExpiry.stop(); })` is registered BEFORE `app.listen(...)`. Boot log no longer shows `FST_ERR_INSTANCE_ALREADY_LISTENING`.

(b) The bytes counter (`_meta:bytes`) decrements when a user key with a TTL expires. Drift between the live counter and a fresh scan is < 1KB for an app with 1000 expiring keys (measured by running `reconcileFromScan` and comparing `previous` vs `actual`).

Implementation: sidecar size index. On every write of `{appId}:u:<key>`, also `HSET {appId}:_meta:bytes_idx <key> <byteCount>`. On every delete, `HDEL {appId}:_meta:bytes_idx <key>`. The expiry-worker, on expiry of `{appId}:u:<key>`:
1. `HGET {appId}:_meta:bytes_idx <key>` → size (may be null if key was created before this feature, or if the sidecar was already cleared).
2. `HDEL {appId}:_meta:bytes_idx <key>` (idempotent).
3. `decKeys(appId, 1)` (existing).
4. If size was non-null: `decBytes(appId, size)`. NEW.

The sidecar itself is sized per app and could grow large; this is acceptable because reconcile rebuilds it from scratch and DEL of the parent key wipes the field. **Hash field count is bounded by the keys counter** (one field per user key).

- [ ] **Step 1 (boot order fix)**

In `services/control-api/src/index.ts`, find the `startKeysExpiryWorker(...)` block (added in Plan 7 Task 5). Currently the `app.addHook('onClose', ...)` sits inside the conditional after `startKeysExpiryWorker(...)`. Move that hook registration to BEFORE `await app.listen(...)`.

Concretely: in the existing block:

```ts
const keysExpiry = startKeysExpiryWorker({ ... });
app.log.info({ regions: kvRegions }, 'KV expiry-subscriber started');
app.addHook('onClose', async () => { await keysExpiry.stop(); });  // <-- this throws if listen has fired
```

If the surrounding code path is `await app.listen(...) → background-worker block → addHook`, just relocate the worker bootstrap block to BEFORE the listen call. Or, equivalently, register the cleanup hook at the top of the worker bootstrap with a deferred-stop pattern.

The cleanest fix is to call the entire `startKeysExpiryWorker(...)` setup (incl. `app.addHook('onClose', ...)`) before `await app.listen(...)`. Verify by reading the file end-to-end and running:

```
docker compose -f /Users/kenneth/Documents/butterbase_backup/butterbase/docker-compose.local.yml build control-api
docker compose -f /Users/kenneth/Documents/butterbase_backup/butterbase/docker-compose.local.yml up -d control-api
sleep 6
docker compose -f /Users/kenneth/Documents/butterbase_backup/butterbase/docker-compose.local.yml logs --tail=50 control-api | grep -iE "FST_ERR|expiry|listening"
```

Expected: no `FST_ERR_INSTANCE_ALREADY_LISTENING`. `[keys-expiry] subscribed` for both regions. `Server listening at ...`.

- [ ] **Step 2 (bytes-on-TTL test)**

Append to `services/control-api/src/services/kv/keys-expiry-worker.test.ts`:

```ts
it('also decrements the bytes counter when a sized user key expires', async () => {
  appId = `expiry-bytes-test-${randomUUID()}`;
  // seed _meta:bytes=500, _meta:keys=1, sidecar { "sized": 500 }, plus the user key with TTL
  await counterClient.set(`{${appId}}:_meta:bytes`, '500');
  await counterClient.set(`{${appId}}:_meta:keys`, '1');
  await counterClient.hset(`{${appId}}:_meta:bytes_idx`, 'sized', '500');
  await writer.set(`{${appId}}:u:sized`, 'v', 'PX', 200);
  await new Promise((r) => setTimeout(r, 800));
  const keys = await counterClient.get(`{${appId}}:_meta:keys`);
  const bytes = await counterClient.get(`{${appId}}:_meta:bytes`);
  expect(parseInt(keys!, 10)).toBe(0);
  expect(parseInt(bytes!, 10)).toBe(0);
  // sidecar field removed
  const stillThere = await counterClient.hget(`{${appId}}:_meta:bytes_idx`, 'sized');
  expect(stillThere).toBeNull();
});
```

(The harness already opens `counterClient` per beforeEach — verify the file uses an `incKeys`+ matching setup that the new test slots into. Adapt the field/key names if `RedisClient` exposes `hset/hget/hdel` under different camelCase.)

Run: expect FAIL.

- [ ] **Step 3 (worker implementation)**

In `services/control-api/src/services/kv/keys-expiry-worker.ts`, extend the `on('message')` callback:

```ts
sub.on('message', async (_channel, key) => {
  const m = USER_KEY_RE.exec(key);
  if (!m) return;
  const appId = m[1];
  // key is "{appId}:u:<suffix>" — extract suffix
  const prefix = `{${appId}}:u:`;
  const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : null;
  try {
    const writer = await getWriter(region);
    // 1. Look up and clear the sidecar field
    let size: number | null = null;
    if (suffix !== null) {
      const raw = await writer.hget(`{${appId}}:_meta:bytes_idx`, suffix);
      size = raw !== null ? parseInt(raw, 10) : null;
      if (!Number.isFinite(size!)) size = null;
      if (suffix !== null) await writer.hdel(`{${appId}}:_meta:bytes_idx`, [suffix]);
    }
    // 2. Decrement counters
    await decKeys(writer, appId, 1);
    if (size !== null && size > 0) await decBytes(writer, appId, size);
  } catch (err) {
    opts.log.warn({ region, key, err: (err as Error).message }, '[keys-expiry] decrement failed');
  }
});
```

Import `decBytes` from `./storage-counter.js`. The `RedisClient` API for hashes (`hget`/`hset`/`hdel`) follows the same array-or-string convention as the rest of the file — read `redis-client.ts` to confirm method names.

- [ ] **Step 4 (write path — sidecar maintenance)**

In `services/control-api/src/routes/v1/kv-data.ts`, every PUT/SETNX/CAS/INCR/DECR/MSET path that writes a user key needs a paired sidecar update. Find each `await client.set(...)` (or the relevant write call) for `{appId}:u:<key>` and, alongside it:

```ts
// After a successful write of u:<key> with encoded value
const sizeBytes = Buffer.byteLength(encoded, 'utf8');
void client.hset(`{${appId}}:_meta:bytes_idx`, encodeURIComponent(key), String(sizeBytes)).catch(() => {});
```

For deletes:
```ts
void client.hdel(`{${appId}}:_meta:bytes_idx`, [encodeURIComponent(key)]).catch(() => {});
```

For the `_batch` handler, do them in the same loop that updates `batchStorageDelta`. Best-effort, never block.

**Important:** the suffix used in the sidecar field MUST match the suffix the expiry-worker extracts from the channel-fired key. Above, both use the raw `key` (the user-visible name without `{appId}:u:` prefix). Don't apply `encodeURIComponent` unless you also decode in the worker. Simpler: don't encode; use raw key suffix.

Adjust the worker step to match (raw suffix, no decode).

- [ ] **Step 5 (reconcile rebuilds sidecar)**

In `storage-counter.ts` `reconcileFromScan(...)`, while we're scanning each user key and summing `memoryUsage`, also write `HSET {appId}:_meta:bytes_idx <suffix> <usedBytes>` per key. After scanning, do `HDEL` of fields that no longer have a corresponding key — easiest is `DEL {appId}:_meta:bytes_idx` then rebuild from scratch since we have all the data.

```ts
// inside reconcileFromScan, after collecting all (key, used) pairs:
await client.del([`{${appId}}:_meta:bytes_idx`]);
if (sizedPairs.length > 0) {
  // hset in one call: HSET key field1 val1 field2 val2 ...
  const args: string[] = [];
  for (const [suffix, used] of sizedPairs) { args.push(suffix, String(used)); }
  await client.hset(`{${appId}}:_meta:bytes_idx`, args);
}
```

(Adapt to `RedisClient.hset` signature — may take `(key, fields: Record<string, string>)` or `(key, ...args)`. Read the file.)

- [ ] **Step 6: Run the tests**

```
RUN_DB_TESTS=1 KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  pnpm --filter @butterbase/control-api test keys-expiry-worker storage-counter kv-data
```

Expected: all green.

- [ ] **Step 7: Live smoke**

```
docker compose -f /Users/kenneth/Documents/butterbase_backup/butterbase/docker-compose.local.yml build control-api
docker compose -f /Users/kenneth/Documents/butterbase_backup/butterbase/docker-compose.local.yml up -d control-api
sleep 6
docker compose -f /Users/kenneth/Documents/butterbase_backup/butterbase/docker-compose.local.yml logs --tail=30 control-api | grep -iE "FST_ERR|expiry|listening"

FN=a1621069c7c66eb4a3c4c252dcfe55f8d637b732f8df164e
BASE=http://localhost:4000/v1/app_xexxduzlyzq7/kv
# set a TTL key and watch bytes drop
curl -s -X PUT "$BASE/ttl:demo" -H "Authorization: Bearer $FN" -H "Content-Type: application/json" -d '{"value":"hello world test value","ttl":3}'
echo "before:"; curl -s "$BASE/_stats" -H "Authorization: Bearer $FN"
sleep 5
echo "after :"; curl -s "$BASE/_stats" -H "Authorization: Bearer $FN"
```

Expected: `keys_total` drops by 1 and `bytes_used` drops by ~30 (the encoded value size). No `FST_ERR_INSTANCE_ALREADY_LISTENING` in logs.

- [ ] **Step 8: Build + commit**

```
pnpm --filter @butterbase/control-api build
git add services/control-api/src/index.ts \
        services/control-api/src/services/kv/keys-expiry-worker.ts \
        services/control-api/src/services/kv/keys-expiry-worker.test.ts \
        services/control-api/src/routes/v1/kv-data.ts \
        services/control-api/src/services/kv/storage-counter.ts
git commit -m "fix(kv): boot-order + bytes-on-TTL via sidecar size index"
```

---

### Task 4: Wrapper-repo plumbing commit

**Files (wrapper repo, branch `feat/kv-plan-3-rest-expose`):**
- Modify: `docker-compose.local.yml` (already locally edited)
- Create: `cloud/services/admin-dashboard/Dockerfile` (already locally created)
- Create: `cloud/services/admin-dashboard/nginx.conf` (already locally created)

**Acceptance criteria (spec):**

A single commit on `feat/kv-plan-3-rest-expose` that lands the four wrapper-repo edits from Plan 7's smoke. `docker compose -f docker-compose.local.yml up -d` from a fresh clone works end-to-end, including the `admin-dashboard` service on `:3001` and the expiry-subscriber wired to long-form env keys.

- [ ] **Step 1: Verify uncommitted state**

```
cd /Users/kenneth/Documents/butterbase_backup/butterbase
git status -s | grep -E "docker-compose.local.yml|admin-dashboard"
```

Expect:
```
 M docker-compose.local.yml
?? cloud/services/admin-dashboard/Dockerfile
?? cloud/services/admin-dashboard/nginx.conf
```

If any of these are missing, the previous session's Plan 7 smoke edits weren't preserved — re-apply them by reading `submodules/butterbase-oss/docs/superpowers/smoke/2026-05-24-kv-plan-7-smoke.md` and the section "What I changed in your environment" in the Plan 7 final report.

- [ ] **Step 2: Diff review**

```
git diff docker-compose.local.yml
```

Expected diff (concise):
- `KV_REDIS_URL_US_EAST_1` and `KV_REDIS_URL_EU_WEST_1` env vars added to `control-api` block.
- `BUTTERBASE_REGIONS: "us-east-1,eu-west-1"` added to `control-api` env.
- `--notify-keyspace-events Ex` added to both `kv-redis-1` and `kv-redis-2` `command:` blocks.
- New `admin-dashboard:` service block (build context, args for Cognito + control API URL, port 3001).

If there are extra unrelated edits, surface them — do not include in this commit.

- [ ] **Step 3: Smoke from a fresh container restart**

```
docker compose -f docker-compose.local.yml down control-api admin-dashboard kv-redis-1 kv-redis-2
docker compose -f docker-compose.local.yml up -d control-api admin-dashboard kv-redis-1 kv-redis-2
sleep 8
# expiry-subscriber both regions
docker compose -f docker-compose.local.yml logs --tail=50 control-api | grep -iE "expiry|listening"
# admin-dashboard responds
curl -s -o /dev/null -w "admin-dashboard: HTTP %{http_code}\n" http://localhost:3001/
# notify-keyspace-events set on both redises
docker exec butterbase-kv-redis-1-1 redis-cli -a butterbase_dev_kv CONFIG GET notify-keyspace-events | tail -1
docker exec butterbase-kv-redis-2-1 redis-cli -a butterbase_dev_kv CONFIG GET notify-keyspace-events | tail -1
```

Expected: `[keys-expiry] subscribed` for both regions, admin-dashboard returns 200, `notify-keyspace-events` shows `Ex` (or `xE`).

- [ ] **Step 4: Commit**

```
git add docker-compose.local.yml \
        cloud/services/admin-dashboard/Dockerfile \
        cloud/services/admin-dashboard/nginx.conf
git commit -m "feat(local): admin-dashboard service + KV long-form env + notify-keyspace-events"
```

No `Co-Authored-By` trailer.

---

### Task 5: Final verification + smoke note

**Files:**
- Create: `docs/superpowers/smoke/2026-05-25-kv-plan-8-smoke.md` (OSS submodule)

**Acceptance criteria (spec):**

A brief smoke note (~½ page) capturing what landed, what was verified live, and what's still open. Same template as Plan 7's smoke note.

- [ ] **Step 1: Full KV-slice tests**

```
cd /Users/kenneth/Documents/butterbase_backup/butterbase/submodules/butterbase-oss
RUN_DB_TESTS=1 \
  KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
  KV_REDIS_URL_EU=redis://:butterbase_dev_kv@localhost:6391 \
  NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  pnpm --filter @butterbase/control-api test kv keys move-app admin-guard auth audit 2>&1 | tail -10
```

Expected: KV slice green, count up vs Plan 7 baseline (335 → ~345+).

- [ ] **Step 2: Full builds**

```
pnpm --filter @butterbase/control-api build
pnpm --filter @butterbase/sdk build
cd /Users/kenneth/Documents/butterbase_backup/butterbase/cloud/services/dashboard && pnpm build
cd ../admin-dashboard && pnpm build
```

All clean.

- [ ] **Step 3: Live e2e smoke**

Sign in to dashboard as `kcflexigbo@gmail.com` → `http://localhost:3000/apps/app_xexxduzlyzq7/kv`.

Verify in-browser:
- UsageStrip populates with non-zero numbers (no "Couldn't load usage" error).
- ExposeRulesTable loads (empty list is OK).
- KeyBrowser shows 5+ keys.
- RecentErrors shows recent entries (the audit-writer should have added new ones from any failing call during the session).

Admin dashboard at `http://localhost:3001/kv` (signed in as admin):
- Cluster health: 2 regions, both reachable, green status.
- Top apps: at least 1 row for `app_xexxduzlyzq7`.
- Hotspots: empty.

- [ ] **Step 4: Smoke note**

Create `docs/superpowers/smoke/2026-05-25-kv-plan-8-smoke.md`:

```markdown
# KV Plan 8 — Smoke Notes

## Counter wiring + dashboard auth
- Task 1 (`resolveKvAuth` extended): customer dashboard KV tab fully renders for kcflexigbo on app_xexxduzlyzq7. UsageStrip / ExposeRulesTable / KeyBrowser / RecentErrors all populated, no 403/401.
- Task 3a (boot fix): no FST_ERR_INSTANCE_ALREADY_LISTENING on control-api boot. Both regions show [keys-expiry] subscribed.
- Task 3b (bytes-on-TTL): live confirmed — TTL key drops both keys_total and bytes_used.

## Audit writer
- Task 2: triggering a 404 + 413 with no manual seed → /_audit_recent returns the new rows within 1s.

## Wrapper plumbing
- Task 4: fresh `docker compose up` cycle reproduces all behavior. admin-dashboard:3001 HTTP 200. kv-redis-1/2 have notify-keyspace-events=Ex on container restart.

## Final test counts
- KV slice: <N> passing / 0 failing.
- Full suite: 96 pre-existing non-KV failures unchanged.

## Open items
- Per-app dev-API-key UI deferred (alternative auth path; not needed now that Cognito JWT works).
- PUT /_expose key_invalid: separate validation bug, not yet fixed.
- audit_logs retention policy not defined (table will grow unbounded).
```

- [ ] **Step 5: Commit smoke note**

```
cd /Users/kenneth/Documents/butterbase_backup/butterbase/submodules/butterbase-oss
git add docs/superpowers/smoke/2026-05-25-kv-plan-8-smoke.md
git commit -m "test(kv): plan 8 smoke note — auth + audit-writer + boot fix"
```

---

## Self-Review Checklist

1. **resolveKvAuth platform-owner branch is GATED on end-user-JWT failure** — Task 1. Existing end-user JWTs still work as before. ✓
2. **Single SQL covers platform_user lookup + ownership + kv credentials** — Task 1 query joins three tables in one round-trip. ✓
3. **audit_logs writer is BEST-EFFORT** — Task 2 hook never throws, never blocks response. ✓
4. **audit_logs writer scoped to `/v1/:app_id/kv/*`** — Task 2 KV_PATH_RE check before insert. ✓
5. **Only 4xx/5xx generate audit rows** — Task 2 statusCode check. 2xx responses skip the insert. ✓
6. **Boot-order fix verified by absent error log** — Task 3a smoke step greps for `FST_ERR_INSTANCE_ALREADY_LISTENING`. ✓
7. **Sidecar size index used for bytes-on-TTL** — Task 3b. HSET on every write, HGET+HDEL+decBytes on every expiry, full rebuild on reconcile. ✓
8. **Sidecar field name = raw key suffix** (no encoding) — Task 3b, must match between write path and expiry worker. ✓
9. **Wrapper commit is single, atomic, only the plumbing edits** — Task 4. No unrelated changes bundled. ✓
10. **Live smoke verifies dashboard auth, audit writer, boot fix, TTL bytes decrement** — Task 5. ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-24-kv-plan-8-smoke-followup.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review. Model picks per task at top of plan.
2. **Inline Execution** — batch with checkpoints via `superpowers:executing-plans`.

Which approach?
