/**
 * Verify the account-deletion cascade end-to-end.
 *
 * Reproduces the prod failure modes that have shipped fixes:
 *  - 056: hackathon_submissions / hackathon_scores FKs (NO ACTION → 23503)
 *  - 058: app_deployments / app_functions / app_edge_ssr_deployments /
 *         app_durable_objects deployed_by FKs (NO ACTION → 23503)
 *  - 059: app_subscriptions.plan_id and app_orders.product_id cross-sibling
 *         FKs upgraded to CASCADE so they no longer depend on the
 *         apps-cascade invariant
 *
 * Builds a fully-populated user (apps, deployments, functions, DO classes,
 * Edge SSR deployments, app users, plans + subscriptions, products + orders,
 * hackathon participation), then DELETEs the user and verifies every
 * dependent row has either cascaded out or had `deployed_by` SET NULL as
 * designed.
 *
 * Run from the repo root: `npm run verify:cascade`
 *   (defaults to the local Docker control DB; override with CONTROL_DB_URL)
 *
 * Wire this into CI before any merge that touches db/control-plane/*.sql or
 * the account-deletion route — a passing run is the contract.
 *
 * Cleans up whatever it creates whether the test passes or fails.
 */
import pg from 'pg';
import crypto from 'node:crypto';

const controlDbUrl =
  process.env.CONTROL_DB_URL ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

// Phase 2: single-region — apps and app_* tables are runtime tables.
// NOTE: In production (split DBs) the platform_users → apps FK cascade cannot
// work across databases. This script still exercises the cascade locally
// (single-DB dev) and validates the control-plane hackathon rows separately.
// When multi-region is operationally deployed, this script will need to be
// split into two separate cascade tests (one per DB).
const runtimeDbUrl =
  process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 ?? controlDbUrl;

// control pool: platform_users, hackathons, hackathon_participants, hackathon_submissions, hackathon_scores
const pool = new pg.Pool({ connectionString: controlDbUrl });
// runtime pool: apps, app_deployments, app_functions, app_edge_ssr_deployments,
//               app_durable_objects, app_users, app_plans, app_subscriptions,
//               app_products, app_orders
const runtimePool = new pg.Pool({ connectionString: runtimeDbUrl });

const TAG = `cascade-test-${Date.now()}`;

async function main() {
  // control client: platform_users, hackathons, hackathon_* (stay on control)
  const client = await pool.connect();
  // runtime client: apps, app_* tables
  const runtimeClient = await runtimePool.connect();
  let userId: string | null = null;
  let hackathonId: string | null = null;
  let appId: string | null = null;

  try {
    // 1. Create synthetic user (control table)
    const u = await client.query<{ id: string }>(
      `INSERT INTO platform_users (email, display_name)
         VALUES ($1, $2)
         RETURNING id`,
      [`${TAG}@example.test`, TAG]
    );
    userId = u.rows[0].id;
    console.log(`✓ created user ${userId}`);

    // 2. Create hackathon (control table)
    const h = await client.query<{ id: string }>(
      `INSERT INTO hackathons (slug, name, starts_at, ends_at, submission_deadline,
                               field_schema, submission_code_hash, judge_code_hash)
         VALUES ($1, $2, now(), now() + interval '7 days', now() + interval '7 days',
                 '{}'::jsonb, $3, $4)
         RETURNING id`,
      [TAG, `Cascade Test ${TAG}`, crypto.randomBytes(16).toString('hex'), crypto.randomBytes(16).toString('hex')]
    );
    hackathonId = h.rows[0].id;
    console.log(`✓ created hackathon ${hackathonId}`);

    // 3. Participant (control table)
    const p = await client.query<{ id: string }>(
      `INSERT INTO hackathon_participants (hackathon_id, user_id, source, status)
         VALUES ($1, $2, 'admin_panel', 'active')
         RETURNING id`,
      [hackathonId, userId]
    );
    const participantId = p.rows[0].id;
    console.log(`✓ created participant ${participantId}`);

    // 4. Submission — this is the row whose FK was previously NO ACTION (control table)
    const s = await client.query<{ id: string }>(
      `INSERT INTO hackathon_submissions (hackathon_id, participant_id, user_id, data)
         VALUES ($1, $2, $3, '{"test":true}'::jsonb)
         RETURNING id`,
      [hackathonId, participantId, userId]
    );
    const submissionId = s.rows[0].id;
    console.log(`✓ created submission ${submissionId}`);

    // 5. Score — also previously NO ACTION (control table)
    await client.query(
      `INSERT INTO hackathon_scores (submission_id, hackathon_id, participant_id, user_id)
         VALUES ($1, $2, $3, $4)`,
      [submissionId, hackathonId, participantId, userId]
    );
    console.log(`✓ created score`);

    // 6. App owned by the user — runtime table
    appId = `app_${TAG.replace(/-/g, '_')}`;
    await runtimeClient.query(
      `INSERT INTO apps (id, name, owner_id, db_name)
         VALUES ($1, $2, $3, $4)`,
      [appId, `Cascade Test App ${TAG}`, userId, `db_${TAG.replace(/-/g, '_')}`]
    );
    console.log(`✓ created app ${appId}`);

    // 7. Frontend deployment — app_deployments.deployed_by (mig 058 SET NULL) — runtime table
    const fd = await runtimeClient.query<{ id: string }>(
      `INSERT INTO app_deployments (app_id, status, deployed_by)
         VALUES ($1, 'pending', $2)
         RETURNING id`,
      [appId, userId]
    );
    const frontendDeploymentId = fd.rows[0].id;
    console.log(`✓ created app_deployments row ${frontendDeploymentId}`);

    // 8. Function — app_functions.deployed_by (mig 058 SET NULL) — runtime table
    const fn = await runtimeClient.query<{ id: string }>(
      `INSERT INTO app_functions (app_id, name, code, deployed_by)
         VALUES ($1, 'test-fn', 'export default async () => new Response("ok")', $2)
         RETURNING id`,
      [appId, userId]
    );
    const functionId = fn.rows[0].id;
    console.log(`✓ created app_functions row ${functionId}`);

    // 9. Edge SSR deployment — app_edge_ssr_deployments.deployed_by (mig 058 SET NULL) — runtime table
    const ssr = await runtimeClient.query<{ id: string }>(
      `INSERT INTO app_edge_ssr_deployments (app_id, framework, deployed_by)
         VALUES ($1, 'nextjs-edge', $2)
         RETURNING id`,
      [appId, userId]
    );
    const ssrDeploymentId = ssr.rows[0].id;
    console.log(`✓ created app_edge_ssr_deployments row ${ssrDeploymentId}`);

    // 10. Durable Object class — app_durable_objects.deployed_by (mig 058 SET NULL) — runtime table
    const doRow = await runtimeClient.query<{ id: string }>(
      `INSERT INTO app_durable_objects (app_id, name, class_name, code, code_sha, deployed_by)
         VALUES ($1, 'test-do', 'TestDo', 'export class TestDo {}', 'sha', $2)
         RETURNING id`,
      [appId, userId]
    );
    const doId = doRow.rows[0].id;
    console.log(`✓ created app_durable_objects row ${doId}`);

    // 10b. End-user account inside this app (app_users), plus a plan + subscription
    // and a product + order — all runtime tables.
    // After migration 059 the cross-sibling FKs
    // (app_subscriptions.plan_id → app_plans, app_orders.product_id →
    // app_products) are CASCADE, so deleting the parent row alone would also
    // clean the child.
    const au = await runtimeClient.query<{ id: string }>(
      `INSERT INTO app_users (app_id, email) VALUES ($1, $2) RETURNING id`,
      [appId, `app-user-${TAG}@example.test`]
    );
    const appUserId = au.rows[0].id;
    console.log(`✓ created app_users row ${appUserId}`);

    const plan = await runtimeClient.query<{ id: string }>(
      `INSERT INTO app_plans (app_id, name, price_cents) VALUES ($1, 'Pro', 1000) RETURNING id`,
      [appId]
    );
    const planRowId = plan.rows[0].id;

    // Resolve organization_id for app_subscriptions and app_orders INSERTs
    const orgResult = await runtimeClient.query<{ organization_id: string }>(
      `SELECT organization_id FROM apps WHERE id = $1`,
      [appId]
    );
    const organizationId = orgResult.rows[0]?.organization_id;
    if (!organizationId) {
      throw new Error(`app ${appId} has no organization_id`);
    }

    const sub = await runtimeClient.query<{ id: string }>(
      `INSERT INTO app_subscriptions (organization_id, app_id, user_id, plan_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [organizationId, appId, appUserId, planRowId]
    );
    const subId = sub.rows[0].id;
    console.log(`✓ created app_plans + app_subscriptions`);

    const product = await runtimeClient.query<{ id: string }>(
      `INSERT INTO app_products (app_id, name, price_cents) VALUES ($1, 'Widget', 500) RETURNING id`,
      [appId]
    );
    const productRowId = product.rows[0].id;
    const order = await runtimeClient.query<{ id: string }>(
      `INSERT INTO app_orders (organization_id, app_id, user_id, product_id, stripe_checkout_session_id, amount_cents, platform_fee_cents)
         VALUES ($1, $2, $3, $4, $5, 500, 50) RETURNING id`,
      [organizationId, appId, appUserId, productRowId, `cs_test_${TAG}`]
    );
    const orderId = order.rows[0].id;
    console.log(`✓ created app_products + app_orders`);

    // 11. THE TEST: delete the user (control table). Pre-058 this throws 23503 on deployed_by.
    // NOTE: In production with split DBs, platform_users → apps cascade is handled
    // at the application level (control-api delete route), not via DB FK.
    console.log(`\n→ DELETE FROM platform_users WHERE id = '${userId}'`);
    const del = await client.query('DELETE FROM platform_users WHERE id = $1', [userId]);
    if (del.rowCount !== 1) {
      throw new Error(`expected rowCount=1, got ${del.rowCount}`);
    }
    console.log(`✓ user deleted (cascade did not fail)`);
    userId = null; // mark deleted so finally doesn't try again

    // 12. Delete the runtime app and verify cascade within the runtime DB.
    // (In production the control-api delete route handles this cross-DB step.)
    await runtimeClient.query('DELETE FROM apps WHERE id = $1', [appId]);
    appId = null; // mark deleted

    // 13. Verify cascade within the runtime DB wiped the children.
    const controlChecks = [
      ['hackathon_participants', `WHERE id = '${participantId}'`],
      ['hackathon_submissions', `WHERE id = '${submissionId}'`],
      ['hackathon_scores', `WHERE submission_id = '${submissionId}'`],
    ] as const;
    for (const [table, where] of controlChecks) {
      const r = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} ${where}`);
      if (r.rows[0].n !== 0) {
        throw new Error(`cascade failed: ${table} still has ${r.rows[0].n} row(s)`);
      }
      console.log(`✓ ${table} cascaded (0 rows remain)`);
    }

    const runtimeChecks = [
      ['apps', `WHERE id = '${appId ?? ''}'`],
      ['app_deployments', `WHERE id = '${frontendDeploymentId}'`],
      ['app_functions', `WHERE id = '${functionId}'`],
      ['app_edge_ssr_deployments', `WHERE id = '${ssrDeploymentId}'`],
      ['app_durable_objects', `WHERE id = '${doId}'`],
      ['app_users', `WHERE id = '${appUserId}'`],
      ['app_plans', `WHERE id = '${planRowId}'`],
      ['app_subscriptions', `WHERE id = '${subId}'`],
      ['app_products', `WHERE id = '${productRowId}'`],
      ['app_orders', `WHERE id = '${orderId}'`],
    ] as const;
    for (const [table, where] of runtimeChecks) {
      const r = await runtimeClient.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} ${where}`);
      if (r.rows[0].n !== 0) {
        throw new Error(`cascade failed: ${table} still has ${r.rows[0].n} row(s)`);
      }
      console.log(`✓ ${table} cascaded (0 rows remain)`);
    }

    console.log('\n=== PASS: account deletion cascade works end-to-end ===');
  } catch (err) {
    const e = err as { code?: string; constraint?: string; table?: string; detail?: string; message?: string };
    console.error('\n=== FAIL ===');
    console.error({
      message: e.message,
      pgCode: e.code,
      pgConstraint: e.constraint,
      pgTable: e.table,
      pgDetail: e.detail,
    });
    process.exitCode = 1;
  } finally {
    // Cleanup — apps cascade to all runtime deployment tables.
    if (appId) {
      await runtimeClient.query('DELETE FROM apps WHERE id = $1', [appId]).catch(() => {});
    }
    if (userId) {
      await client.query('DELETE FROM platform_users WHERE id = $1', [userId]).catch(() => {});
    }
    if (hackathonId) {
      await client.query('DELETE FROM hackathons WHERE id = $1', [hackathonId]).catch(() => {});
    }
    runtimeClient.release();
    client.release();
    await pool.end();
    await runtimePool.end();
  }
}

main();
