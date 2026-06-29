// services/control-api/src/routes/enrichlayer-webhook.ts
// Receiver for async EnrichLayer email-lookup callbacks.
//
// EnrichLayer POSTs to POST /v1/webhooks/enrichlayer/email?nonce=<nonce>
// when an async email lookup completes.  The nonce is the security gate —
// this route carries NO auth header by design.
//
// ALWAYS returns HTTP 200 (with a JSON body) so EnrichLayer stops retrying.
//   { ok: true }        — claim succeeded; credits charged, audit row written.
//   { ignored: true }   — unknown/already-claimed nonce, null body, or any error.
//
// Cross-region limitation (v1, Option C):
//   enrichlayer_email_lookups rows live in the runtime DB tier.  This receiver
//   queries only the first configured runtime region (listRuntimeRegions()[0]).
//   Multi-region dispatch will require a control-plane nonce index (Option B).
//
// Email-field fallback chain (vendor shape unverified against live traffic):
//   body.email → body.work_email → body.result.email → null
//
// Credit-cost source:
//   x-enrichlayer-credit-cost header (if present and finite >= 0)
//   → config.enrichlayer.emailLookupCredits (default: 1)

import type { FastifyInstance } from 'fastify';
import { listRuntimeRegions, runtimePoolFor } from '../services/runtime-pool-registry.js';
import { getEnrichLayerPricing } from '../services/enrichlayer/pricing.js';
import { deductCreditsBalance, incrementUsage } from '../services/usage-metering.js';
import { config } from '../config.js';

export async function enrichLayerWebhookRoutes(app: FastifyInstance) {
  app.post('/v1/webhooks/enrichlayer/email', async (req, reply) => {
    // Missing nonce → nothing to do, stop EnrichLayer retries immediately.
    const nonce = ((req.query as Record<string, unknown>)?.nonce as string | undefined)?.trim();
    if (!nonce) {
      return reply.code(200).send({ ignored: true });
    }

    // Null/missing body cannot be processed; return 200 to stop retries.
    const rawBody = req.body;
    if (rawBody === null || rawBody === undefined) {
      req.log.warn({ nonce }, '[enrichlayer-webhook] null/missing body — ignoring');
      return reply.code(200).send({ ignored: true });
    }

    // Option C: single-region lookup (v1 limitation documented above).
    const regions = listRuntimeRegions();
    if (regions.length === 0) {
      req.log.warn('[enrichlayer-webhook] no runtime regions configured — ignoring');
      return reply.code(200).send({ ignored: true });
    }
    const runtimePool = runtimePoolFor(regions[0]);

    // Locate the pending lookup row by nonce.
    let lookupRow: {
      id: string;
      app_id: string;
      user_id: string;
      normalized_url: string;
    } | null = null;

    try {
      const find = await runtimePool.query<{
        id: string;
        app_id: string;
        user_id: string;
        normalized_url: string;
      }>(
        `SELECT id, app_id, user_id, normalized_url
           FROM enrichlayer_email_lookups
           WHERE nonce = $1`,
        [nonce],
      );
      if (find.rows.length === 0) {
        req.log.info({ nonce }, '[enrichlayer-webhook] unknown nonce — ignoring');
        return reply.code(200).send({ ignored: true });
      }
      lookupRow = find.rows[0];
    } catch (err) {
      req.log.error({ err, nonce }, '[enrichlayer-webhook] DB nonce lookup failed — ignoring');
      return reply.code(200).send({ ignored: true });
    }

    // Parse email from the vendor payload.  Defensive multi-field lookup covers
    // common EnrichLayer response shapes (exact field name unverified live).
    const body = rawBody as Record<string, unknown>;
    const email: string | null =
      (body?.email as string | null | undefined) ??
      (body?.work_email as string | null | undefined) ??
      ((body?.result as Record<string, unknown> | null)?.email as string | null | undefined) ??
      null;

    // Credit cost: prefer the vendor header; fall back to config default.
    const rawHeaderCredits = req.headers['x-enrichlayer-credit-cost'];
    const headerCredits =
      typeof rawHeaderCredits === 'string' ? parseInt(rawHeaderCredits, 10) : NaN;
    const credits =
      Number.isFinite(headerCredits) && headerCredits >= 0
        ? headerCredits
        : config.enrichlayer.emailLookupCredits;

    // Atomic idempotent claim: the AND status='pending' predicate guarantees only
    // one concurrent webhook call transitions the row.  0 rows returned → already
    // claimed; return immediately without charging credits again.
    let claimed: boolean;
    try {
      const claim = await runtimePool.query<{ status: string }>(
        `UPDATE enrichlayer_email_lookups
           SET status = $1, email = $2, credits_consumed = $3, resolved_at = now()
           WHERE id = $4 AND status = 'pending'
           RETURNING status`,
        [email ? 'resolved' : 'failed', email, credits, lookupRow.id],
      );
      claimed = claim.rows.length > 0;
    } catch (err) {
      req.log.error({ err, nonce }, '[enrichlayer-webhook] claim UPDATE failed — ignoring');
      return reply.code(200).send({ ignored: true });
    }

    if (!claimed) {
      // Already claimed by a concurrent or prior webhook delivery.
      req.log.info({ nonce }, '[enrichlayer-webhook] nonce already claimed — ignoring');
      return reply.code(200).send({ ignored: true });
    }

    // Charge credits only when the lookup succeeded (email found).
    // v1 limitation: key_type is not stored on the lookup row, so BYOK users
    // who used email-lookup will also have credits deducted here.  Acceptable
    // for v1 since BYOK is uncommon for async email-lookup; track as a TODO.
    const pricing = getEnrichLayerPricing();
    const usdCost = email ? credits * pricing.usdPerCredit : 0;
    let usdCharged = 0;

    if (usdCost > 0) {
      try {
        usdCharged = await deductCreditsBalance(app.controlDb, lookupRow.user_id, usdCost);
        await incrementUsage(lookupRow.user_id, 'enrichlayer_credits', credits, lookupRow.app_id);
      } catch (err) {
        req.log.error({ err, nonce }, '[enrichlayer-webhook] credit metering failed — continuing');
        // Don't fail the webhook over a metering error; the row is already claimed.
      }
    }

    // Write an audit row.  Hardcode key_type='platform' (v1 limitation — no
    // key_type on enrichlayer_email_lookups; see comment above).
    try {
      await runtimePool.query(
        `INSERT INTO enrichlayer_usage_logs
           (app_id, user_id, action, credits_consumed, usd_cost, usd_charged,
            key_type, request_id, response_status, linkedin_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          lookupRow.app_id,
          lookupRow.user_id,
          'profile_email_resolved',
          credits,
          usdCost,
          usdCharged,
          'platform',
          null,
          200,
          lookupRow.normalized_url,
        ],
      );
    } catch (err) {
      req.log.error({ err, nonce }, '[enrichlayer-webhook] audit log write failed — continuing');
      // Don't fail the webhook over an audit-log write failure.
    }

    return reply.code(200).send({ ok: true });
  });
}
