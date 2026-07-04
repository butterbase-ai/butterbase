/**
 * E2E — GET /v1/templates (anonymous discovery list endpoint)
 *
 * Phase 4b: fans out across all configured runtime regions, filters apps
 * where visibility='public' AND listed=true AND db_provisioned=true.
 *
 * Drives the control-api at http://localhost:4000. Seeds users/apps directly
 * into the running control-plane + runtime-plane DBs (same pattern as
 * 22-app-clone.test.ts). Auth via real bb_sk_* keys for visibility PATCH;
 * list endpoint is anonymous (no Authorization header required).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { RATE_LIMIT_BYPASS_HEADERS } from './helpers/templates.js';

const API_URL = 'http://localhost:4000';
const CONTROL_DB_URL = 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';
const RUNTIME_DB_URL_US = 'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

let controlPool: pg.Pool;
let runtimePool: pg.Pool;

interface SeededUser { userId: string; apiKey: string; }
interface SeededApp { userId: string; appId: string; apiKey: string; }

function generateApiKey(): { fullKey: string; keyHash: string; keyPrefix: string } {
  const fullKey = `bb_sk_${randomBytes(20).toString('hex')}`;
  const keyHash = createHash('sha256').update(fullKey).digest('hex');
  return { fullKey, keyHash, keyPrefix: fullKey.substring(0, 12) };
}

async function seedUser(): Promise<SeededUser> {
  const stamp = Date.now() + Math.random().toString(36).slice(2, 8);
  const email = `disc-e2e-${stamp}@example.com`;
  const u = await controlPool.query<{ id: string }>(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES (gen_random_uuid(), $1, 'active', 'launch') RETURNING id`,
    [email],
  );
  const userId = u.rows[0].id;
  const { fullKey, keyHash, keyPrefix } = generateApiKey();
  await controlPool.query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name, scopes, scope, substrate_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, keyHash, keyPrefix, 'disc-e2e', ['*'], 'app', userId],
  );
  return { userId, apiKey: fullKey };
}

async function seedApp(ownerId: string, region: string): Promise<string> {
  const stamp = Date.now() + Math.random().toString(36).slice(2, 8);
  const appId = `disc-e2e-app-${stamp}`;
  const subdomain = `disc-e2e-${stamp}`;
  await controlPool.query(
    `INSERT INTO org_app_index (app_id, organization_id, region) VALUES ($1, (SELECT personal_organization_id FROM platform_users WHERE id = $2), $3)`,
    [appId, ownerId, region],
  );
  await runtimePool.query(
    `INSERT INTO apps (id, name, owner_id, db_name, subdomain, region, provisioning_status, db_provisioned)
     VALUES ($1, $2, $3, $4, $5, $6, 'ready', true)`,
    [appId, `disc-e2e ${stamp}`, ownerId, `cust_${appId.replace(/-/g, '_')}`, subdomain, region],
  );
  return appId;
}

async function seedUserAndApp(region: string): Promise<SeededApp> {
  const u = await seedUser();
  const appId = await seedApp(u.userId, region);
  return { userId: u.userId, appId, apiKey: u.apiKey };
}

beforeAll(async () => {
  controlPool = new pg.Pool({ connectionString: CONTROL_DB_URL });
  runtimePool = new pg.Pool({ connectionString: RUNTIME_DB_URL_US });
}, 30_000);

afterAll(async () => {
  await controlPool?.end();
  await runtimePool?.end();
}, 30_000);

describe('Phase 4b discovery — GET /v1/templates', () => {
  it('returns only public+listed apps, anonymously', async () => {
    const a = await seedUserAndApp('us-east-1');

    // Mark public + listed via PATCH endpoint.
    const patch = await fetch(`${API_URL}/v1/${a.appId}/config/visibility`, {
      method: 'PATCH',
      headers: { ...RATE_LIMIT_BYPASS_HEADERS, Authorization: `Bearer ${a.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public', listed: true }),
    });
    expect(patch.status).toBe(200);

    // Anonymous — no Authorization header.
    const res = await fetch(`${API_URL}/v1/templates?limit=50`, { headers: RATE_LIMIT_BYPASS_HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ app_id: string }>; total: number; limit: number; offset: number };

    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(body.items.some(t => t.app_id === a.appId)).toBe(true);
  }, 30_000);

  it('does NOT return private apps', async () => {
    const a = await seedUserAndApp('us-east-1');
    // App stays private (default). Do not patch visibility.

    const res = await fetch(`${API_URL}/v1/templates?limit=50`, { headers: RATE_LIMIT_BYPASS_HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ app_id: string }> };

    expect(body.items.some(t => t.app_id === a.appId)).toBe(false);
  }, 30_000);

  it('q prefix filter narrows results', async () => {
    const stamp = Date.now().toString(36);
    const u = await seedUser();
    const appId = await seedApp(u.userId, 'us-east-1');

    // Rename the app to a unique prefix so we can filter it precisely.
    const uniqueName = `templatefilter-${stamp}`;
    await runtimePool.query(`UPDATE apps SET name = $1 WHERE id = $2`, [uniqueName, appId]);

    // Make it public+listed.
    await runtimePool.query(
      `UPDATE apps SET visibility = 'public', listed = true WHERE id = $1`,
      [appId],
    );

    const res = await fetch(`${API_URL}/v1/templates?q=${encodeURIComponent('templatefilter-')}&limit=50`, { headers: RATE_LIMIT_BYPASS_HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ app_id: string; name: string }> };

    expect(body.items.some(t => t.app_id === appId)).toBe(true);
    // Ensure all returned items match the prefix (case-insensitive).
    for (const item of body.items) {
      expect(item.name.toLowerCase()).toMatch(/^templatefilter-/);
    }
  }, 30_000);

  it('sort=popular orders by fork_count descending', async () => {
    const stamp = Date.now().toString(36);
    const u = await seedUser();

    // Seed two apps with distinct fork counts.
    const appIdLow = await seedApp(u.userId, 'us-east-1');
    const appIdHigh = await seedApp(u.userId, 'us-east-1');
    const uniquePrefix = `sortpop-${stamp}`;

    await runtimePool.query(
      `UPDATE apps SET name = $1, visibility = 'public', listed = true, fork_count = 1 WHERE id = $2`,
      [`${uniquePrefix}-low`, appIdLow],
    );
    await runtimePool.query(
      `UPDATE apps SET name = $1, visibility = 'public', listed = true, fork_count = 99 WHERE id = $2`,
      [`${uniquePrefix}-high`, appIdHigh],
    );

    const res = await fetch(
      `${API_URL}/v1/templates?q=${encodeURIComponent(uniquePrefix)}&sort=popular&limit=50`,
      { headers: RATE_LIMIT_BYPASS_HEADERS },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ app_id: string; fork_count: number }> };

    const relevant = body.items.filter(
      (t) => t.app_id === appIdLow || t.app_id === appIdHigh,
    );
    expect(relevant.length).toBe(2);
    // Higher fork_count must come first.
    expect(relevant[0].app_id).toBe(appIdHigh);
    expect(relevant[1].app_id).toBe(appIdLow);
  }, 30_000);

  it('offset > 0 paginates correctly', async () => {
    const stamp = Date.now().toString(36);
    const u = await seedUser();

    // Seed 3 apps with a unique prefix so we can filter precisely.
    const uniquePrefix = `paginate-${stamp}`;
    const appIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const appId = await seedApp(u.userId, 'us-east-1');
      await runtimePool.query(
        `UPDATE apps SET name = $1, visibility = 'public', listed = true WHERE id = $2`,
        [`${uniquePrefix}-${i}`, appId],
      );
      appIds.push(appId);
    }

    // Fetch first page (limit=2, offset=0).
    const page1Res = await fetch(
      `${API_URL}/v1/templates?q=${encodeURIComponent(uniquePrefix)}&limit=2&offset=0`,
      { headers: RATE_LIMIT_BYPASS_HEADERS },
    );
    expect(page1Res.status).toBe(200);
    const page1 = await page1Res.json() as { items: Array<{ app_id: string }>; limit: number; offset: number };
    expect(page1.limit).toBe(2);
    expect(page1.offset).toBe(0);
    expect(page1.items.length).toBe(2);

    // Fetch second page (limit=2, offset=2) — should have the remaining 1 item.
    const page2Res = await fetch(
      `${API_URL}/v1/templates?q=${encodeURIComponent(uniquePrefix)}&limit=2&offset=2`,
      { headers: RATE_LIMIT_BYPASS_HEADERS },
    );
    expect(page2Res.status).toBe(200);
    const page2 = await page2Res.json() as { items: Array<{ app_id: string }>; limit: number; offset: number };
    expect(page2.limit).toBe(2);
    expect(page2.offset).toBe(2);
    expect(page2.items.length).toBe(1);

    // All 3 unique apps should appear across both pages exactly once.
    const allItems = [...page1.items, ...page2.items].map((t) => t.app_id);
    for (const id of appIds) {
      expect(allItems).toContain(id);
    }
  }, 30_000);

  it('returns well-shaped TemplateRow items', async () => {
    const a = await seedUserAndApp('us-east-1');

    await fetch(`${API_URL}/v1/${a.appId}/config/visibility`, {
      method: 'PATCH',
      headers: { ...RATE_LIMIT_BYPASS_HEADERS, Authorization: `Bearer ${a.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public', listed: true }),
    });

    const res = await fetch(`${API_URL}/v1/templates?limit=50`, { headers: RATE_LIMIT_BYPASS_HEADERS });
    const body = await res.json() as { items: Array<Record<string, unknown>> };

    const item = body.items.find(t => t.app_id === a.appId);
    expect(item).toBeDefined();
    if (!item) return;

    expect(typeof item.app_id).toBe('string');
    expect(typeof item.name).toBe('string');
    expect(typeof item.region).toBe('string');
    expect(typeof item.created_at).toBe('string');
    expect(typeof item.fork_count).toBe('number');
    expect(typeof item.has_repo).toBe('boolean');
  }, 30_000);
});

describe('Phase 4b discovery — GET /v1/templates/:id', () => {
  it('GET /v1/templates/:id returns detail for a public+listed app', async () => {
    const a = await seedUserAndApp('us-east-1');
    await fetch(`${API_URL}/v1/${a.appId}/config/visibility`, {
      method: 'PATCH',
      headers: { ...RATE_LIMIT_BYPASS_HEADERS, Authorization: `Bearer ${a.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public', listed: true }),
    });
    const res = await fetch(`${API_URL}/v1/templates/${a.appId}`, { headers: RATE_LIMIT_BYPASS_HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      app_id: string; tables: unknown[]; functions: unknown[]; forks_sample: unknown[];
    };
    expect(body.app_id).toBe(a.appId);
    expect(Array.isArray(body.tables)).toBe(true);
    expect(Array.isArray(body.functions)).toBe(true);
    expect(Array.isArray(body.forks_sample)).toBe(true);
  }, 30_000);

  it('GET /v1/templates/:id returns 404 for private app', async () => {
    const a = await seedUserAndApp('us-east-1');
    // Default visibility=private.
    const res = await fetch(`${API_URL}/v1/templates/${a.appId}`, { headers: RATE_LIMIT_BYPASS_HEADERS });
    expect(res.status).toBe(404);
  }, 30_000);

  it('GET /v1/templates/:id returns 404 for unlisted app', async () => {
    const a = await seedUserAndApp('us-east-1');
    await fetch(`${API_URL}/v1/${a.appId}/config/visibility`, {
      method: 'PATCH',
      headers: { ...RATE_LIMIT_BYPASS_HEADERS, Authorization: `Bearer ${a.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public', listed: false }),
    });
    const res = await fetch(`${API_URL}/v1/templates/${a.appId}`, { headers: RATE_LIMIT_BYPASS_HEADERS });
    expect(res.status).toBe(404);
  }, 30_000);

  it('detail tables[] excludes internal/platform tables', async () => {
    const a = await seedUserAndApp('us-east-1');

    // The introspector runs against the shared runtime DB pool (schemaname='public').
    // Create a uniquely-named user table and an internal-prefixed table in the
    // shared runtime DB so introspection has something to see.
    const stamp = Date.now().toString(36);
    const userTableName = `j2_posts_${stamp}`;
    const internalTableName = `_j2_internal_${stamp}`;

    await runtimePool.query(
      `CREATE TABLE IF NOT EXISTS ${userTableName} (id uuid PRIMARY KEY)`,
    );
    await runtimePool.query(
      `CREATE TABLE IF NOT EXISTS ${internalTableName} (id uuid PRIMARY KEY)`,
    );

    // Mark public + listed.
    await fetch(`${API_URL}/v1/${a.appId}/config/visibility`, {
      method: 'PATCH',
      headers: { ...RATE_LIMIT_BYPASS_HEADERS, Authorization: `Bearer ${a.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public', listed: true }),
    });

    const res = await fetch(`${API_URL}/v1/templates/${a.appId}`, { headers: RATE_LIMIT_BYPASS_HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json() as { tables: Array<{ name: string }> };
    expect(Array.isArray(body.tables)).toBe(true);

    const tableNames = body.tables.map((t) => t.name);

    // The user table must be visible.
    expect(tableNames).toContain(userTableName);

    // The internal-prefixed table must be filtered out.
    expect(tableNames).not.toContain(internalTableName);

    // Validate the filter holds for every returned table name.
    const PLATFORM_EXACT = [
      'app_signing_keys', 'app_users', 'app_oauth_configs', 'app_refresh_tokens',
      'app_verification_codes', 'app_functions', 'app_integration_configs',
      'app_connected_accounts', 'app_realtime_config', 'auth_audit_logs',
      'api_keys', 'neon_tasks', 'template_clone_jobs',
    ];
    for (const n of tableNames) {
      expect(n.startsWith('_'), `${n} starts with _`).toBe(false);
      expect(n.startsWith('agent_'), `${n} starts with agent_`).toBe(false);
      expect(PLATFORM_EXACT.includes(n), `${n} is a platform table`).toBe(false);
    }

    // Cleanup — drop the scratch tables.
    await runtimePool.query(`DROP TABLE IF EXISTS ${userTableName}`);
    await runtimePool.query(`DROP TABLE IF EXISTS ${internalTableName}`);
  }, 60_000);

  it('detail endpoint 404 matrix: only public+listed is reachable; the rest are identical 404 bodies', async () => {
    // Seed 4 apps covering all visibility × listed combinations.
    const apps = {
      publicListed: await seedUserAndApp('us-east-1'),
      publicUnlisted: await seedUserAndApp('us-east-1'),
      privateListed: await seedUserAndApp('us-east-1'),
      privateUnlisted: await seedUserAndApp('us-east-1'),
    };

    async function patchVis(app: typeof apps.publicListed, visibility: 'public' | 'private', listed: boolean) {
      const r = await fetch(`${API_URL}/v1/${app.appId}/config/visibility`, {
        method: 'PATCH',
        headers: { ...RATE_LIMIT_BYPASS_HEADERS, Authorization: `Bearer ${app.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ visibility, listed }),
      });
      if (!r.ok) throw new Error(`patchVis failed for ${app.appId}: ${r.status} ${await r.text()}`);
    }

    await patchVis(apps.publicListed, 'public', true);
    await patchVis(apps.publicUnlisted, 'public', false);
    await patchVis(apps.privateListed, 'private', true);
    await patchVis(apps.privateUnlisted, 'private', false);

    const results = await Promise.all(
      Object.entries(apps).map(async ([k, a]) => {
        const r = await fetch(`${API_URL}/v1/templates/${a.appId}`, { headers: RATE_LIMIT_BYPASS_HEADERS });
        return { k, status: r.status, body: r.status >= 400 ? await r.json() : null };
      }),
    );

    // Only public+listed is accessible.
    expect(results.find(r => r.k === 'publicListed')!.status).toBe(200);

    // The other three must all return 404 with code TEMPLATE_NOT_FOUND.
    for (const k of ['publicUnlisted', 'privateListed', 'privateUnlisted']) {
      const r = results.find(x => x.k === k)!;
      expect(r.status, `${k} should be 404`).toBe(404);
      expect(
        (r.body as { error?: { code?: string } } | null)?.error?.code,
        `${k} error.code should be TEMPLATE_NOT_FOUND`,
      ).toBe('TEMPLATE_NOT_FOUND');
    }
  }, 60_000);
});
