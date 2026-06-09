/**
 * E2E — Phase 5 / Task A5: clone worker replays non-secret config onto dest.
 *
 * Two subsystems are exercised explicitly here:
 *   ✓ app_oauth_configs — provider/URL/scopes copy; client_id + client_secret_encrypted BLANKED
 *   ✓ allowed_origins   — text[] column on apps copies verbatim
 *
 * The remaining four (storage_config, jwt_config, ai_config byokKey blanking,
 * app_realtime_config) are covered by the C2 kitchen-sink clone test which
 * seeds all subsystems end-to-end. They are NOT explicitly tested here.
 *
 * Drives control-api at http://localhost:4000.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

import {
  CONTROL_DB_URL,
  RUNTIME_DB_URL_US,
  seedUserAndApp,
  waitForCloneStep,
  waitForProvisioning,
  pushSnapshot,
  queryRuntimeDb,
  deployFunctionAsOwner,
} from './helpers/templates.js';

const API_URL = 'http://localhost:4000';

let controlPool: pg.Pool;
let runtimePool: pg.Pool;

beforeAll(async () => {
  controlPool = new pg.Pool({ connectionString: CONTROL_DB_URL });
  runtimePool = new pg.Pool({ connectionString: RUNTIME_DB_URL_US });

  const health = await fetch(`${API_URL}/health`);
  if (!health.ok) {
    throw new Error(`control-api /health unreachable at ${API_URL} — status ${health.status}`);
  }
  const probe = await fetch(`${API_URL}/v1/clone-jobs/cj_doesnotexist`, {
    headers: { Authorization: 'Bearer bb_sk_invalid' },
  });
  if (probe.status !== 401 && probe.status !== 404) {
    throw new Error(`/v1/clone-jobs/:id probe returned unexpected ${probe.status}`);
  }
}, 30_000);

afterAll(async () => {
  await controlPool?.end();
  await runtimePool?.end();
}, 30_000);

// ---------------------------------------------------------------------------
// Helper: configure OAuth on a source app via the API
// ---------------------------------------------------------------------------

async function configureOauthAsOwner(
  apiKey: string,
  appId: string,
  opts: {
    provider: string;
    client_id: string;
    client_secret: string;
    authorization_url: string;
    token_url: string;
    userinfo_url: string;
    scopes: string[];
    redirect_uris?: string[];
  },
): Promise<void> {
  const res = await fetch(`${API_URL}/v1/${appId}/auth/oauth-config`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      provider: opts.provider,
      client_id: opts.client_id,
      client_secret: opts.client_secret,
      authorization_url: opts.authorization_url,
      token_url: opts.token_url,
      userinfo_url: opts.userinfo_url,
      scopes: opts.scopes,
      redirect_uris: opts.redirect_uris ?? [`https://${appId}.butterbase.dev/auth/callback`],
    }),
  });
  if (!res.ok) {
    throw new Error(`configureOauthAsOwner failed: ${res.status} ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Helper: set allowed_origins on a source app — direct DB write is pragmatic
// because PATCH /v1/:app_id/config/cors validates URLs strictly.
// ---------------------------------------------------------------------------

async function setAllowedOriginsAsOwner(
  appId: string,
  origins: string[],
): Promise<void> {
  await queryRuntimeDb(
    'us-east-1',
    `UPDATE apps SET allowed_origins = $1, updated_at = now() WHERE id = $2`,
    [origins, appId],
  );
}

// ---------------------------------------------------------------------------

describe('Phase 5 A5 — non-secret config replays; secrets blanked', () => {
  it('OAuth provider/URLs copy; client_id + client_secret_encrypted blanked', async () => {
    // 1. Create source app via the real init route (provisions an actual DB).
    const sourceOwner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'cfgreplay-oauth');

    const sourceInitRes = await fetch(`${API_URL}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'cfg-oauth-source' }),
    });
    if (!sourceInitRes.ok) {
      throw new Error(`POST /init failed: ${sourceInitRes.status} ${await sourceInitRes.text()}`);
    }
    const { app_id: sourceAppId } = await sourceInitRes.json() as { app_id: string };

    // 2. Wait for provisioning.
    await waitForProvisioning(sourceOwner.apiKey, sourceAppId, 120_000);

    // 3. Configure an OAuth provider on the source.
    await configureOauthAsOwner(sourceOwner.apiKey, sourceAppId, {
      provider: 'google',
      client_id: 'src-client-id',
      client_secret: 'src-super-secret',
      authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_url: 'https://oauth2.googleapis.com/token',
      userinfo_url: 'https://openidconnect.googleapis.com/v1/userinfo',
      scopes: ['openid', 'email'],
    });

    // 4. Mark source public+listed (required for clone).
    const patchRes = await fetch(`${API_URL}/v1/${sourceAppId}/config/visibility`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ visibility: 'public', listed: true }),
    });
    expect(patchRes.status, await patchRes.clone().text()).toBe(200);

    // 5. Push a snapshot (required for clone to proceed).
    await pushSnapshot(sourceOwner.apiKey, sourceAppId, '# cfg-oauth source\n');

    // 6. Create a cloner user + start clone.
    const cloner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'cfgreplay-cln');
    const cloneRes = await fetch(`${API_URL}/v1/templates/${sourceAppId}/clone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'replica-cfg' }),
    });
    expect(cloneRes.status, await cloneRes.clone().text()).toBe(200);
    const { job_id } = await cloneRes.json() as { job_id: string };

    // 7. Wait for completed / failed.
    const final = await waitForCloneStep(cloner.apiKey, job_id, ['completed', 'failed'], 180_000);
    expect(
      final.status,
      `Clone job ended with unexpected status: ${JSON.stringify(final)}`,
    ).toBe('completed');

    const destAppId = final.dest_app_id!;

    // 8. Assert OAuth row on dest: provider + URLs present; secrets blanked.
    const destOauth = await queryRuntimeDb(
      'us-east-1',
      `SELECT provider, authorization_url, token_url, scopes, client_id, client_secret_encrypted
         FROM app_oauth_configs
        WHERE app_id = $1`,
      [destAppId],
    );

    expect(destOauth.rows.length).toBe(1);
    const row = destOauth.rows[0];
    expect(row.provider).toBe('google');
    expect(row.authorization_url).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(row.token_url).toBe('https://oauth2.googleapis.com/token');
    expect(row.scopes).toContain('openid');
    // Secrets must be NULL (blanked by allowlist policy).
    expect(row.client_id, 'client_id should be NULL on cloned oauth config').toBeNull();
    expect(
      row.client_secret_encrypted,
      'client_secret_encrypted should be NULL on cloned oauth config',
    ).toBeNull();
  }, 240_000);

  it('replays app_integration_configs onto the dest (or warns if Composio unavailable)', async () => {
    // 1. Create source app.
    const sourceOwner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'cfgreplay-intcfg');

    const sourceInitRes = await fetch(`${API_URL}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'cfg-intcfg-source' }),
    });
    if (!sourceInitRes.ok) {
      throw new Error(`POST /init failed: ${sourceInitRes.status} ${await sourceInitRes.text()}`);
    }
    const { app_id: sourceAppId } = await sourceInitRes.json() as { app_id: string };

    // 2. Wait for provisioning.
    await waitForProvisioning(sourceOwner.apiKey, sourceAppId, 120_000);

    // 3. Seed an app_integration_configs row on the source via direct DB write.
    await queryRuntimeDb(
      'us-east-1',
      `INSERT INTO app_integration_configs
         (app_id, toolkit_slug, composio_auth_config_id, display_name, enabled, scopes)
       VALUES ($1, 'gmail', 'ac_src_should_not_appear_on_dest', 'Source Gmail', true, '["gmail.read"]'::jsonb)
       ON CONFLICT DO NOTHING`,
      [sourceAppId],
    );

    // 4. Mark source public+listed.
    const patchRes = await fetch(`${API_URL}/v1/${sourceAppId}/config/visibility`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ visibility: 'public', listed: true }),
    });
    expect(patchRes.status, await patchRes.clone().text()).toBe(200);

    // 5. Push snapshot.
    await pushSnapshot(sourceOwner.apiKey, sourceAppId, '# cfg-intcfg source\n');

    // 6. Create a cloner user + start clone.
    const cloner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'cfgreplay-icln');
    const cloneRes = await fetch(`${API_URL}/v1/templates/${sourceAppId}/clone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'replica-intcfg' }),
    });
    expect(cloneRes.status, await cloneRes.clone().text()).toBe(200);
    const { job_id } = await cloneRes.json() as { job_id: string };

    // 7. Wait for completed / failed.
    const final = await waitForCloneStep(cloner.apiKey, job_id, ['completed', 'failed'], 180_000);
    expect(
      final.status,
      `Clone job ended with unexpected status: ${JSON.stringify(final)}`,
    ).toBe('completed');

    const destAppId = final.dest_app_id!;

    // 8. Read the dest's app_integration_configs row for toolkit_slug = 'gmail'.
    const destIntcfg = await queryRuntimeDb(
      'us-east-1',
      `SELECT toolkit_slug, composio_auth_config_id, display_name, enabled
         FROM app_integration_configs
        WHERE app_id = $1 AND toolkit_slug = 'gmail'`,
      [destAppId],
    );

    if (destIntcfg.rows.length === 0) {
      // Composio was unavailable in this e2e env — a warning must have been recorded.
      const jobRow = await controlPool.query(
        `SELECT warnings FROM template_clone_jobs WHERE id = $1`,
        [job_id],
      );
      const warnings: string[] = jobRow.rows[0]?.warnings ?? [];
      const integrationWarning = warnings.find((w: string) => /integration/i.test(w));
      expect(
        integrationWarning,
        `Expected a warning matching /integration/i when no dest row was written, got: ${JSON.stringify(warnings)}`,
      ).toBeTruthy();
    } else {
      // Composio was available — row must have been replayed with a fresh auth config id.
      const row = destIntcfg.rows[0];
      expect(row.enabled).toBe(true);
      expect(row.display_name).toBe('Source Gmail');
      expect(
        row.composio_auth_config_id,
        'composio_auth_config_id must not carry over the source value',
      ).not.toBe('ac_src_should_not_appear_on_dest');
      expect(
        row.composio_auth_config_id,
        'composio_auth_config_id must not be empty on replayed row',
      ).toBeTruthy();
    }
  }, 240_000);

  it('allowed_origins copies verbatim', async () => {
    // 1. Create source app.
    const sourceOwner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'cfgreplay-origins');

    const sourceInitRes = await fetch(`${API_URL}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'cfg-origins-source' }),
    });
    if (!sourceInitRes.ok) {
      throw new Error(`POST /init failed: ${sourceInitRes.status} ${await sourceInitRes.text()}`);
    }
    const { app_id: sourceAppId } = await sourceInitRes.json() as { app_id: string };

    // 2. Wait for provisioning.
    await waitForProvisioning(sourceOwner.apiKey, sourceAppId, 120_000);

    // 3. Set allowed_origins on the source via direct DB write (pragmatic — the
    //    PATCH /config/cors route validates URLs and rejects non-https in tests).
    await setAllowedOriginsAsOwner(sourceAppId, [
      'https://example.com',
      'https://staging.example.com',
    ]);

    // 4. Mark source public+listed.
    const patchRes = await fetch(`${API_URL}/v1/${sourceAppId}/config/visibility`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ visibility: 'public', listed: true }),
    });
    expect(patchRes.status, await patchRes.clone().text()).toBe(200);

    // 5. Push snapshot.
    await pushSnapshot(sourceOwner.apiKey, sourceAppId, '# cfg-origins source\n');

    // 6. Clone.
    const cloner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'cfgreplay-ocln');
    const cloneRes = await fetch(`${API_URL}/v1/templates/${sourceAppId}/clone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'replica-origins' }),
    });
    expect(cloneRes.status, await cloneRes.clone().text()).toBe(200);
    const { job_id } = await cloneRes.json() as { job_id: string };

    // 7. Wait.
    const final = await waitForCloneStep(cloner.apiKey, job_id, ['completed', 'failed'], 180_000);
    expect(
      final.status,
      `Clone job ended with unexpected status: ${JSON.stringify(final)}`,
    ).toBe('completed');

    const destAppId = final.dest_app_id!;

    // 8. Assert allowed_origins on dest matches source.
    const dest = await queryRuntimeDb(
      'us-east-1',
      `SELECT allowed_origins FROM apps WHERE id = $1`,
      [destAppId],
    );
    expect(dest.rows.length).toBe(1);
    expect(dest.rows[0].allowed_origins).toEqual(
      expect.arrayContaining(['https://example.com', 'https://staging.example.com']),
    );
    expect(dest.rows[0].allowed_origins).toHaveLength(2);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// Helper: set auth_hook_function on an app via the API
// ---------------------------------------------------------------------------

async function setAuthHookAsOwner(
  apiKey: string,
  appId: string,
  functionName: string | null,
): Promise<void> {
  const res = await fetch(`${API_URL}/v1/${appId}/config/auth-hooks`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ post_auth_function: functionName }),
  });
  if (!res.ok) {
    throw new Error(`setAuthHookAsOwner failed: ${res.status} ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------

describe('Phase 5 A6 — auth_hook_function binding replay', () => {
  it('auth_hook_function copies to dest when referenced function was replicated', async () => {
    // 1. Create source app.
    const sourceOwner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'authhook-src');

    const sourceInitRes = await fetch(`${API_URL}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'authhook-source' }),
    });
    if (!sourceInitRes.ok) {
      throw new Error(`POST /init failed: ${sourceInitRes.status} ${await sourceInitRes.text()}`);
    }
    const { app_id: sourceAppId } = await sourceInitRes.json() as { app_id: string };

    // 2. Wait for provisioning.
    await waitForProvisioning(sourceOwner.apiKey, sourceAppId, 120_000);

    // 3. Deploy a function that will be used as the auth hook.
    const fnCode = `export async function handler(request, context) { return new Response("auth hook ok"); }`;
    await deployFunctionAsOwner(sourceOwner.apiKey, sourceAppId, {
      name: 'my-auth-hook',
      code: fnCode,
      trigger_type: 'http',
      trigger_config: { auth: 'none' },
    });

    // 4. Set auth_hook_function via the API (requires the function to exist).
    await setAuthHookAsOwner(sourceOwner.apiKey, sourceAppId, 'my-auth-hook');

    // 5. Mark source public+listed.
    const patchRes = await fetch(`${API_URL}/v1/${sourceAppId}/config/visibility`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ visibility: 'public', listed: true }),
    });
    expect(patchRes.status, await patchRes.clone().text()).toBe(200);

    // 6. Push snapshot.
    await pushSnapshot(sourceOwner.apiKey, sourceAppId, '# authhook source\n');

    // 7. Clone.
    const cloner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'authhook-cln');
    const cloneRes = await fetch(`${API_URL}/v1/templates/${sourceAppId}/clone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'replica-authhook' }),
    });
    expect(cloneRes.status, await cloneRes.clone().text()).toBe(200);
    const { job_id } = await cloneRes.json() as { job_id: string };

    // 8. Wait for completed / failed.
    const final = await waitForCloneStep(cloner.apiKey, job_id, ['completed', 'failed'], 180_000);
    expect(
      final.status,
      `Clone job ended with unexpected status: ${JSON.stringify(final)}`,
    ).toBe('completed');

    const destAppId = final.dest_app_id!;

    // 9. Assert auth_hook_function on dest matches source.
    const dest = await queryRuntimeDb(
      'us-east-1',
      `SELECT auth_hook_function FROM apps WHERE id = $1`,
      [destAppId],
    );
    expect(dest.rows.length).toBe(1);
    expect(dest.rows[0].auth_hook_function).toBe('my-auth-hook');

    // 10. Confirm the function itself was also replicated.
    const fnOnDest = await queryRuntimeDb(
      'us-east-1',
      `SELECT name FROM app_functions WHERE app_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [destAppId, 'my-auth-hook'],
    );
    expect(fnOnDest.rows.length).toBe(1);
  }, 240_000);

  it('auth_hook_function left NULL and warning recorded when referenced function was not replicated', async () => {
    // 1. Create source app.
    const sourceOwner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'authhook-neg');

    const sourceInitRes = await fetch(`${API_URL}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'authhook-neg-source' }),
    });
    if (!sourceInitRes.ok) {
      throw new Error(`POST /init failed: ${sourceInitRes.status} ${await sourceInitRes.text()}`);
    }
    const { app_id: sourceAppId } = await sourceInitRes.json() as { app_id: string };

    // 2. Wait for provisioning.
    await waitForProvisioning(sourceOwner.apiKey, sourceAppId, 120_000);

    // 3. Deploy a function and set it as the auth hook.
    const fnCode = `export async function handler(request, context) { return new Response("ghost hook"); }`;
    await deployFunctionAsOwner(sourceOwner.apiKey, sourceAppId, {
      name: 'ghost-hook',
      code: fnCode,
      trigger_type: 'http',
      trigger_config: { auth: 'none' },
    });
    await setAuthHookAsOwner(sourceOwner.apiKey, sourceAppId, 'ghost-hook');

    // 4. Soft-delete the function on source so it won't be replicated (deleted_at set).
    await queryRuntimeDb(
      'us-east-1',
      `UPDATE app_functions SET deleted_at = now() WHERE app_id = $1 AND name = $2`,
      [sourceAppId, 'ghost-hook'],
    );

    // 5. Mark source public+listed.
    const patchRes = await fetch(`${API_URL}/v1/${sourceAppId}/config/visibility`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ visibility: 'public', listed: true }),
    });
    expect(patchRes.status, await patchRes.clone().text()).toBe(200);

    // 6. Push snapshot.
    await pushSnapshot(sourceOwner.apiKey, sourceAppId, '# authhook-neg source\n');

    // 7. Clone.
    const cloner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'authhook-ncln');
    const cloneRes = await fetch(`${API_URL}/v1/templates/${sourceAppId}/clone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'replica-authhook-neg' }),
    });
    expect(cloneRes.status, await cloneRes.clone().text()).toBe(200);
    const { job_id } = await cloneRes.json() as { job_id: string };

    // 8. Wait for completed.
    const final = await waitForCloneStep(cloner.apiKey, job_id, ['completed', 'failed'], 180_000);
    expect(
      final.status,
      `Clone job ended with unexpected status: ${JSON.stringify(final)}`,
    ).toBe('completed');

    const destAppId = final.dest_app_id!;

    // 9. auth_hook_function on dest must be NULL.
    const dest = await queryRuntimeDb(
      'us-east-1',
      `SELECT auth_hook_function FROM apps WHERE id = $1`,
      [destAppId],
    );
    expect(dest.rows.length).toBe(1);
    expect(
      dest.rows[0].auth_hook_function,
      'auth_hook_function should be NULL when referenced function was not replicated',
    ).toBeNull();

    // 10. A warning must be recorded in the clone job.
    const jobRow = await controlPool.query(
      `SELECT warnings FROM template_clone_jobs WHERE id = $1`,
      [job_id],
    );
    const warnings: string[] = jobRow.rows[0]?.warnings ?? [];
    const hookWarning = warnings.find((w: string) => w.includes('ghost-hook'));
    expect(
      hookWarning,
      `Expected a warning mentioning 'ghost-hook', got: ${JSON.stringify(warnings)}`,
    ).toBeTruthy();
  }, 240_000);

  it('replays substrate link binding (binds dest to cloner)', async () => {
    // 1. Create source app + wait for provisioning.
    const sourceOwner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'cfgreplay-subs');
    const sourceInitRes = await fetch(`${API_URL}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'cfg-subs-source' }),
    });
    expect(sourceInitRes.status, await sourceInitRes.clone().text()).toBe(200);
    const { app_id: sourceAppId } = await sourceInitRes.json() as { app_id: string };

    await waitForProvisioning(sourceOwner.apiKey, sourceAppId, 120_000);

    // 2. Manually link the source to its OWNER's substrate (simulating a dashboard click).
    await queryRuntimeDb(
      'us-east-1',
      `UPDATE apps SET substrate_user_id = $1 WHERE id = $2`,
      [sourceOwner.userId, sourceAppId],
    );

    // 3. Mark public + listed and push snapshot.
    const patchRes = await fetch(`${API_URL}/v1/${sourceAppId}/config/visibility`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ visibility: 'public', listed: true }),
    });
    expect(patchRes.status, await patchRes.clone().text()).toBe(200);
    await pushSnapshot(sourceOwner.apiKey, sourceAppId, '# cfg-subs source\n');

    // 4. Create a cloner user and start the clone.
    const cloner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'cfgreplay-subcln');
    const cloneRes = await fetch(`${API_URL}/v1/templates/${sourceAppId}/clone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'replica-subs' }),
    });
    expect(cloneRes.status, await cloneRes.clone().text()).toBe(200);
    const { job_id } = await cloneRes.json() as { job_id: string };

    const final = await waitForCloneStep(cloner.apiKey, job_id, ['completed', 'failed'], 180_000);
    expect(final.status).toBe('completed');
    const destAppId = final.dest_app_id!;

    // 5. Assert: dest's substrate_user_id = cloner's user id (NOT source owner's).
    const destRow = await queryRuntimeDb(
      'us-east-1',
      `SELECT substrate_user_id FROM apps WHERE id = $1`,
      [destAppId],
    );
    const destSubstrateUserId = (destRow.rows[0] as { substrate_user_id: string | null })?.substrate_user_id;
    expect(destSubstrateUserId, 'dest must be bound to cloner').toBe(cloner.userId);
    expect(destSubstrateUserId).not.toBe(sourceOwner.userId);
  }, 240_000);
});
