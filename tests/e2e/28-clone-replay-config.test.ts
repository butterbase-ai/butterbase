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
