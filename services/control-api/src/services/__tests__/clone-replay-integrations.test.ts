import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { replayIntegrations } from '../clone-replay.js';
import { __setComposioClientForTest } from '../composio-client.js';
import { encrypt } from '../crypto.js';
import { config } from '../../config.js';
import { runtimeDb, controlDb } from '../../__tests__/test-helpers/control-db.js';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;
const noopLogger = { info() {}, warn() {} };

function fakeComposio(opts: { create?: (slug: string, args: unknown) => Promise<{ id: string }> } = {}) {
  let counter = 0;
  return {
    authConfigs: {
      create: opts.create ?? (async (_slug: string, _args: unknown) => {
        counter += 1;
        return { id: `ac_test_${counter}` };
      }),
    },
  } as any;
}

describeDb('replayIntegrations', () => {
  afterEach(() => __setComposioClientForTest(null));

  it('mints fresh composio auth configs for each enabled source row', async () => {
    const ownerId = randomUUID();
    await controlDb.query(
      `INSERT INTO platform_users (id, email, email_verified) VALUES ($1, $2, true) ON CONFLICT (id) DO NOTHING`,
      [ownerId, `int-${ownerId}@x.com`],
    );
    const srcId = `app_int_src_${ownerId.slice(0, 8)}`;
    const destId = `app_int_dst_${ownerId.slice(0, 8)}`;
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, $1, $2, $1, 'us-east-1')
         ON CONFLICT (id) DO NOTHING`,
        [id, ownerId],
      );
    }
    await runtimeDb.query(
      `INSERT INTO app_integration_configs (app_id, toolkit_slug, composio_auth_config_id, display_name, enabled, scopes)
       VALUES ($1, 'gmail',           'ac_src_gmail',    'Gmail',          true,  '["gmail.read"]'::jsonb),
              ($1, 'google-calendar', 'ac_src_calendar', 'Google Calendar', true,  '[]'::jsonb),
              ($1, 'slack',           'ac_src_slack',     NULL,             false, '[]'::jsonb)`,
      [srcId],
    );

    __setComposioClientForTest(fakeComposio());
    const warnings: string[] = [];
    await replayIntegrations(runtimeDb, runtimeDb, srcId, destId, warnings, noopLogger);
    expect(warnings).toEqual([]);

    const rows = await runtimeDb.query(
      `SELECT toolkit_slug, composio_auth_config_id, display_name, enabled, scopes
         FROM app_integration_configs WHERE app_id = $1 ORDER BY toolkit_slug`,
      [destId],
    );
    expect(rows.rows.map((r: any) => r.toolkit_slug)).toEqual(['gmail', 'google-calendar']);
    expect(rows.rows.every((r: any) => r.composio_auth_config_id.startsWith('ac_test_'))).toBe(true);
    expect(rows.rows.every((r: any) => r.enabled)).toBe(true);
    expect(rows.rows[0].display_name).toBe('Gmail');

    await runtimeDb.query(`DELETE FROM app_integration_configs WHERE app_id IN ($1, $2)`, [srcId, destId]);
    await runtimeDb.query(`DELETE FROM apps WHERE id IN ($1, $2)`, [srcId, destId]);
    await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
  });

  it('soft-fails when Composio is not configured', async () => {
    const ownerId = randomUUID();
    await controlDb.query(
      `INSERT INTO platform_users (id, email, email_verified) VALUES ($1, $2, true) ON CONFLICT (id) DO NOTHING`,
      [ownerId, `int-noconf-${ownerId}@x.com`],
    );
    const srcId = `app_int_nc_src_${ownerId.slice(0, 8)}`;
    const destId = `app_int_nc_dst_${ownerId.slice(0, 8)}`;
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, $1, $2, $1, 'us-east-1')
         ON CONFLICT (id) DO NOTHING`,
        [id, ownerId],
      );
    }
    await runtimeDb.query(
      `INSERT INTO app_integration_configs (app_id, toolkit_slug, composio_auth_config_id, enabled)
       VALUES ($1, 'gmail', 'ac_src_gmail', true)`,
      [srcId],
    );

    __setComposioClientForTest({
      authConfigs: {
        create: async () => {
          const e: any = new Error('not configured');
          e.code = 'INTEGRATIONS_NOT_CONFIGURED';
          throw e;
        },
      },
    } as any);

    const warnings: string[] = [];
    await replayIntegrations(runtimeDb, runtimeDb, srcId, destId, warnings, noopLogger);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/integration/i);

    const rows = await runtimeDb.query(
      `SELECT 1 FROM app_integration_configs WHERE app_id = $1`,
      [destId],
    );
    expect(rows.rowCount).toBe(0);

    await runtimeDb.query(`DELETE FROM app_integration_configs WHERE app_id IN ($1, $2)`, [srcId, destId]);
    await runtimeDb.query(`DELETE FROM apps WHERE id IN ($1, $2)`, [srcId, destId]);
    await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
  });

  it('continues past a single failing row', async () => {
    const ownerId = randomUUID();
    await controlDb.query(
      `INSERT INTO platform_users (id, email, email_verified) VALUES ($1, $2, true) ON CONFLICT (id) DO NOTHING`,
      [ownerId, `int-partial-${ownerId}@x.com`],
    );
    const srcId = `app_int_pf_src_${ownerId.slice(0, 8)}`;
    const destId = `app_int_pf_dst_${ownerId.slice(0, 8)}`;
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, $1, $2, $1, 'us-east-1')
         ON CONFLICT (id) DO NOTHING`,
        [id, ownerId],
      );
    }
    await runtimeDb.query(
      `INSERT INTO app_integration_configs (app_id, toolkit_slug, composio_auth_config_id, enabled)
       VALUES ($1, 'gmail', 'ac_src_gmail', true),
              ($1, 'slack', 'ac_src_slack', true)`,
      [srcId],
    );

    let calls = 0;
    __setComposioClientForTest({
      authConfigs: {
        create: async (slug: string) => {
          calls += 1;
          if (slug === 'SLACK') throw new Error('composio rejected slack');
          return { id: `ac_test_${calls}` };
        },
      },
    } as any);

    const warnings: string[] = [];
    await replayIntegrations(runtimeDb, runtimeDb, srcId, destId, warnings, noopLogger);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/slack/);

    const rows = await runtimeDb.query(
      `SELECT toolkit_slug FROM app_integration_configs WHERE app_id = $1 ORDER BY toolkit_slug`,
      [destId],
    );
    expect(rows.rows.map((r: any) => r.toolkit_slug)).toEqual(['gmail']);

    await runtimeDb.query(`DELETE FROM app_integration_configs WHERE app_id IN ($1, $2)`, [srcId, destId]);
    await runtimeDb.query(`DELETE FROM apps WHERE id IN ($1, $2)`, [srcId, destId]);
    await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
  });

  it('recreates BYO use_custom_auth configs from encrypted source credentials', async () => {
    const ownerId = randomUUID();
    await controlDb.query(
      `INSERT INTO platform_users (id, email, email_verified) VALUES ($1, $2, true) ON CONFLICT (id) DO NOTHING`,
      [ownerId, `int-byo-${ownerId}@x.com`],
    );
    const srcId = `app_int_byo_src_${ownerId.slice(0, 8)}`;
    const destId = `app_int_byo_dst_${ownerId.slice(0, 8)}`;
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, $1, $2, $1, 'us-east-1')
         ON CONFLICT (id) DO NOTHING`,
        [id, ownerId],
      );
    }

    const key = process.env.AUTH_ENCRYPTION_KEY ?? config.auth.encryptionKey;
    const twitterCreds = { client_id: 'twitter_cid', client_secret: 'twitter_csec', generic_id: 'app_bearer_xyz' };
    const linkedinCreds = { client_id: 'linkedin_cid', client_secret: 'linkedin_csec' };

    await runtimeDb.query(
      `INSERT INTO app_integration_configs
         (app_id, toolkit_slug, composio_auth_config_id, enabled, credentials_encrypted, auth_scheme)
       VALUES ($1, 'twitter',  'ac_src_twitter',  true, $2, 'OAUTH2'),
              ($1, 'linkedin', 'ac_src_linkedin', true, $3, 'OAUTH2'),
              ($1, 'gmail',    'ac_src_gmail',    true, NULL, NULL)`,
      [srcId, encrypt(JSON.stringify(twitterCreds), key), encrypt(JSON.stringify(linkedinCreds), key)],
    );

    const calls: Array<{ slug: string; args: any }> = [];
    let counter = 0;
    __setComposioClientForTest({
      authConfigs: {
        create: async (slug: string, args: any) => {
          calls.push({ slug, args });
          counter += 1;
          return { id: `ac_test_${counter}` };
        },
      },
    } as any);

    const warnings: string[] = [];
    await replayIntegrations(runtimeDb, runtimeDb, srcId, destId, warnings, noopLogger);
    expect(warnings).toEqual([]);

    // Gmail still uses managed auth; twitter + linkedin use use_custom_auth with decrypted creds.
    const callBySlug = Object.fromEntries(calls.map(c => [c.slug, c.args]));
    expect(callBySlug.GMAIL.type).toBe('use_composio_managed_auth');
    expect(callBySlug.TWITTER.type).toBe('use_custom_auth');
    expect(callBySlug.TWITTER.authScheme).toBe('OAUTH2');
    expect(callBySlug.TWITTER.credentials).toEqual(twitterCreds);
    expect(callBySlug.LINKEDIN.type).toBe('use_custom_auth');
    expect(callBySlug.LINKEDIN.credentials).toEqual(linkedinCreds);

    // Dest rows carry the encrypted blob + auth_scheme forward (copied ciphertext).
    const rows = await runtimeDb.query(
      `SELECT toolkit_slug, credentials_encrypted, auth_scheme
         FROM app_integration_configs WHERE app_id = $1 ORDER BY toolkit_slug`,
      [destId],
    );
    const byToolkit = Object.fromEntries(rows.rows.map((r: any) => [r.toolkit_slug, r]));
    expect(byToolkit.twitter.credentials_encrypted).toBeTruthy();
    expect(byToolkit.twitter.auth_scheme).toBe('OAUTH2');
    expect(byToolkit.linkedin.credentials_encrypted).toBeTruthy();
    expect(byToolkit.gmail.credentials_encrypted).toBeNull();
    expect(byToolkit.gmail.auth_scheme).toBeNull();

    await runtimeDb.query(`DELETE FROM app_integration_configs WHERE app_id IN ($1, $2)`, [srcId, destId]);
    await runtimeDb.query(`DELETE FROM apps WHERE id IN ($1, $2)`, [srcId, destId]);
    await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
  });

  it('legacy BYO row without credentials_encrypted falls through to managed-auth and warns', async () => {
    const ownerId = randomUUID();
    await controlDb.query(
      `INSERT INTO platform_users (id, email, email_verified) VALUES ($1, $2, true) ON CONFLICT (id) DO NOTHING`,
      [ownerId, `int-legacy-${ownerId}@x.com`],
    );
    const srcId = `app_int_lg_src_${ownerId.slice(0, 8)}`;
    const destId = `app_int_lg_dst_${ownerId.slice(0, 8)}`;
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, $1, $2, $1, 'us-east-1')
         ON CONFLICT (id) DO NOTHING`,
        [id, ownerId],
      );
    }
    // Legacy row: BYO toolkit on Composio's side but no local credentials_encrypted.
    await runtimeDb.query(
      `INSERT INTO app_integration_configs (app_id, toolkit_slug, composio_auth_config_id, enabled)
       VALUES ($1, 'twitter', 'ac_src_twitter', true)`,
      [srcId],
    );

    __setComposioClientForTest({
      authConfigs: {
        create: async (_slug: string, args: any) => {
          // Composio refuses managed auth for BYO-only toolkits.
          if (args?.type === 'use_composio_managed_auth') {
            throw new Error('toolkit requires custom OAuth credentials');
          }
          return { id: 'ac_should_not_happen' };
        },
      },
    } as any);

    const warnings: string[] = [];
    await replayIntegrations(runtimeDb, runtimeDb, srcId, destId, warnings, noopLogger);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/twitter/);

    const rows = await runtimeDb.query(
      `SELECT 1 FROM app_integration_configs WHERE app_id = $1`,
      [destId],
    );
    expect(rows.rowCount).toBe(0);

    await runtimeDb.query(`DELETE FROM app_integration_configs WHERE app_id IN ($1, $2)`, [srcId, destId]);
    await runtimeDb.query(`DELETE FROM apps WHERE id IN ($1, $2)`, [srcId, destId]);
    await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
  });

  it('is idempotent on retry: does not re-mint when dest row already exists', async () => {
    const ownerId = randomUUID();
    await controlDb.query(
      `INSERT INTO platform_users (id, email, email_verified) VALUES ($1, $2, true) ON CONFLICT (id) DO NOTHING`,
      [ownerId, `int-idem-${ownerId}@x.com`],
    );
    const srcId = `app_int_idem_src_${ownerId.slice(0, 8)}`;
    const destId = `app_int_idem_dst_${ownerId.slice(0, 8)}`;
    for (const id of [srcId, destId]) {
      await runtimeDb.query(
        `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, $1, $2, $1, 'us-east-1')
         ON CONFLICT (id) DO NOTHING`,
        [id, ownerId],
      );
    }
    await runtimeDb.query(
      `INSERT INTO app_integration_configs (app_id, toolkit_slug, composio_auth_config_id, enabled)
       VALUES ($1, 'gmail', 'ac_src_gmail', true)`,
      [srcId],
    );

    let mints = 0;
    __setComposioClientForTest({
      authConfigs: {
        create: async () => {
          mints += 1;
          return { id: `ac_test_${mints}` };
        },
      },
    } as any);

    const warnings: string[] = [];
    await replayIntegrations(runtimeDb, runtimeDb, srcId, destId, warnings, noopLogger);
    expect(mints).toBe(1);

    // Second run (simulating a clone-job retry) MUST NOT mint a new auth config.
    await replayIntegrations(runtimeDb, runtimeDb, srcId, destId, warnings, noopLogger);
    expect(mints).toBe(1);
    expect(warnings).toEqual([]);

    const rows = await runtimeDb.query(
      `SELECT composio_auth_config_id FROM app_integration_configs WHERE app_id = $1 AND toolkit_slug = 'gmail'`,
      [destId],
    );
    expect(rows.rows[0].composio_auth_config_id).toBe('ac_test_1');

    await runtimeDb.query(`DELETE FROM app_integration_configs WHERE app_id IN ($1, $2)`, [srcId, destId]);
    await runtimeDb.query(`DELETE FROM apps WHERE id IN ($1, $2)`, [srcId, destId]);
    await controlDb.query(`DELETE FROM platform_users WHERE id = $1`, [ownerId]);
  });
});
