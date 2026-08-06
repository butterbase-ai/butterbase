// services/control-api/src/routes/people-webhook.ts
// Receiver for async People email-lookup callbacks.
//
// People POSTs to POST /v1/webhooks/people/email?nonce=<nonce>
// when an async email lookup completes.  The nonce is the security gate —
// this route carries NO auth header by design.
//
// Responses — 200 means "settled, stop retrying":
//   { ok: true }                  — claim succeeded; credits charged, audit row written.
//   { ok: true, billing: 'deferred' } — claim succeeded but post-claim billing/audit threw.
//   { ignored: true }             — unknown/already-claimed nonce, null body, or a fault
//                                   that a retry cannot fix.
//   503                           — a runtime region was unreadable, so "unknown nonce"
//                                   could not be established.  Ask the provider to redeliver
//                                   rather than silently drop a resolvable callback.
//
// Multi-region dispatch:
//   people_email_lookups rows live in the runtime DB of the app's OWN region, so
//   this receiver probes every region in listRuntimeRegions() until the nonce is
//   found.  Nonces are 32 random bytes, so the first hit owns the row.
//
// Email-field fallback chain (vendor shape unverified against live traffic):
//   body.email → body.work_email → body.result.email → null
//
// Credit-cost source:
//   config.people.providers[slot].creditCostHeader (per-slot header name, if present and finite >= 0)
//   → config.people.providers[slot].fallbackCreditsPerAction (default: 1)

import type { FastifyInstance } from 'fastify';
import { listRuntimeRegions, runtimePoolFor } from '../services/runtime-pool-registry.js';
import { getPeoplePricing } from '../services/people/pricing.js';
import { deductCreditsBalance, incrementUsage } from '../services/usage-metering.js';
import { config } from '../config.js';
import type { ProviderSlot } from '../services/people/types.js';

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

    const regions = listRuntimeRegions();
    if (regions.length === 0) {
      req.log.warn('[people-webhook] no runtime regions configured — ignoring');
      return reply.code(200).send({ ignored: true });
    }

    // Probe every runtime region for the nonce, not just the first.
    // people_email_lookups rows are written to the runtime DB of the app's OWN
    // region, so a single-region probe strands every lookup belonging to an app
    // homed anywhere else: the nonce is never found, we answer 200, the provider
    // treats the callback as delivered, and the row stays 'pending' forever.
    // Nonces are 32 random bytes, so the first region reporting a hit owns it.
    interface LookupRow {
      id: string;
      app_id: string;
      user_id: string;
      organization_id: string;
      normalized_url: string;
      provider_slot: string;
    }

    const SELECT_BY_NONCE = `SELECT id, app_id, user_id, organization_id, normalized_url, provider_slot
           FROM people_email_lookups
           WHERE nonce = $1`;

    let runtimePool: ReturnType<typeof runtimePoolFor> | null = null;
    let lookupRow: LookupRow | null = null;
    // Tracks regions we could not read.  A region that errored may well hold the
    // nonce, so "not found" is only trustworthy once every region answered.
    let unreadableRegion = false;

    for (const region of regions) {
      // runtimePoolFor throws on a misconfigured/uninitialized region. That is a
      // deployment fault rather than a transient one — retrying will not fix it,
      // so skip the region without forcing the provider into a retry loop.
      let pool: ReturnType<typeof runtimePoolFor>;
      try {
        pool = runtimePoolFor(region);
      } catch (err) {
        req.log.error({ err, region }, '[people-webhook] runtimePoolFor failed — skipping region');
        continue;
      }

      try {
        const find = await pool.query<LookupRow>(SELECT_BY_NONCE, [nonce]);
        if (find.rows.length > 0) {
          runtimePool = pool;
          lookupRow = find.rows[0];
          break;
        }
      } catch (err) {
        // Transient read failure: we genuinely do not know if this region holds
        // the nonce, so we must not conclude "unknown" from its silence.
        unreadableRegion = true;
        req.log.error({ err, nonce, region }, '[people-webhook] DB nonce lookup failed — region inconclusive');
      }
    }

    if (!lookupRow || !runtimePool) {
      if (unreadableRegion) {
        // Answering 200 here would discard a resolvable callback exactly the way
        // the cross-region bug did.  503 asks the provider to deliver it again.
        req.log.warn({ nonce }, '[people-webhook] nonce unresolved with an unreadable region — asking for retry');
        return reply.code(503).send({ error: 'lookup_unavailable' });
      }
      req.log.info({ nonce }, '[people-webhook] unknown nonce in every region — ignoring');
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

    // Resolve slot and parse credit count from the inbound header BEFORE the claim
    // UPDATE so we can write the real value in a single atomic operation.
    const slot = (lookupRow.provider_slot as ProviderSlot) ?? 'primary';
    const providerCfg = config.people.providers[slot];
    if (!providerCfg?.creditCostHeader && !providerCfg?.apiKey) {
      console.error(`[people-webhook] slot=${slot} has no configured provider; charging fallback`);
    }
    const creditHeader = providerCfg?.creditCostHeader;
    const rawHeaderCredits = creditHeader
      ? req.headers[creditHeader.toLowerCase()]
      : undefined;
    const headerCredits =
      typeof rawHeaderCredits === 'string' ? parseInt(rawHeaderCredits, 10) : NaN;
    const credits =
      Number.isFinite(headerCredits) && headerCredits >= 0
        ? headerCredits
        : (providerCfg?.fallbackCreditsPerAction ?? 1);

    // Atomic idempotent claim: the AND status='pending' predicate guarantees only
    // one concurrent webhook call transitions the row.  0 rows returned → already
    // claimed; return immediately without charging credits again.
    // credits_consumed is written with the real value in a single UPDATE.
    // RETURNING key_type + provider_slot for use in the post-claim billing block.
    let claimed: boolean;
    let claimedRow: { status: string; key_type: string; provider_slot: string } | null = null;
    try {
      const claim = await runtimePool.query<{ status: string; key_type: string; provider_slot: string }>(
        `UPDATE people_email_lookups
           SET status = $1, email = $2, credits_consumed = $3, resolved_at = now()
           WHERE id = $4 AND status = 'pending'
           RETURNING status, key_type, provider_slot`,
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
    // slot, providerCfg, and credits are already resolved above.
    try {
      const pricing = getPeoplePricing(slot);

      // BYOK users pay People directly; skip Butterbase credit deduction.
      const usdCost = email && claimedRow.key_type === 'platform'
        ? pricing.usdPerCredit * credits
        : 0;
      let usdCharged = 0;

      // Bill the org stamped on the lookup row at queue time — the app's owning
      // org.  deductCreditsBalance keys on organizations.id, so passing a user id
      // matches zero rows and silently charges nothing for every team org.
      const organizationId = lookupRow.organization_id;

      if (usdCost > 0) {
        usdCharged = await deductCreditsBalance(app.controlDb, organizationId, usdCost);
        await incrementUsage(organizationId, lookupRow.user_id, 'people_credits', credits, lookupRow.app_id);
      }

      // Audit row.  Use actual key_type from the lookup row (not hardcoded 'platform').
      await runtimePool.query(
        `INSERT INTO people_usage_logs
           (app_id, organization_id, user_id, action, credits_consumed, usd_cost, usd_charged,
            key_type, request_id, response_status, linkedin_url, provider_slot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          lookupRow.app_id,
          organizationId,
          lookupRow.user_id,
          email ? 'profile_email_resolved' : 'profile_email_failed',
          credits,
          usdCost,
          usdCharged,
          claimedRow.key_type,
          null,
          200,
          lookupRow.normalized_url,
          slot,
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
