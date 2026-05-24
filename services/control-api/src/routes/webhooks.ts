// services/control-api/src/routes/webhooks.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as CloudflarePages from '../services/cloudflare-pages.js';
import { handleWebhook } from '../services/webhook-handler.js';
import { config } from '../config.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';

const cloudflareWebhookSchema = z.object({
  type: z.string(),
  deployment_id: z.string(),
  project_name: z.string().optional(),
  url: z.string().optional(),
  status: z.string().optional(),
  error: z.string().optional(),
});

export async function registerWebhookRoutes(fastify: FastifyInstance) {
  const { controlDb } = fastify;

  // Cloudflare Pages webhook
  fastify.post('/v1/webhooks/cloudflare', async (request, reply) => {
    const signature = request.headers['x-cloudflare-signature'] as string;
    const webhookSecret = process.env.CLOUDFLARE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error('[Webhook] CLOUDFLARE_WEBHOOK_SECRET not configured');
      return reply.status(500).send({ error: 'Webhook secret not configured' });
    }

    // Verify signature
    const payload = JSON.stringify(request.body);
    const isValid = CloudflarePages.verifyWebhookSignature(payload, signature, webhookSecret);

    if (!isValid) {
      console.error('[Webhook] Invalid Cloudflare webhook signature');
      return reply.status(401).send({ error: 'Invalid signature' });
    }

    try {
      const body = cloudflareWebhookSchema.parse(request.body);

      // Phase 1 (controlDb transaction inside handleWebhook): idempotency + resolve
      // (app_id, region) for this Cloudflare deployment. Phase 2 (after commit) runs
      // SELECT/UPDATE app_deployments + UPDATE apps on the resolved runtime DB in a
      // single runtime transaction.
      //
      // If Phase 2 fails after Phase 1 commits, the event is marked processed on
      // controlDb (idempotency) but the runtime state is stale. Cross-tier 2PC is
      // intentionally not implemented; loud structured log + manual reconciliation
      // is the recovery contract.
      const route: { value: {
        appId: string;
        region: string;
        status: 'READY' | 'ERROR' | 'CANCELED';
        errorMessage: string | null;
        url: string | undefined;
      } | null } = { value: null };

      await handleWebhook(
        controlDb,
        'cloudflare',
        body.deployment_id,
        body.type,
        async (client) => {
          let status: 'READY' | 'ERROR' | 'CANCELED' | null = null;
          let errorMessage: string | null = null;

          switch (body.type) {
            case 'deployment.succeeded':
              status = 'READY';
              break;
            case 'deployment.failed':
              status = 'ERROR';
              errorMessage = body.error || 'Deployment failed';
              break;
            case 'deployment.canceled':
              status = 'CANCELED';
              break;
            default:
              console.log(`[Webhook] Unhandled Cloudflare event type: ${body.type}`);
              return;
          }

          // Resolve routing — try the new index first, fall back to legacy controlDb
          // app_deployments JOIN user_app_index for any in-flight pre-cutover deploys.
          const idx = await client.query<{ app_id: string; region: string }>(
            `SELECT app_id, region FROM cloudflare_deployment_index WHERE cloudflare_deployment_id = $1`,
            [body.deployment_id]
          );

          let appId: string | null = null;
          let region: string | null = null;
          if (idx.rows.length > 0) {
            appId = idx.rows[0].app_id;
            region = idx.rows[0].region;
          } else {
            const fb = await client.query<{ app_id: string; region: string | null }>(
              `SELECT ad.app_id, uai.region
                 FROM app_deployments ad
                 LEFT JOIN user_app_index uai ON uai.app_id = ad.app_id
                WHERE ad.cloudflare_deployment_id = $1`,
              [body.deployment_id]
            );
            if (fb.rows.length === 0) {
              console.error(
                { cfDeploymentId: body.deployment_id, type: body.type },
                '[Webhook] No routing entry in cloudflare_deployment_index or legacy app_deployments — dropping webhook'
              );
              return;
            }
            appId = fb.rows[0].app_id;
            region = fb.rows[0].region ?? 'us-east-1';
          }

          route.value = {
            appId,
            region,
            status,
            errorMessage,
            url: body.url,
          };
        }
      );

      // Phase 2: single runtime transaction at the resolved region.
      if (route.value) {
        const r = route.value;
        try {
          const runtimePool = getRuntimeDbPool(config.runtimeDb, r.region);
          const rtClient = await runtimePool.connect();
          try {
            await rtClient.query('BEGIN');

            const dep = await rtClient.query<{ id: string; app_id: string }>(
              `SELECT id, app_id FROM app_deployments WHERE cloudflare_deployment_id = $1`,
              [body.deployment_id]
            );

            if (dep.rows.length === 0) {
              await rtClient.query('ROLLBACK');
              console.error(
                { cfDeploymentId: body.deployment_id, region: r.region, appId: r.appId },
                '[Webhook] Phase 2: runtime app_deployments row not found at resolved region'
              );
            } else {
              await rtClient.query(
                `UPDATE app_deployments
                 SET status = $1,
                     error_message = $2,
                     deployment_url = COALESCE($3, deployment_url),
                     completed_at = CASE WHEN $1 IN ('READY', 'ERROR', 'CANCELED') THEN now() ELSE completed_at END,
                     updated_at = now()
                 WHERE id = $4`,
                [r.status, r.errorMessage, r.url, dep.rows[0].id]
              );

              if (r.status === 'READY' && r.url) {
                await rtClient.query(
                  `UPDATE apps SET deployment_url = $1, last_deployed_at = now() WHERE id = $2`,
                  [r.url, dep.rows[0].app_id]
                );
              }

              await rtClient.query('COMMIT');
              console.log(`[Webhook] Updated deployment ${dep.rows[0].id} to status ${r.status}`);
            }
          } catch (txErr) {
            await rtClient.query('ROLLBACK').catch(() => { /* swallow rollback failures */ });
            throw txErr;
          } finally {
            rtClient.release();
          }
        } catch (err) {
          console.error(
            { err, appId: r.appId, region: r.region, cfDeploymentId: body.deployment_id, status: r.status, url: r.url },
            '[Webhook] Phase 2 runtime transaction failed after Phase 1 commit — manual reconciliation needed'
          );
        }
      }

      return reply.send({ received: true });
    } catch (error) {
      console.error('[Webhook] Failed to process Cloudflare webhook:', error);
      return reply.status(500).send({
        error: 'Webhook processing failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}
