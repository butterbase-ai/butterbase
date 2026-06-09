import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { replayIntegrations } from '../clone-replay.js';
import { __setComposioClientForTest } from '../composio-client.js';
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
});
