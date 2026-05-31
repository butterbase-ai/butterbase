import type { FastifyInstance } from 'fastify';
import { config, assertRegionConfig } from '../config.js';
import { provisionApp, generateAppId, insertAppRow, provisionAppBackground } from '../services/provisioner.js';
import * as DeploymentService from '../services/deployment.service.js';
import { purgeAppUsage } from '../services/usage-metering.js';
import { requireUserId } from '../utils/require-auth.js';
import { quotaErrors } from '../utils/quota-errors.js';
import { logFromRequest } from '../services/audit/with-audit.js';
import { getDataProjectIdForRegion } from '../services/neon-projects.js';
import { addUserAppIndex, removeUserAppIndex, listUserApps } from '../services/user-app-index.js';

const initSchema = {
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 63,
        pattern: '^[a-z0-9][a-z0-9_-]*$',
      },
      subdomain: {
        type: 'string',
        minLength: 1,
        maxLength: 63,
        pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$',
      },
      region: {
        type: 'string',
        minLength: 1,
      },
    },
    additionalProperties: false,
  },
} as const;

export async function initRoutes(app: FastifyInstance) {
  app.get('/apps', async (request) => {
    const ownerId = requireUserId(request);
    const indexRows = await listUserApps(app.controlDb, ownerId);
    if (indexRows.length === 0) return { apps: [] };

    const regions = Array.from(new Set(indexRows.map((r) => r.region)));
    const allRows: any[] = [];
    for (const region of regions) {
      const { rows } = await app.runtimeDb(region).query(
        'SELECT id, name, subdomain, db_name, db_provisioned, provisioning_status, region, visibility, listed, substrate_user_id, created_at FROM apps WHERE owner_id = $1 ORDER BY created_at DESC',
        [ownerId]
      );
      allRows.push(...rows);
    }
    allRows.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
    return { apps: allRows };
  });

  app.get('/apps/:app_id/status', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const ownerId = requireUserId(request);
    // Look up the app's home region from the cross-region user_app_index
    // — the runtime apps row lives in that region's DB only.
    const idx = await app.controlDb.query<{ region: string }>(
      `SELECT region FROM user_app_index WHERE app_id = $1`,
      [app_id]
    );
    if (idx.rows.length === 0) {
      return reply.code(404).send({ code: 'RESOURCE_NOT_FOUND', message: `App "${app_id}" not found` });
    }
    const region = idx.rows[0].region;

    const { rows } = await app.runtimeDb(region).query(
      `SELECT id, name, db_provisioned, provisioning_status, provisioning_error, created_at
       FROM apps WHERE id = $1 AND owner_id = $2`,
      [app_id, ownerId]
    );

    if (rows.length === 0) {
      return reply.code(404).send({ code: 'RESOURCE_NOT_FOUND', message: `App "${app_id}" not found` });
    }

    const row = rows[0];
    return {
      app_id: row.id,
      name: row.name,
      db_provisioned: row.db_provisioned,
      provisioning_status: row.provisioning_status,
      provisioning_error: row.provisioning_error,
    };
  });

  app.post('/init', { schema: initSchema }, async (request, reply) => {
    const { name, subdomain: requestedSubdomain } = request.body as { name: string; subdomain?: string };

    // Validate region before any DB work.
    //
    // Default-region resolution order:
    //   1. Explicit body.region (MCP/dashboard passes this)
    //   2. BUTTERBASE_DEFAULT_REGION (operator-set, account-global default)
    //   3. First entry in BUTTERBASE_REGIONS (deterministic fallback)
    //   4. 'local' (single-region dev)
    //
    // Do NOT fall back to process.env.BUTTERBASE_REGION (the local machine's
    // region): Fly anycast routes the request to whichever machine is
    // geographically nearest, so a user in California silently got their
    // app provisioned in us-west-2 even when they didn't pick a region.
    // The default needs to be deterministic across machines.
    const allowedRegions = (process.env.BUTTERBASE_REGIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const bodyRegion = (request.body as { region?: string } | undefined)?.region;
    const provisionRegion =
      bodyRegion ??
      process.env.BUTTERBASE_DEFAULT_REGION ??
      allowedRegions[0] ??
      'local';

    if (!allowedRegions.includes(provisionRegion)) {
      return reply.code(400).send({
        error: `Region "${provisionRegion}" is not in BUTTERBASE_REGIONS`,
        allowed: allowedRegions,
      });
    }
    try {
      getDataProjectIdForRegion(provisionRegion);
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }

    // Use authenticated user ID as owner
    const ownerId = requireUserId(request);
    // All per-app runtime writes happen in the TARGET region's runtime DB
    // (where the app is homed), not the local machine's. user_app_index on
    // the control DB is the cross-region map.
    const region = provisionRegion;

    // Enforce project limit for the user's plan.
    // Cross-tier: platform_users + plans live on controlDb; apps count comes
    // from user_app_index (cross-region — counts a user's apps in all regions,
    // not just this region's runtime DB).
    const planCheck = await app.controlDb.query(
      `SELECT p.max_projects
       FROM platform_users pu
       JOIN plans p ON pu.plan_id = p.id
       WHERE pu.id = $1`,
      [ownerId]
    );
    const appsCountResult = await app.controlDb.query(
      `SELECT COUNT(app_id)::int AS current_projects FROM user_app_index WHERE user_id = $1`,
      [ownerId]
    );
    const limitCheck = {
      rows: planCheck.rows.length > 0
        ? [{ max_projects: planCheck.rows[0].max_projects, current_projects: appsCountResult.rows[0]?.current_projects ?? 0 }]
        : [],
    };

    if (limitCheck.rows.length > 0) {
      const { max_projects, current_projects } = limitCheck.rows[0];
      if (max_projects !== -1 && current_projects >= max_projects) {
        return reply.code(403).send(quotaErrors.projectLimitReached(current_projects, max_projects));
      }
    }

    // Default subdomain to name with underscores replaced by hyphens
    let subdomain = requestedSubdomain ?? name.replace(/_/g, '-');

    // Check subdomain uniqueness — auto-suffix with a butter-themed word if taken
    const existing = await app.controlDb.query(
      `SELECT app_id FROM user_app_index WHERE subdomain = $1`,
      [subdomain]
    );
    if (existing.rows.length > 0) {
      if (requestedSubdomain) {
        // User explicitly chose this subdomain — don't auto-change it
        return reply.code(409).send({
          error: `Subdomain "${subdomain}" is already taken. Choose a different subdomain.`,
        });
      }
      // Auto-suffix with a butter-themed word
      const butterWords = [
        'churn', 'cream', 'golden', 'toast', 'melt', 'spread', 'swirl',
        'whip', 'fresh', 'smooth', 'rich', 'silky', 'salted', 'sweet',
        'churned', 'drizzle', 'flaky', 'crisp', 'warm', 'glazed',
      ];
      const word = butterWords[Math.floor(Math.random() * butterWords.length)];
      subdomain = `${subdomain}-${word}`;

      // If still taken (unlikely), add a short random number
      const stillTaken = await app.controlDb.query(
        `SELECT app_id FROM user_app_index WHERE subdomain = $1`,
        [subdomain]
      );
      if (stillTaken.rows.length > 0) {
        subdomain = `${subdomain}-${Math.floor(Math.random() * 900 + 100)}`;
      }
    }

    const appId = generateAppId();

    const { app: appRow, isExisting } = await insertAppRow(
      provisionRegion, app.controlDb, name, ownerId, appId
    );

    if (isExisting) {
      const existingSubdomain = (appRow as any).subdomain ?? name.replace(/_/g, '-');
      return reply.code(200).send({
        app_id: appRow.id,
        name: appRow.name,
        db_provisioned: appRow.db_provisioned,
        provisioning_status: (appRow as any).provisioning_status,
        api_url: `${config.apiBaseUrl}/v1/${appRow.id}`,
        subdomain: existingSubdomain,
        url: `https://${existingSubdomain}.${config.subdomain.baseDomain}`,
        created_at: appRow.created_at.toISOString(),
      });
    }

    // Set subdomain on the app row
    await app.runtimeDb(region).query(
      `UPDATE apps SET subdomain = $1 WHERE id = $2`,
      [subdomain, appId]
    );

    await addUserAppIndex(app.controlDb, {
      userId: ownerId,
      appId,
      region: provisionRegion,
      subdomain,
      appName: name,
    }).catch((err) => app.log.warn({ err, appId }, 'user_app_index add failed; backfill will repair'));

    if (config.neon.enabled) {
      // Enqueue to task queue — worker serializes Neon API calls
      await app.runtimeDb(region).query(
        `INSERT INTO neon_tasks (app_id, task_type)
         VALUES ($1, 'provision')
         ON CONFLICT DO NOTHING`,
        [appId]
      );
    } else {
      // Local dev: provision inline (no Neon contention)
      setImmediate(() => {
        provisionAppBackground(provisionRegion, app.controlDb, app.dataPlaneDb, appId)
          .catch(err => app.log.error({ err, appId }, 'Background provisioning failed'));
      });
    }

    // Template deployment is independent of Neon — always fire and forget
    setImmediate(() => {
      DeploymentService.deployTemplatePage(app.controlDb, appId, subdomain, name, ownerId)
        .then(async (cfProjectName) => {
          await app.runtimeDb(region).query(
            `UPDATE apps SET cloudflare_project_name = $1 WHERE id = $2`,
            [cfProjectName, appId]
          );
        })
        .catch(err => app.log.warn({ err, appId }, 'Template deployment failed'));
    });

    logFromRequest(request, {
      appId,
      category: 'admin',
      eventType: 'app.create',
      action: 'create',
      resourceType: 'app',
      resourceId: appId,
      eventData: { name, subdomain, owner_id: ownerId },
      success: true,
    });

    return reply.code(201).send({
      app_id: appId,
      name,
      db_provisioned: false,
      provisioning_status: 'provisioning',
      api_url: `${config.apiBaseUrl}/v1/${appId}`,
      subdomain,
      url: `https://${subdomain}.${config.subdomain.baseDomain}`,
      created_at: new Date().toISOString(),
      _meta: {
        next_actions: [
          { action: 'poll_status', description: 'Poll GET /apps/:app_id/status until provisioning_status is "ready"', recommended: true },
          { action: 'apply_schema', description: 'Define your database tables (after provisioning completes)', recommended: true },
        ],
      },
    });
  });

  app.delete('/apps/:app_id', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    // Look up the app's home region + owner from the cross-region index.
    const idx = await app.controlDb.query<{ region: string; user_id: string }>(
      `SELECT region, user_id FROM user_app_index WHERE app_id = $1`,
      [app_id]
    );
    if (idx.rows.length === 0) {
      return reply.code(404).send({ error: 'App not found' });
    }
    const region = idx.rows[0].region;
    const indexedUserId = idx.rows[0].user_id;
    const callerUserId = requireUserId(request);
    // Ownership check via the cross-region index (apps row may be missing
    // in the orphan-cleanup path — see below).
    if (indexedUserId !== callerUserId) {
      return reply.code(403).send({ error: 'Forbidden: You do not own this app' });
    }

    const appResult = await app.runtimeDb(region).query(
      'SELECT id, db_name, owner_id FROM apps WHERE id = $1',
      [app_id]
    );

    // Orphan-cleanup path: user_app_index pointed somewhere but the apps row
    // is gone (prior deprovision deleted it; the safety-net index cleanup
    // failed). Just remove the index entry and return success — no Neon DB,
    // no Cloudflare resources, no neon_tasks queue entry to enqueue.
    if (appResult.rows.length === 0) {
      await removeUserAppIndex(app.controlDb, app_id).catch((err) =>
        app.log.warn({ err, app_id }, 'orphan user_app_index remove failed'),
      );
      logFromRequest(request, {
        appId: app_id,
        category: 'admin',
        eventType: 'app.delete',
        action: 'delete',
        resourceType: 'app',
        resourceId: app_id,
        eventData: { mode: 'orphan_cleanup' },
        success: true,
      });
      return reply.code(202).send({ message: 'Orphan index cleaned up', app_id });
    }

    const appData = appResult.rows[0];
    // Defensive: re-check ownership against the runtime apps row in case
    // user_app_index drifted from apps.owner_id mid-flight.
    if (appData.owner_id !== callerUserId) {
      return reply.code(403).send({ error: 'Forbidden: You do not own this app' });
    }

    // Mark app as deleting immediately
    await app.runtimeDb(region).query(
      `UPDATE apps SET provisioning_status = 'deleting', updated_at = now() WHERE id = $1`,
      [app_id]
    );

    // Remove from index early so dashboard reflects deletion immediately (idempotent)
    await removeUserAppIndex(app.controlDb, app_id)
      .catch((err) => app.log.warn({ err, app_id }, 'user_app_index remove failed; orphan reaper will clean'));

    // Run fast, non-Neon cleanup inline (Cloudflare + Redis)
    const cleanupTasks: Promise<void>[] = [];

    if (config.cloudflare.enabled) {
      cleanupTasks.push(
        DeploymentService.deleteAppCloudflareResources(app.controlDb, app_id)
          .catch(error => app.log.warn({ error, app_id }, 'Failed to clean up Cloudflare resources'))
      );
    }

    cleanupTasks.push(purgeAppUsage(app_id).then(() => {}));
    await Promise.all(cleanupTasks);

    if (config.neon.enabled) {
      // Enqueue Neon DB deletion — worker handles it + final app row delete
      await app.runtimeDb(region).query(
        `INSERT INTO neon_tasks (app_id, task_type)
         VALUES ($1, 'deprovision')
         ON CONFLICT DO NOTHING`,
        [app_id]
      );

      logFromRequest(request, {
        appId: app_id,
        category: 'admin',
        eventType: 'app.delete',
        action: 'delete',
        resourceType: 'app',
        resourceId: app_id,
        eventData: { db_name: appData.db_name, mode: 'async' },
        success: true,
      });

      return reply.code(202).send({
        message: 'App deletion started',
        app_id,
      });
    }

    // Local dev: delete inline (fast, no contention)
    const dbName = appData.db_name;
    await app.dataPlaneDb.query(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => {});
    await app.runtimeDb(region).query('DELETE FROM apps WHERE id = $1', [app_id]);

    logFromRequest(request, {
      appId: app_id,
      category: 'admin',
      eventType: 'app.delete',
      action: 'delete',
      resourceType: 'app',
      resourceId: app_id,
      eventData: { db_name: dbName, mode: 'inline' },
      success: true,
    });

    return reply.send({
      message: 'App deleted successfully',
      app_id,
      db_name: appData.db_name,
    });
  });
}
