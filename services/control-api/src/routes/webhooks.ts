// services/control-api/src/routes/webhooks.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as CloudflarePages from '../services/cloudflare-pages.js';
import { handleWebhook } from '../services/webhook-handler.js';
import { config } from '../config.js';

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

      // FIXME(batch-9.7): handleWebhook uses a single transaction spanning processed_webhook_events (platform)
      // and app_deployments/apps (runtime). Split into two-phase commit or move idempotency to controlDb
      // and runtime writes to runtimeDb in a separate step.
      await handleWebhook(
        controlDb,
        'cloudflare',
        body.deployment_id,
        body.type,
        async (client) => {
          // Map Cloudflare event type to our status
          let status: string | null = null;
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

          if (!status) {
            return;
          }

          // Find deployment by Cloudflare deployment ID
          const deploymentResult = await client.query(
            `SELECT id, app_id, status FROM app_deployments
             WHERE cloudflare_deployment_id = $1`,
            [body.deployment_id]
          );

          if (deploymentResult.rows.length === 0) {
            console.error(`[Webhook] Deployment not found for Cloudflare ID: ${body.deployment_id}`);
            return;
          }

          const deployment = deploymentResult.rows[0];

          // Update deployment record
          await client.query(
            `UPDATE app_deployments
             SET status = $1,
                 error_message = $2,
                 deployment_url = COALESCE($3, deployment_url),
                 completed_at = CASE WHEN $1 IN ('READY', 'ERROR', 'CANCELED') THEN now() ELSE completed_at END,
                 updated_at = now()
             WHERE id = $4`,
            [status, errorMessage, body.url, deployment.id]
          );

          // Update apps table if deployment succeeded
          if (status === 'READY' && body.url) {
            await client.query(
              `UPDATE apps
               SET deployment_url = $1, last_deployed_at = now()
               WHERE id = $2`,
              [body.url, deployment.app_id]
            );
          }

          console.log(`[Webhook] Updated deployment ${deployment.id} to status ${status}`);
        }
      );

      return reply.send({ received: true });
    } catch (error) {
      console.error('[Webhook] Error processing Cloudflare webhook:', error);
      return reply.status(500).send({ error: 'Failed to process webhook' });
    }
  });
}
