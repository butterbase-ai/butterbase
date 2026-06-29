// services/control-api/src/routes/people-webhook.ts
// Receiver for async People email-lookup callbacks.
//
// People POSTs to POST /v1/webhooks/people/email?nonce=<nonce>
// when an async email lookup completes.  The nonce is the security gate —
// this route carries NO auth header by design.
//
// ALWAYS returns HTTP 200 (with a JSON body) so People stops retrying.
//   { ok: true }                  — claim succeeded; credits charged, audit row written.
//   { ok: true, billing: 'deferred' } — claim succeeded but post-claim billing/audit threw.
//   { ignored: true }             — unknown/already-claimed nonce, null body, or any error.
//
// Cross-region limitation (v1, Option C):
//   people_email_lookups rows live in the runtime DB tier.  This receiver
//   queries only the first configured runtime region (listRuntimeRegions()[0]).
//   Multi-region dispatch will require a control-plane nonce index (Option B).
//
// Email-field fallback chain (vendor shape unverified against live traffic):
//   body.email → body.work_email → body.result.email → null
//
// Credit-cost source:
//   x-enrichlayer-credit-cost header (if present and finite >= 0)
//   → config.people.emailLookupCredits (default: 1)

import type { FastifyInstance } from 'fastify';
import { listRuntimeRegions, runtimePoolFor } from '../services/runtime-pool-registry.js';
import { getPeoplePricing } from '../services/people/pricing.js';
import { deductCreditsBalance, incrementUsage } from '../services/usage-metering.js';
import { config } from '../config.js';

export async function peopleWebhookRoutes(app: FastifyInstance) {
  app.post('/v1/webhooks/people/email', async (req, reply) => {
    if (!config.people.enabled) {
      return reply.code(200).send({ ignored: true });  // People must see 200s
    }

    // Missing nonce → nothing to do, stop People retries immediately.
    const nonce = ((req.query as Record<string, unknown>)?.nonce as string | undefined)?.trim();
    if (!nonce) {
      return reply.code(200).send({ ignored: true });
    }

    // Null/missing body cannot be processed; return 200 to stop retries.
    const rawBody = req.body;
    if (rawBody === null || rawBody === undefined) {
      req.log.warn({ nonce }, '[people-webhook] null/missing body — ignoring');
      return reply.code(200).send({ ignored: true });
    }

    // Option C: single-region lookup (v1 limitation documented above).
    const regions = listRuntimeRegions();
    if (regions.length === 0) {
      req.log.warn('[people-webhook] no runtime regions configured — ignoring');
      return reply.code(200).send({ ignored: true });
    }

    // Fix 1: runtimePoolFor can throw (uninitialized pool, misconfigured region).
    // Wrap it so a throw returns 200 before any idempotent claim fires — stopping
    // People retries without leaving a dangling pending row.
    let runtimePool: ReturnType<typeof runtimePoolFor>;
    try {
      runtimePool = runtimePoolFor(regions[0]);
    } catch (err) {
      req.log.error({ err }, '[people-webhook] runtimePoolFor failed — ignoring');
      return reply.code(200).send({ ignored: true });
    }

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
           FROM people_email_lookups
           WHERE nonce = $1`,
        [nonce],
      );
      if (find.rows.length === 0) {
        req.log.info({ nonce }, '[people-webhook] unknown nonce — ignoring');
        return reply.code(200).send({ ignored: true });
      }
      lookupRow = find.rows[0];
    } catch (err) {
      req.log.error({ err, nonce }, '[people-webhook] DB nonce lookup failed — ignoring');
      return reply.code(200).send({ ignored: true });
    }

    // Parse email from the vendor payload.  Defensive multi-field lookup covers
    // common People response shapes (exact field name unverified live).
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
        : config.people.emailLookupCredits;

    // Atomic idempotent claim: the AND status='pending' predicate guarantees only
    // one concurrent webhook call transitions the row.  0 rows returned → already
    // claimed; return immediately without charging credits again.
    // RETURNING key_type so the post-claim block can skip billing for BYOK rows.
    let claimed: boolean;
    let claimedRow: { status: string; key_type: string } | null = null;
    try {
      const claim = await runtimePool.query<{ status: string; key_type: string }>(
        `UPDATE people_email_lookups
           SET status = $1, email = $2, credits_consumed = $3, resolved_at = now()
           WHERE id = $4 AND status = 'pending'
           RETURNING status, key_type`,
        [email ? 'resolved' : 'failed', email, credits, lookupRow.id],
      );
      claimed = claim.rows.length > 0;
      claimedRow = claim.rows[0] ?? null;
    } catch (err) {
      req.log.error({ err, nonce }, '[people-webhook] claim UPDATE failed — ignoring');
      return reply.code(200).send({ ignored: true });
    }

    if (!claimed || !claimedRow) {
      // Already claimed by a concurrent or prior webhook delivery.
      req.log.info({ nonce }, '[people-webhook] nonce already claimed — ignoring');
      return reply.code(200).send({ ignored: true });
    }

    // Post-claim billing + audit.  If anything here throws AFTER the claim the row
    // is already resolved — we must still return 200 so People stops retrying.
    // The deferred response lets a repair job scan resolved rows with no audit entry.
    try {
      const pricing = getPeoplePricing();

      // BYOK users pay People directly; skip Butterbase credit deduction.
      const usdCost = email && claimedRow.key_type === 'platform'
        ? pricing.usdPerCredit * credits
        : 0;
      let usdCharged = 0;

      if (usdCost > 0) {
        usdCharged = await deductCreditsBalance(app.controlDb, lookupRow.user_id, usdCost);
        await incrementUsage(lookupRow.user_id, 'people_credits', credits, lookupRow.app_id);
      }

      // Audit row.  Use actual key_type from the lookup row (not hardcoded 'platform').
      await runtimePool.query(
        `INSERT INTO people_usage_logs
           (app_id, user_id, action, credits_consumed, usd_cost, usd_charged,
            key_type, request_id, response_status, linkedin_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          lookupRow.app_id,
          lookupRow.user_id,
          email ? 'profile_email_resolved' : 'profile_email_failed',
          credits,
          usdCost,
          usdCharged,
          claimedRow.key_type,
          null,
          200,
          lookupRow.normalized_url,
        ],
      );
    } catch (err) {
      req.log.error(
        { err, nonce, lookup_id: lookupRow.id, app_id: lookupRow.app_id, user_id: lookupRow.user_id },
        '[people-webhook] post-claim billing/audit failed — deferred',
      );
      return reply.code(200).send({ ok: true, billing: 'deferred' });
    }

    return reply.code(200).send({ ok: true });
  });
}
