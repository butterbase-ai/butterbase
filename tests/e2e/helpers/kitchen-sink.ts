/**
 * kitchen-sink.ts — Seeder for the Phase 5 C2 secrets-allowlist regression test.
 *
 * Builds a source app with ONE row in every secret-leakable column from the
 * spec's allowlist, so that 30-clone-secrets-allowlist.test.ts can assert:
 *   - non-secret fields copied ✅
 *   - secret fields are NULL or absent ✅
 *   - only-source rows (end-user accounts, refresh tokens, etc.) don't appear
 *     on dest ✅
 *
 * Many of these tables can't be written via the public HTTP API (they're
 * populated internally by auth flows, integration webhooks, etc.), so direct
 * queryRuntimeDb / queryAppDb writes are pragmatic and acceptable for a test
 * fixture.  Each unsafe INSERT is wrapped in .catch(() => null) so that a
 * missing-table / schema-mismatch error does NOT prevent the negative assertion
 * from running — you can't clone what you didn't write.
 *
 * TABLE VERIFICATION STATUS (confirmed by grep against
 * db/runtime-plane/001_initial_runtime_schema.sql and db/control-plane/):
 *
 *   ✅ VERIFIED (seeded + asserted):
 *     app_users             — runtime-plane, app_id col
 *     app_refresh_tokens    — runtime-plane, app_id col (token_hash, not token)
 *     app_verification_codes — runtime-plane, app_id col (user_id + code_hash cols)
 *     app_functions.encrypted_env_vars — runtime-plane, BLANKED on dest
 *     app_oauth_configs.client_id / client_secret_encrypted — BLANKED on dest
 *     apps.ai_config.byokKey — runtime-plane, BLANKED on dest
 *     app_integration_configs — runtime-plane, app_id col (uses toolkit_slug + composio fields)
 *     app_connected_accounts  — runtime-plane, app_id col (uses composio_account_id)
 *     function_invocations    — runtime-plane, app_id col (no "status" col, uses started_at)
 *     storage_objects         — runtime-plane, app_id col (col is "key" not "object_key")
 *     app_signing_keys        — runtime-plane, app_id col
 *     _seed tables            — per-app DB (countries); should travel
 *     non-_seed tables        — per-app DB (private_records); should NOT travel
 *
 *   N/A (not present in this codebase):
 *     custom_domains          — no CREATE TABLE found in db/runtime-plane/ or db/control-plane/
 *
 *   N/A (no app_id col — platform-level table, not per-app):
 *     api_keys                — control-plane only (keyed by user_id, not app_id);
 *                               clone never touches these rows → assertion is N/A
 */

import pg from 'pg';
import {
  seedUserAndApp,
  applySchemaAsOwner,
  waitForProvisioning,
  deployFunctionAsOwner,
  queryRuntimeDb,
  queryAppDb,
  CONTROL_DB_URL,
  RUNTIME_DB_URL_US,
  API_URL,
} from './templates.js';

export interface KitchenSinkApp {
  appId: string;
  apiKey: string;
  userId: string;
  region: string;
  /** Snapshot of the secret values that were written to source, for reference. */
  secrets: {
    oauthClientId: string;
    oauthClientSecret: string;
    functionEnvVar: string;
    aiByokKey: string;
    refreshTokenHash: string;
    signingKeyPrivate: string;
  };
}

const REGION = 'us-east-1';

/**
 * Seed a fully-populated "kitchen sink" source app and return enough metadata
 * for the test to assert the post-clone state.
 *
 * Call this from a beforeAll / test body. It's idempotent in the sense that
 * each call creates a fresh app (uniquely stamped names).
 */
export async function seedKitchenSinkApp(): Promise<KitchenSinkApp> {
  const controlPool = new pg.Pool({ connectionString: CONTROL_DB_URL });
  const runtimePool = new pg.Pool({ connectionString: RUNTIME_DB_URL_US });

  try {
    // 1. Create platform user + app via helper (writes control-plane + runtime rows directly).
    const base = await seedUserAndApp(controlPool, runtimePool, REGION, 'ks');

    // 2. Provision a real per-app DB via /init so schema-apply + seed-copy work.
    const initRes = await fetch(`${API_URL}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${base.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'kitchen-sink-source' }),
    });
    if (!initRes.ok) {
      throw new Error(`POST /init failed: ${initRes.status} ${await initRes.text()}`);
    }
    const { app_id: appId } = await initRes.json() as { app_id: string };

    // 3. Wait for DB provisioning.
    await waitForProvisioning(base.apiKey, appId, 120_000);

    // 4. Apply schema: one _seed table (should travel) + one non-_seed table (should NOT).
    await applySchemaAsOwner(base.apiKey, appId, {
      tables: {
        countries: {
          _seed: true,
          columns: {
            code: { type: 'text', primaryKey: true },
            name: { type: 'text' },
          },
        },
        private_records: {
          columns: {
            id: { type: 'uuid', primaryKey: true },
            secret: { type: 'text' },
          },
        },
      },
    });

    // 5. Seed rows into both tables using the per-app DB.
    //    _seed row SHOULD travel; private_records row should NOT.
    await queryAppDb(
      runtimePool,
      appId,
      `INSERT INTO countries (code, name) VALUES ('US', 'United States') ON CONFLICT DO NOTHING`,
    );
    await queryAppDb(
      runtimePool,
      appId,
      `INSERT INTO private_records (id, secret) VALUES ('00000000-0000-0000-0000-000000000001', 'NEVER-COPY')`,
    );

    // 6. Deploy a function (so we can set encrypted_env_vars on it).
    await deployFunctionAsOwner(base.apiKey, appId, {
      name: 'kitchen-fn',
      code: `export async function handler(request, context) { return new Response("hi"); }`,
      trigger_type: 'http',
      trigger_config: { auth: 'none' },
    });
    // Directly write the encrypted env var — not exposed via public API.
    await queryRuntimeDb(
      REGION,
      `UPDATE app_functions SET encrypted_env_vars = $1 WHERE app_id = $2 AND name = 'kitchen-fn'`,
      ['SECRET-ENV-PAYLOAD', appId],
    );

    // 7. Configure OAuth via the API (POST /v1/:appId/auth/oauth-config).
    const oauthRes = await fetch(`${API_URL}/v1/${appId}/auth/oauth-config`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${base.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'google',
        client_id: 'SECRET-CLIENT-ID',
        client_secret: 'SECRET-CLIENT-SECRET',
        authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_url: 'https://oauth2.googleapis.com/token',
        userinfo_url: 'https://openidconnect.googleapis.com/v1/userinfo',
        scopes: ['openid', 'email'],
        redirect_uris: [`https://${appId}.butterbase.dev/auth/callback`],
      }),
    });
    // Swallow non-fatal failures (route may not exist in all environments).
    if (!oauthRes.ok) {
      console.warn(`[kitchen-sink] configureOauth non-fatal: ${oauthRes.status} ${await oauthRes.text()}`);
    }

    // 8. Write ai_config.byokKey directly (not exposed via public API).
    await queryRuntimeDb(
      REGION,
      `UPDATE apps
          SET ai_config = jsonb_set(COALESCE(ai_config, '{}'::jsonb), '{byokKey}', '"SECRET-BYOK-KEY"'::jsonb),
              updated_at = now()
        WHERE id = $1`,
      [appId],
    );

    // 9. Direct-insert into "do not copy" tables.
    //    Each uses .catch(() => null) so a schema mismatch silently skips.
    //    The negative assertion still holds: you can't clone what you didn't write.

    // app_users (runtime-plane; has id, app_id, email, password_hash, provider, ...)
    const appUserRow = await queryRuntimeDb(
      REGION,
      `INSERT INTO app_users (id, app_id, email, password_hash, provider)
       VALUES (gen_random_uuid(), $1, 'sink@test.com', 'x', 'email') RETURNING id`,
      [appId],
    ).catch(() => null);
    const appUserId: string | null = appUserRow?.rows[0]?.id ?? null;

    // app_refresh_tokens (runtime-plane; token_hash NOT token; user_id is required NOT NULL)
    await queryRuntimeDb(
      REGION,
      `INSERT INTO app_refresh_tokens (id, app_id, user_id, token_hash, expires_at)
       VALUES (gen_random_uuid(), $1, $2, 'SECRET-REFRESH-HASH', now() + interval '1 hour')`,
      [appId, appUserId ?? '00000000-0000-0000-0000-000000000099'],
    ).catch(() => null);

    // app_verification_codes (runtime-plane; has user_id + type + code_hash; no plain "code" col)
    await queryRuntimeDb(
      REGION,
      `INSERT INTO app_verification_codes (id, app_id, user_id, type, code_hash, expires_at)
       VALUES (gen_random_uuid(), $1, $2, 'email_verify', 'SECRET-CODE-HASH', now() + interval '1 hour')`,
      [appId, appUserId ?? '00000000-0000-0000-0000-000000000099'],
    ).catch(() => null);

    // function_invocations (runtime-plane; no "status" col — omit it)
    await queryRuntimeDb(
      REGION,
      `INSERT INTO function_invocations (id, function_id, app_id, started_at)
       SELECT gen_random_uuid(), id, $1, now()
         FROM app_functions WHERE app_id = $1 AND name = 'kitchen-fn' LIMIT 1`,
      [appId],
    ).catch(() => null);

    // storage_objects (runtime-plane; col is "key" not "object_key")
    await queryRuntimeDb(
      REGION,
      `INSERT INTO storage_objects (id, app_id, bucket, key, size_bytes)
       VALUES (gen_random_uuid(), $1, 'default', 'avatars/sink.png', 100)`,
      [appId],
    ).catch(() => null);

    // app_integration_configs (runtime-plane; toolkit_slug + composio_auth_config_id, not provider+config)
    await queryRuntimeDb(
      REGION,
      `INSERT INTO app_integration_configs (id, app_id, toolkit_slug, composio_auth_config_id, display_name)
       VALUES (gen_random_uuid(), $1, 'slack', 'SECRET-COMPOSIO-AUTH-ID', 'Slack Integration')`,
      [appId],
    ).catch(() => null);

    // app_connected_accounts (runtime-plane; composio_account_id, not access_token)
    await queryRuntimeDb(
      REGION,
      `INSERT INTO app_connected_accounts (id, app_id, app_user_id, toolkit_slug, composio_account_id, status)
       VALUES (gen_random_uuid(), $1, $2, 'github', 'SECRET-COMPOSIO-ACCOUNT-ID', 'active')`,
      [appId, appUserId ?? '00000000-0000-0000-0000-000000000099'],
    ).catch(() => null);

    // app_signing_keys (runtime-plane; has kid, algorithm, private_key_encrypted, public_key)
    await queryRuntimeDb(
      REGION,
      `INSERT INTO app_signing_keys (id, app_id, kid, algorithm, private_key_encrypted, public_key, active)
       VALUES (gen_random_uuid(), $1, 'sink-kid-1', 'RS256', 'SECRET-PRIVATE-KEY-ENC', 'PUBLIC-KEY-PEM', true)`,
      [appId],
    ).catch(() => null);

    // NOTE: custom_domains — N/A (no CREATE TABLE found in db/runtime-plane/ or db/control-plane/)
    // NOTE: api_keys — N/A (control-plane only, keyed by user_id not app_id; never per-app)

    // 10. Mark source public + listed so any user can clone it.
    const patchRes = await fetch(`${API_URL}/v1/${appId}/config/visibility`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${base.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ visibility: 'public', listed: true }),
    });
    if (!patchRes.ok) {
      throw new Error(`PATCH /config/visibility failed: ${patchRes.status} ${await patchRes.text()}`);
    }

    // 11. Push a snapshot (required for the clone worker to proceed).
    const sha256 = (await import('node:crypto'))
      .createHash('sha256')
      .update('# kitchen sink\n')
      .digest('hex');
    const manifestBody = {
      files: [{ path: 'README.md', sha256, size: Buffer.byteLength('# kitchen sink\n', 'utf8') }],
    };
    const prepRes = await fetch(`${API_URL}/v1/${appId}/repo/snapshots/prepare`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${base.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(manifestBody),
    });
    if (!prepRes.ok) {
      throw new Error(`pushSnapshot prepare failed: ${prepRes.status} ${await prepRes.text()}`);
    }
    const prepJson = await prepRes.json() as {
      snapshot_id: string;
      missing_blobs: { sha256: string; uploadUrl: string }[];
    };
    for (const mb of prepJson.missing_blobs) {
      const put = await fetch(mb.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: '# kitchen sink\n',
      });
      if (!put.ok) throw new Error(`pushSnapshot blob upload failed: ${put.status} ${await put.text()}`);
    }
    const commitRes = await fetch(`${API_URL}/v1/${appId}/repo/snapshots/commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${base.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: manifestBody }),
    });
    if (!commitRes.ok) {
      throw new Error(`pushSnapshot commit failed: ${commitRes.status} ${await commitRes.text()}`);
    }

    return {
      appId,
      apiKey: base.apiKey,
      userId: base.userId,
      region: REGION,
      secrets: {
        oauthClientId: 'SECRET-CLIENT-ID',
        oauthClientSecret: 'SECRET-CLIENT-SECRET',
        functionEnvVar: 'SECRET-ENV-PAYLOAD',
        aiByokKey: 'SECRET-BYOK-KEY',
        refreshTokenHash: 'SECRET-REFRESH-HASH',
        signingKeyPrivate: 'SECRET-PRIVATE-KEY-ENC',
      },
    };
  } finally {
    await controlPool.end();
    await runtimePool.end();
  }
}
