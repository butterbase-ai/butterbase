import type { FastifyInstance } from 'fastify';
import { config, assertRegionConfig } from '../config.js';
import { provisionApp, generateAppId, insertAppRow, provisionAppBackground } from '../services/provisioner.js';
import * as DeploymentService from '../services/deployment.service.js';
import { purgeAppUsage } from '../services/usage-metering.js';
import { requireUserId } from '../utils/require-auth.js';
import { quotaErrors } from '../utils/quota-errors.js';
import { logFromRequest } from '../services/audit/with-audit.js';
import { getDataProjectIdForRegion } from '../services/neon-projects.js';
import { addOrgAppIndex, removeOrgAppIndex, listUserApps } from '../services/org-app-index.js';
import { resolveOrganizationId, assertOrgMember } from '../services/org-resolver.js';
import { checkProjectQuota } from '../services/project-quota.js';
import { AppResolver, AppNotFoundError } from '../services/app-resolver.js';

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
      organization_id: {
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
    // Scope to the caller's active org (Plan 07 org-scoped auth):
    //   - bb_sk_* API keys carry their own organization_id → that's the scope.
    //   - JWT callers may set x-organization-id (populated on request.auth) to
    //     pick an org they belong to; otherwise fall back to the personal org.
    // Cross-org apps are only visible with a key/session scoped to that org —
    // this preserves the per-key strict scoping model.
    const activeOrgId = request.auth?.organizationId
      ?? await resolveOrganizationId(app.controlDb, ownerId);
    const indexRows = await listUserApps(app.controlDb, activeOrgId);
    if (indexRows.length === 0) return { apps: [] };


    // Fetch runtime rows for the exact app-ids resolved by the org-scoped
    // org_app_index — do NOT re-filter by owner_id, since org-shared apps
    // are owned by the org's owner, not the caller. Group by region.
    const idsByRegion = new Map<string, string[]>();
    for (const r of indexRows) {
      const list = idsByRegion.get(r.region) ?? [];
      list.push(r.app_id);
      idsByRegion.set(r.region, list);
    }
    const allRows: any[] = [];
    for (const [region, appIds] of idsByRegion) {
      const { rows } = await app.runtimeDb(region).query(
        'SELECT id, name, subdomain, db_name, db_provisioned, provisioning_status, region, visibility, listed, template_source_app_id, fork_count, substrate_organization_id, substrate_autopropagate, created_at FROM apps WHERE id = ANY($1::text[]) ORDER BY created_at DESC',
        [appIds]
      );
      allRows.push(...rows);
    }
    allRows.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
    return { apps: allRows };
  });

  app.get('/apps/:app_id/status', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const ownerId = requireUserId(request);

    // Org-aware auth check
    try {
      await AppResolver.resolveApp(app.controlDb, app_id, ownerId, request.auth?.organizationId ?? null);
    } catch (err) {
      if (err instanceof AppNotFoundError) {
        return reply.code(404).send({ code: 'RESOURCE_NOT_FOUND', message: `App "${app_id}" not found` });
      }
      throw err;
    }

    // We know the app exists and user has access — get the region to query status
    // — the runtime apps row lives in that region's DB only.
    const idx = await app.controlDb.query<{ region: string }>(
      `SELECT region FROM org_app_index WHERE app_id = $1`,
      [app_id]
    );
    if (idx.rows.length === 0) {
      return reply.code(404).send({ code: 'RESOURCE_NOT_FOUND', message: `App "${app_id}" not found` });
    }
    const region = idx.rows[0].region;

    const { rows } = await app.runtimeDb(region).query(
      `SELECT id, name, db_provisioned, provisioning_status, provisioning_error, created_at
       FROM apps WHERE id = $1`,
      [app_id]
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
    // Regions that accept NEW app provisioning. Defaults to allowedRegions
    // (BUTTERBASE_REGIONS gates both serving and provisioning). Setting
    // BUTTERBASE_PROVISION_ALLOWED_REGIONS to a subset (e.g. "us-west-2")
    // lets operators temporarily close a region to new writes without
    // breaking traffic to apps already homed there — needed when one
    // region has hit an infra ceiling (Neon's 500 databases-per-branch).
    const provisionAllowed = (
      process.env.BUTTERBASE_PROVISION_ALLOWED_REGIONS
        ?? process.env.BUTTERBASE_REGIONS
        ?? ''
    ).split(',').map((s) => s.trim()).filter(Boolean);
    const bodyRegion = (request.body as { region?: string } | undefined)?.region;
    const requestedRegion =
      bodyRegion ??
      process.env.BUTTERBASE_DEFAULT_REGION ??
      provisionAllowed[0] ??
      allowedRegions[0] ??
      'local';

    if (!allowedRegions.includes(requestedRegion)) {
      return reply.code(400).send({
        error: `Region "${requestedRegion}" is not in BUTTERBASE_REGIONS`,
        allowed: allowedRegions,
      });
    }
    // If the caller asked for a region that's temporarily closed to new
    // apps, silently redirect to the first open region rather than 400ing.
    // Dashboard/CLI flows often pin a region from the template's source and
    // failing them mid-hackathon is worse UX than a transparent move. The
    // response body doesn't currently expose region, so callers see nothing
    // surprising; we log the override so operators can audit it.
    let provisionRegion = requestedRegion;
    if (provisionAllowed.length > 0 && !provisionAllowed.includes(requestedRegion)) {
      const fallback = provisionAllowed[0];
      request.log.warn(
        { requestedRegion, provisionRegion: fallback, allowed: provisionAllowed },
        '[init] redirecting new app to open region',
      );
      provisionRegion = fallback;
    }
    try {
      getDataProjectIdForRegion(provisionRegion);
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }

    // Use authenticated user ID as owner
    const ownerId = requireUserId(request);
    // All per-app runtime writes happen in the TARGET region's runtime DB
    // (where the app is homed), not the local machine's. org_app_index on
    // the control DB is the cross-region map.
    const region = provisionRegion;

    // Resolve target org up-front so both quota + placement key on the same
    // subject. Precedence:
    //   1. Explicit body.organization_id — gated by membership check.
    //   2. Auth-bound org (bb_sk_* key's org, or JWT x-organization-id).
    //   3. Caller's personal org.
    const bodyOrgId = (request.body as { organization_id?: string }).organization_id;
    let orgId: string;
    if (bodyOrgId) {
      await assertOrgMember(app.controlDb, ownerId, bodyOrgId);
      orgId = bodyOrgId;
    } else {
      orgId = request.auth?.organizationId
        ?? await resolveOrganizationId(app.controlDb, ownerId);
    }

    // Enforce project limit against the TARGET org's plan (not the caller's
    // personal org). A user on playground personal can still create apps
    // in a team org up to that org's cap.
    const quota = await checkProjectQuota(app.controlDb, orgId);
    if (!quota.ok) {
      return reply.code(403).send(quotaErrors.projectLimitReached(quota.current, quota.limit));
    }

    // Default subdomain to name with underscores replaced by hyphens
    let subdomain = requestedSubdomain ?? name.replace(/_/g, '-');

    // Check subdomain uniqueness — auto-suffix with a butter-themed word if taken
    const existing = await app.controlDb.query(
      `SELECT app_id FROM org_app_index WHERE subdomain = $1`,
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
        `SELECT app_id FROM org_app_index WHERE subdomain = $1`,
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

    // orgId was resolved above (pre-quota-check); reuse it for placement.
    // NOTE: for now we only check membership, not per-key scope — a bb_sk_*
    // key can create an app in any org its owning user belongs to. Tighten
    // later if we want strict per-key org locking.
    await addOrgAppIndex(app.controlDb, {
      organizationId: orgId,
      appId,
      region: provisionRegion,
      subdomain,
      appName: name,
    }).catch((err) => app.log.warn({ err, appId }, 'org_app_index add failed; backfill will repair'));

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
    const callerUserId = requireUserId(request);

    // Org-aware auth + get region
    let region: string;
    try {
      await AppResolver.resolveApp(app.controlDb, app_id, callerUserId, request.auth?.organizationId ?? null);
      // Look up the app's home region from the cross-region index.
      const idx = await app.controlDb.query<{ region: string }>(
        `SELECT region FROM org_app_index WHERE app_id = $1`,
        [app_id]
      );
      if (idx.rows.length === 0) {
        return reply.code(404).send({ error: 'App not found' });
      }
      region = idx.rows[0].region;
    } catch (err) {
      if (err instanceof AppNotFoundError) return reply.code(404).send({ error: 'App not found' });
      throw err;
    }

    const appResult = await app.runtimeDb(region).query(
      'SELECT id, db_name, owner_id, template_source_app_id, template_source_region FROM apps WHERE id = $1',
      [app_id]
    );

    // Orphan-cleanup path: org_app_index pointed somewhere but the apps row
    // is gone (prior deprovision deleted it; the safety-net index cleanup
    // failed). Just remove the index entry and return success — no Neon DB,
    // no Cloudflare resources, no neon_tasks queue entry to enqueue.
    if (appResult.rows.length === 0) {
      await removeOrgAppIndex(app.controlDb, app_id).catch((err) =>
        app.log.warn({ err, app_id }, 'orphan org_app_index remove failed'),
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
    // AppResolver already verified access (owner or org member) — no second check needed.

    // Cross-region fork_count outbox: if this is a cloned app whose source lives
    // in a different region, queue a decrement for the sweeper. The intra-region
    // case is handled by the runtime-plane DELETE trigger (trg_apps_fork_count_delete).
    if (
      appData.template_source_app_id &&
      appData.template_source_region &&
      appData.template_source_region !== region
    ) {
      await app.controlDb
        .query(
          `INSERT INTO fork_count_decrements (source_app_id, source_region)
           VALUES ($1, $2)`,
          [appData.template_source_app_id, appData.template_source_region],
        )
        .catch((err) =>
          app.log.warn(
            { err, app_id, sourceAppId: appData.template_source_app_id, sourceRegion: appData.template_source_region },
            'fork_count_decrements insert failed; fork_count will be eventually consistent',
          ),
        );
    }

    // Mark app as deleting immediately
    await app.runtimeDb(region).query(
      `UPDATE apps SET provisioning_status = 'deleting', updated_at = now() WHERE id = $1`,
      [app_id]
    );

    // Remove from index early so dashboard reflects deletion immediately (idempotent)
    await removeOrgAppIndex(app.controlDb, app_id)
      .catch((err) => app.log.warn({ err, app_id }, 'org_app_index remove failed; orphan reaper will clean'));

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
