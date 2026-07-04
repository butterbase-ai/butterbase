// Custom domain management routes (Cloudflare for SaaS)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppResolver } from '../services/app-resolver.js';
import { createAgentError, getDocUrl, isHttpError } from '../services/error-handler.js';
import {
  RESOURCE_NOT_FOUND,
  RESOURCE_ALREADY_EXISTS,
  EXTERNAL_CLOUDFLARE_ERROR,
  AUTH_INSUFFICIENT_PERMISSIONS,
  VALIDATION_INVALID_SCHEMA,
} from '@butterbase/shared/error-types';
import { config } from '../config.js';
import { resolveAppHomeRegion } from '../services/region-resolver.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import { requireUserId } from '../utils/require-auth.js';
import { quotaErrors } from '../utils/quota-errors.js';
import { logFromRequest } from '../services/audit/with-audit.js';
import * as CustomHostnames from '../services/cloudflare-custom-hostnames.js';
import { writeDomainMapping, deleteDomainMapping } from '../services/cloudflare-wfp.js';

const addDomainSchema = z.object({
  hostname: z
    .string()
    .min(4)
    .max(255)
    .transform((h) => h.toLowerCase().trim())
    .refine((h) => !h.includes('://'), { message: 'Hostname must not include a protocol (http:// or https://)' })
    .refine((h) => !h.endsWith('.'), { message: 'Hostname must not end with a trailing dot' })
    .refine((h) => h.includes('.'), { message: 'Hostname must include at least one dot (e.g. app.example.com)' })
    .refine((h) => !h.endsWith(`.${config.subdomain.baseDomain}`), {
      message: `Cannot add a subdomain of ${config.subdomain.baseDomain} as a custom domain`,
    })
    .refine((h) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h), {
      message: 'Hostname contains invalid characters',
    }),
  // 'http' (default): CF auto-validates via an HTTP challenge served from our zone.
  // 'txt': CF emits a TXT record the customer drops in their DNS. Required for any
  // apex domain whose DNS is on Cloudflare (CNAME flattening + orange-cloud intercept
  // make HTTP DCV impossible there); also works in every other case.
  validation_method: z.enum(['http', 'txt']).optional().default('http'),
});

const CNAME_TARGET = config.cloudflare.customHostnameFallbackOrigin;

export async function customDomainRoutes(fastify: FastifyInstance) {
  const { controlDb } = fastify;

  // ── Add custom domain ──────────────────────────────────────────────
  fastify.post('/v1/:appId/custom-domains', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);
    await AppResolver.resolveApp(controlDb, appId, userId, request.auth?.organizationId ?? null);
    const region = await resolveAppHomeRegion(controlDb, appId);
    const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

    // Plan gate — platform_users + plans live on controlDb
    const planResult = await controlDb.query(
      `SELECT p.features FROM platform_users pu
       JOIN organizations o ON o.id = pu.personal_organization_id
       JOIN plans p ON p.id = o.plan_id
       WHERE pu.id = $1`,
      [userId],
    );
    const features = (planResult.rows[0]?.features as Record<string, unknown>) || {};
    if (!features.custom_domain) {
      return reply.status(403).send(quotaErrors.featureNotAvailable('custom_domain'));
    }

    // WfP backend required — apps is a runtime table
    const backendResult = await runtimeDb.query(
      'SELECT deployment_backend FROM apps WHERE id = $1',
      [appId],
    );
    if (backendResult.rows[0]?.deployment_backend !== 'wfp') {
      return reply.status(400).send(
        createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: 'Custom domains are only supported on the Workers for Platforms deployment backend.',
          remediation: 'Migrate your app to the WfP backend before adding a custom domain.',
        }),
      );
    }

    // Cloudflare must be enabled
    if (!config.cloudflare.enabled) {
      return reply.status(503).send(
        createAgentError({
          code: EXTERNAL_CLOUDFLARE_ERROR,
          message: 'Cloudflare is not configured on this instance.',
          remediation: 'Contact the platform administrator to configure Cloudflare credentials.',
          documentation_url: getDocUrl(EXTERNAL_CLOUDFLARE_ERROR),
        }),
      );
    }

    const body = addDomainSchema.parse(request.body);
    const { hostname, validation_method } = body;

    // Check hostname uniqueness in our DB — app_custom_domains is a runtime table
    const existing = await runtimeDb.query(
      'SELECT id, app_id FROM app_custom_domains WHERE hostname = $1',
      [hostname],
    );
    if (existing.rows.length > 0) {
      return reply.status(409).send(
        createAgentError({
          code: RESOURCE_ALREADY_EXISTS,
          message: `The hostname "${hostname}" is already registered.`,
          remediation:
            existing.rows[0].app_id === appId
              ? 'This domain is already attached to this app. Use the status endpoint to check its verification progress.'
              : 'This hostname is claimed by another app. Use a different hostname.',
        }),
      );
    }

    // Create custom hostname in Cloudflare
    let cfResult: CustomHostnames.CustomHostnameResult;
    try {
      cfResult = await CustomHostnames.createCustomHostname(hostname, validation_method);
    } catch (error) {
      if (isHttpError(error)) throw error;
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(502).send(
        createAgentError({
          code: EXTERNAL_CLOUDFLARE_ERROR,
          message: `Failed to register custom hostname with Cloudflare: ${message}`,
          remediation: 'Retry the request. If the problem persists, the hostname may be blocked or restricted by Cloudflare.',
          documentation_url: getDocUrl(EXTERNAL_CLOUDFLARE_ERROR),
        }),
      );
    }

    // Insert into DB — app_custom_domains is a runtime table
    const insertResult = await runtimeDb.query(
      `INSERT INTO app_custom_domains
        (app_id, hostname, cf_custom_hostname_id, status, ssl_status, verification_type, verification_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        appId,
        hostname,
        cfResult.id,
        cfResult.status || 'pending',
        cfResult.ssl?.status || 'pending',
        cfResult.ownership_verification?.type ?? null,
        cfResult.ownership_verification?.value ?? null,
      ],
    );

    // Write KV mapping so the dispatch worker can route to this app
    try {
      await writeDomainMapping(hostname, appId, region);
    } catch (error) {
      if (isHttpError(error)) throw error;
      // Non-fatal: domain is registered but won't route until KV is written.
      // Status endpoint can detect and retry.
      fastify.log.warn({ hostname, appId, error }, 'Failed to write KV domain mapping');
    }

    logFromRequest(request, {
      appId,
      category: 'admin',
      eventType: 'custom_domain.add',
      action: 'create',
      resourceType: 'custom_domain',
      resourceId: insertResult.rows[0].id,
      eventData: { hostname },
      success: true,
    });

    const txtValidationRecord = cfResult.ssl?.validation_records?.find(
      (r) => r.txt_name && r.txt_value,
    );
    const instructions =
      validation_method === 'txt'
        ? [
            `Add the following records at your DNS provider:`,
            ``,
            `  1. CNAME (routing):`,
            `       ${hostname}  CNAME  ${CNAME_TARGET}`,
            `     If apex on Cloudflare, an "A/AAAA" or "CNAME flattened" record at the root is fine; the TXT below is what authorizes the cert.`,
            ``,
            txtValidationRecord
              ? `  2. TXT (SSL validation):\n       ${txtValidationRecord.txt_name}  TXT  ${txtValidationRecord.txt_value}`
              : `  2. TXT (SSL validation): Cloudflare will issue the TXT record details on the status endpoint shortly — call GET /v1/${appId}/custom-domains/${insertResult.rows[0].id}/status to fetch them.`,
            cfResult.ownership_verification
              ? `\n  3. Ownership TXT (Cloudflare-proxied zones only):\n       ${cfResult.ownership_verification.name}  ${cfResult.ownership_verification.type.toUpperCase()}  ${cfResult.ownership_verification.value}`
              : ``,
            ``,
            `TXT validation works in every case, including apex domains on a Cloudflare-proxied zone.`,
          ].join('\n')
        : `Add a CNAME record at your DNS provider:\n  ${hostname}  CNAME  ${CNAME_TARGET}\n\nIf your DNS is managed by Cloudflare, set the record to DNS-only (grey cloud, not proxied).\nCloudflare will automatically validate ownership and issue an SSL certificate once the CNAME is active.\n\nNote: HTTP validation does NOT work for apex domains whose DNS is on Cloudflare. For that case, re-add the domain with validation_method: "txt".`;

    return reply.status(201).send({
      domain: insertResult.rows[0],
      cname_target: CNAME_TARGET,
      validation_method,
      verification_records: cfResult.ssl?.validation_records ?? [],
      ownership_verification: cfResult.ownership_verification ?? null,
      instructions,
    });
  });

  // ── List custom domains ────────────────────────────────────────────
  fastify.get('/v1/:appId/custom-domains', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);
    await AppResolver.resolveApp(controlDb, appId, userId, request.auth?.organizationId ?? null);
    const region = await resolveAppHomeRegion(controlDb, appId);
    const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

    // app_custom_domains is a runtime table
    const result = await runtimeDb.query(
      'SELECT * FROM app_custom_domains WHERE app_id = $1 ORDER BY created_at ASC',
      [appId],
    );

    return reply.send({
      domains: result.rows,
      cname_target: CNAME_TARGET,
    });
  });

  // ── Get domain status (refreshes from CF) ──────────────────────────
  fastify.get('/v1/:appId/custom-domains/:domainId/status', async (request, reply) => {
    const { appId, domainId } = request.params as { appId: string; domainId: string };
    const userId = requireUserId(request);
    await AppResolver.resolveApp(controlDb, appId, userId, request.auth?.organizationId ?? null);
    const region = await resolveAppHomeRegion(controlDb, appId);
    const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

    // app_custom_domains is a runtime table
    const domainResult = await runtimeDb.query(
      'SELECT * FROM app_custom_domains WHERE id = $1 AND app_id = $2',
      [domainId, appId],
    );
    if (domainResult.rows.length === 0) {
      return reply.status(404).send(
        createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'Custom domain not found.',
          remediation: 'Check the domain ID and app ID.',
        }),
      );
    }

    const domain = domainResult.rows[0];

    // If we have a CF ID, fetch fresh status
    if (domain.cf_custom_hostname_id) {
      try {
        const cfStatus = await CustomHostnames.getCustomHostname(domain.cf_custom_hostname_id);
        // app_custom_domains is a runtime table
        await runtimeDb.query(
          `UPDATE app_custom_domains
           SET status = $1, ssl_status = $2, verification_errors = $3, updated_at = now()
           WHERE id = $4`,
          [
            cfStatus.status,
            cfStatus.ssl?.status || domain.ssl_status,
            cfStatus.verification_errors ? JSON.stringify(cfStatus.verification_errors) : null,
            domainId,
          ],
        );

        return reply.send({
          domain: {
            ...domain,
            status: cfStatus.status,
            ssl_status: cfStatus.ssl?.status || domain.ssl_status,
            verification_errors: cfStatus.verification_errors || null,
          },
          cname_target: CNAME_TARGET,
          verification_records: cfStatus.ssl?.validation_records ?? [],
          ownership_verification: cfStatus.ownership_verification ?? null,
        });
      } catch (error) {
        if (isHttpError(error)) throw error;
        // If CF fetch fails, return what we have in the DB
        fastify.log.warn({ domainId, error }, 'Failed to refresh custom hostname status from CF');
      }
    }

    return reply.send({
      domain,
      cname_target: CNAME_TARGET,
    });
  });

  // ── Verify (re-trigger validation) ─────────────────────────────────
  fastify.post('/v1/:appId/custom-domains/:domainId/verify', async (request, reply) => {
    const { appId, domainId } = request.params as { appId: string; domainId: string };
    const userId = requireUserId(request);
    await AppResolver.resolveApp(controlDb, appId, userId, request.auth?.organizationId ?? null);
    const region = await resolveAppHomeRegion(controlDb, appId);
    const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

    // app_custom_domains is a runtime table
    const domainResult = await runtimeDb.query(
      'SELECT * FROM app_custom_domains WHERE id = $1 AND app_id = $2',
      [domainId, appId],
    );
    if (domainResult.rows.length === 0) {
      return reply.status(404).send(
        createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'Custom domain not found.',
          remediation: 'Check the domain ID and app ID.',
        }),
      );
    }

    const domain = domainResult.rows[0];
    if (!domain.cf_custom_hostname_id) {
      return reply.status(400).send(
        createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: 'This domain has no Cloudflare custom hostname ID. It may not have been registered correctly.',
          remediation: 'Delete and re-add the domain.',
        }),
      );
    }

    try {
      // Preserve the SSL method the customer originally chose (http vs txt).
      // Fetching first costs one extra GET but avoids silently downgrading a
      // txt-validated domain back to http on every refresh.
      let currentMethod: CustomHostnames.SslValidationMethod = 'http';
      try {
        const current = await CustomHostnames.getCustomHostname(domain.cf_custom_hostname_id);
        if (current.ssl?.method === 'txt' || current.ssl?.method === 'http') {
          currentMethod = current.ssl.method;
        }
      } catch {
        // Fall through with default 'http' — refresh will re-error and surface to caller.
      }
      const cfResult = await CustomHostnames.refreshCustomHostname(
        domain.cf_custom_hostname_id,
        currentMethod,
      );

      // app_custom_domains is a runtime table
      await runtimeDb.query(
        `UPDATE app_custom_domains
         SET status = $1, ssl_status = $2, verification_errors = $3, updated_at = now()
         WHERE id = $4`,
        [
          cfResult.status,
          cfResult.ssl?.status || domain.ssl_status,
          cfResult.verification_errors ? JSON.stringify(cfResult.verification_errors) : null,
          domainId,
        ],
      );

      return reply.send({
        domain: {
          ...domain,
          status: cfResult.status,
          ssl_status: cfResult.ssl?.status || domain.ssl_status,
          verification_errors: cfResult.verification_errors || null,
        },
        cname_target: CNAME_TARGET,
        verification_records: cfResult.ssl?.validation_records ?? [],
      });
    } catch (error) {
      if (isHttpError(error)) throw error;
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(502).send(
        createAgentError({
          code: EXTERNAL_CLOUDFLARE_ERROR,
          message: `Failed to refresh verification: ${message}`,
          remediation: 'Retry the request.',
          documentation_url: getDocUrl(EXTERNAL_CLOUDFLARE_ERROR),
        }),
      );
    }
  });

  // ── Delete custom domain ───────────────────────────────────────────
  fastify.delete('/v1/:appId/custom-domains/:domainId', async (request, reply) => {
    const { appId, domainId } = request.params as { appId: string; domainId: string };
    const userId = requireUserId(request);
    await AppResolver.resolveApp(controlDb, appId, userId, request.auth?.organizationId ?? null);
    const region = await resolveAppHomeRegion(controlDb, appId);
    const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

    // app_custom_domains is a runtime table
    const domainResult = await runtimeDb.query(
      'SELECT * FROM app_custom_domains WHERE id = $1 AND app_id = $2',
      [domainId, appId],
    );
    if (domainResult.rows.length === 0) {
      return reply.status(404).send(
        createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'Custom domain not found.',
          remediation: 'Check the domain ID and app ID.',
        }),
      );
    }

    const domain = domainResult.rows[0];

    // Delete from Cloudflare (best-effort)
    if (domain.cf_custom_hostname_id) {
      try {
        await CustomHostnames.deleteCustomHostname(domain.cf_custom_hostname_id);
      } catch (error) {
        if (isHttpError(error)) throw error;
        fastify.log.warn({ domainId, error }, 'Failed to delete CF custom hostname (continuing with local cleanup)');
      }
    }

    // Delete KV mapping (best-effort)
    try {
      await deleteDomainMapping(domain.hostname);
    } catch (error) {
      if (isHttpError(error)) throw error;
      fastify.log.warn({ hostname: domain.hostname, error }, 'Failed to delete KV domain mapping');
    }

    // Delete from DB — app_custom_domains is a runtime table
    await runtimeDb.query('DELETE FROM app_custom_domains WHERE id = $1', [domainId]);

    logFromRequest(request, {
      appId,
      category: 'admin',
      eventType: 'custom_domain.remove',
      action: 'delete',
      resourceType: 'custom_domain',
      resourceId: domainId,
      eventData: { hostname: domain.hostname },
      success: true,
    });

    return reply.send({ deleted: true });
  });
}
