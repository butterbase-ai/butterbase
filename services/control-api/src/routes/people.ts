// services/control-api/src/routes/people.ts
// People sync routes: search, profile (with cache), email queue, BYOK.
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { requireUserId } from '../utils/require-auth.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { resolveOrgFromApp } from '../services/app-org-resolver.js';
import { getPeopleAdapter } from '../services/people/registry.js';
import { getPeoplePricing } from '../services/people/pricing.js';
import { normalizeLinkedinUrl } from '../services/people/url.js';
import { lookupCachedProfile, writeCachedProfile } from '../services/people/cache.js';
// BYOK disabled per product decision — kept commented for easy re-enable:
// import { encryptByok, decryptByok } from '../services/people/byok-crypto.js';
import {
  getCreditsBalance,
  deductCreditsBalance,
  incrementUsage,
} from '../services/usage-metering.js';
import { resolveOrganizationId } from '../services/org-resolver.js';
import { config } from '../config.js';
import { PeopleError, PeopleProviderError } from '../services/people/types.js';
import type { ProviderSlot, SearchPersonRequest, SearchCompanyRequest } from '../services/people/types.js';
import { resolveSlot } from '../services/people/routing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set x-people-* response headers on every reply path. */
function setPeopleHeaders(reply: FastifyReply, p: {
  slot: ProviderSlot;
  creditsConsumed: number;
  usdCharged: number;
  cached?: boolean;
}) {
  reply.header('x-people-provider', p.slot);
  reply.header('x-people-credits-consumed', String(p.creditsConsumed));
  reply.header('x-people-usd-charged', p.usdCharged.toFixed(6));
  if (p.cached !== undefined) reply.header('x-people-cached', String(p.cached));
}

/**
 * Assert that the authenticated user owns the given app.
 * Returns { ok: true } on success, or a reply descriptor on failure.
 */
async function assertAppOwnership(
  runtimeDb: pg.Pool,
  appId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; reply: { code: number; body: { error: string; message?: string } } }> {
  const r = await runtimeDb.query<{ owner_id: string }>(
    'SELECT owner_id FROM apps WHERE id = $1',
    [appId],
  );
  if (r.rows.length === 0) {
    return { ok: false, reply: { code: 404, body: { error: 'app_not_found' } } };
  }
  if (r.rows[0].owner_id !== userId) {
    return { ok: false, reply: { code: 403, body: { error: 'forbidden' } } };
  }
  return { ok: true };
}

interface AuditParams {
  appId: string;
  userId: string;
  action: string;
  creditsConsumed: number;
  usdCost: number;
  usdCharged: number;
  keyType: 'platform' | 'byok';
  requestId: string | null;
  status: number;
  linkedinUrl: string | null;
  providerSlot: ProviderSlot;
}

async function writeAuditRow(runtime: pg.Pool, p: AuditParams): Promise<void> {
  const organizationId = await resolveOrgFromApp(runtime, p.appId);
  await runtime.query(
    `INSERT INTO people_usage_logs
       (app_id, organization_id, user_id, action, credits_consumed, usd_cost, usd_charged, key_type, request_id, response_status, linkedin_url, provider_slot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      p.appId, organizationId, p.userId, p.action,
      p.creditsConsumed, p.usdCost, p.usdCharged,
      p.keyType, p.requestId, p.status, p.linkedinUrl,
      p.providerSlot,
    ],
  );
}

/**
 * Map PeopleError to an HTTP response. 5xx upstream → 502.
 * All other errors re-throw to the global handler.
 */
function sendPeopleError(err: unknown, reply: any): boolean {
  if (err instanceof PeopleError) {
    const code = err.status >= 500 ? 502 : err.status;
    reply.code(code).send({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Route module
// ---------------------------------------------------------------------------

export async function peopleRoutes(app: FastifyInstance) {
  // ── POST /v1/:appId/people/search/person ─────────────────────────────
  app.post('/v1/:appId/people/search/person', async (request, reply) => {
    if (!config.people.enabled) {
      return reply.code(503).send({ error: 'people_disabled', message: 'People integration is not enabled on this deployment' });
    }
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);

    const slot = resolveSlot('search_person');
    const adapter = getPeopleAdapter(slot);
    if (!adapter) {
      setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
      return reply.code(503).send({ error: 'provider_not_registered', slot });
    }
    const providerCfg = config.people.providers[slot];

    const runtime = await getRuntimeDbForApp(app.controlDb, appId);

    const ownerCheck = await assertAppOwnership(runtime, appId, userId);
    if (!ownerCheck.ok) return reply.code(ownerCheck.reply.code).send(ownerCheck.reply.body);

    const pricing = getPeoplePricing(slot);

    // Balance gate — skip if this slot charges $0 per credit
    if (pricing.usdPerCredit > 0) {
      const bal = await getCreditsBalance(app.controlDb, userId);
      if (bal.totalUsd < config.people.minBalanceUsd) {
        setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
        return reply.code(402).send({ error: 'insufficient_credits' });
      }
    }

    try {
      const body = request.body as SearchPersonRequest;
      const result = await adapter.searchPerson(body, { apiKey: providerCfg.apiKey });

      const usdCost = result.creditsConsumed * pricing.usdPerCredit;
      let usdCharged = 0;
      if (usdCost > 0) {
        usdCharged = await deductCreditsBalance(app.controlDb, userId, usdCost);
        const organizationId = await resolveOrganizationId(app.controlDb, userId);
        await incrementUsage(organizationId, 'people_credits', result.creditsConsumed, appId);
      }

      await writeAuditRow(runtime, {
        appId, userId, action: 'search_person',
        creditsConsumed: result.creditsConsumed, usdCost, usdCharged,
        keyType: 'platform', requestId: result.requestId,
        status: result.status, linkedinUrl: null,
        providerSlot: slot,
      });

      setPeopleHeaders(reply, { slot, creditsConsumed: result.creditsConsumed, usdCharged });
      return reply.send({ data: result.data, usage: { creditsConsumed: result.creditsConsumed, usdCharged } });
    } catch (err) {
      if (err instanceof PeopleProviderError) {
        if (err.code === 'action_unsupported_by_slot') {
          request.log.error({ err, slot }, '[people] action_unsupported_by_slot — operator misconfiguration');
          setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
          return reply.code(503).send({ error: 'provider_action_unsupported', slot });
        }
      }
      if (err instanceof PeopleError) {
        await writeAuditRow(runtime, {
          appId, userId, action: 'search_person_error',
          creditsConsumed: 0, usdCost: 0, usdCharged: 0,
          keyType: 'platform', requestId: null,
          status: err.status, linkedinUrl: null,
          providerSlot: slot,
        }).catch(() => {});
      }
      setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
      if (sendPeopleError(err, reply)) return;
      throw err;
    }
  });

  // ── POST /v1/:appId/people/search/company ────────────────────────────
  app.post('/v1/:appId/people/search/company', async (request, reply) => {
    if (!config.people.enabled) {
      return reply.code(503).send({ error: 'people_disabled', message: 'People integration is not enabled on this deployment' });
    }
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);

    const slot = resolveSlot('search_company');
    const adapter = getPeopleAdapter(slot);
    if (!adapter) {
      setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
      return reply.code(503).send({ error: 'provider_not_registered', slot });
    }
    const providerCfg = config.people.providers[slot];

    const runtime = await getRuntimeDbForApp(app.controlDb, appId);

    const ownerCheck = await assertAppOwnership(runtime, appId, userId);
    if (!ownerCheck.ok) return reply.code(ownerCheck.reply.code).send(ownerCheck.reply.body);

    const pricing = getPeoplePricing(slot);

    if (pricing.usdPerCredit > 0) {
      const bal = await getCreditsBalance(app.controlDb, userId);
      if (bal.totalUsd < config.people.minBalanceUsd) {
        setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
        return reply.code(402).send({ error: 'insufficient_credits' });
      }
    }

    try {
      const body = request.body as SearchCompanyRequest;
      const result = await adapter.searchCompany(body, { apiKey: providerCfg.apiKey });

      const usdCost = result.creditsConsumed * pricing.usdPerCredit;
      let usdCharged = 0;
      if (usdCost > 0) {
        usdCharged = await deductCreditsBalance(app.controlDb, userId, usdCost);
        const organizationId = await resolveOrganizationId(app.controlDb, userId);
        await incrementUsage(organizationId, 'people_credits', result.creditsConsumed, appId);
      }

      await writeAuditRow(runtime, {
        appId, userId, action: 'search_company',
        creditsConsumed: result.creditsConsumed, usdCost, usdCharged,
        keyType: 'platform', requestId: result.requestId,
        status: result.status, linkedinUrl: null,
        providerSlot: slot,
      });

      setPeopleHeaders(reply, { slot, creditsConsumed: result.creditsConsumed, usdCharged });
      return reply.send({ data: result.data, usage: { creditsConsumed: result.creditsConsumed, usdCharged } });
    } catch (err) {
      if (err instanceof PeopleProviderError) {
        if (err.code === 'action_unsupported_by_slot') {
          request.log.error({ err, slot }, '[people] action_unsupported_by_slot — operator misconfiguration');
          setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
          return reply.code(503).send({ error: 'provider_action_unsupported', slot });
        }
      }
      if (err instanceof PeopleError) {
        await writeAuditRow(runtime, {
          appId, userId, action: 'search_company_error',
          creditsConsumed: 0, usdCost: 0, usdCharged: 0,
          keyType: 'platform', requestId: null,
          status: err.status, linkedinUrl: null,
          providerSlot: slot,
        }).catch(() => {});
      }
      setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
      if (sendPeopleError(err, reply)) return;
      throw err;
    }
  });

  // ── POST /v1/:appId/people/profile ───────────────────────────────────
  app.post('/v1/:appId/people/profile', async (request, reply) => {
    if (!config.people.enabled) {
      return reply.code(503).send({ error: 'people_disabled', message: 'People integration is not enabled on this deployment' });
    }
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);

    const slot = resolveSlot('get_profile');
    const adapter = getPeopleAdapter(slot);
    if (!adapter) {
      setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
      return reply.code(503).send({ error: 'provider_not_registered', slot });
    }
    const providerCfg = config.people.providers[slot];

    const body = request.body as { linkedinProfileUrl: string; liveFetch?: 'force' };

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeLinkedinUrl(body.linkedinProfileUrl);
    } catch {
      return reply.code(400).send({ error: 'invalid_linkedin_url' });
    }

    const runtime = await getRuntimeDbForApp(app.controlDb, appId);

    const ownerCheck = await assertAppOwnership(runtime, appId, userId);
    if (!ownerCheck.ok) return reply.code(ownerCheck.reply.code).send(ownerCheck.reply.body);

    // Cache-first (unless force-live)
    if (body.liveFetch !== 'force') {
      const cached = await lookupCachedProfile(runtime, appId, normalizedUrl);
      if (cached) {
        await writeAuditRow(runtime, {
          appId, userId, action: 'profile_cache_hit',
          creditsConsumed: 0, usdCost: 0, usdCharged: 0,
          keyType: 'platform', requestId: null, status: 200,
          linkedinUrl: normalizedUrl,
          providerSlot: slot,
        });
        setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0, cached: true });
        return reply.send({
          data: cached.payload,
          status: cached.status,
          usage: { creditsConsumed: 0, usdCharged: 0, cached: true },
        });
      }
    }

    const pricing = getPeoplePricing(slot);

    // Balance gate — skip if this slot charges $0 per credit
    if (pricing.usdPerCredit > 0) {
      const bal = await getCreditsBalance(app.controlDb, userId);
      if (bal.totalUsd < config.people.minBalanceUsd) {
        setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
        return reply.code(402).send({ error: 'insufficient_credits' });
      }
    }

    try {
      const result = await adapter.getProfile(
        { linkedinProfileUrl: normalizedUrl, liveFetch: body.liveFetch },
        { apiKey: providerCfg.apiKey },
      );

      await writeCachedProfile(
        runtime, appId, normalizedUrl,
        result.notFound ? 'not_found' : 'ok',
        result.data,
        slot,
      );

      const usdCost = result.creditsConsumed * pricing.usdPerCredit;
      let usdCharged = 0;
      if (usdCost > 0) {
        usdCharged = await deductCreditsBalance(app.controlDb, userId, usdCost);
        const organizationId = await resolveOrganizationId(app.controlDb, userId);
        await incrementUsage(organizationId, 'people_credits', result.creditsConsumed, appId);
      }

      await writeAuditRow(runtime, {
        appId, userId, action: 'profile',
        creditsConsumed: result.creditsConsumed, usdCost, usdCharged,
        keyType: 'platform', requestId: result.requestId,
        status: result.status, linkedinUrl: normalizedUrl,
        providerSlot: slot,
      });

      setPeopleHeaders(reply, { slot, creditsConsumed: result.creditsConsumed, usdCharged, cached: false });
      return reply.send({
        data: result.data,
        status: result.notFound ? 'not_found' : 'ok',
        usage: { creditsConsumed: result.creditsConsumed, usdCharged, cached: false },
      });
    } catch (err) {
      if (err instanceof PeopleProviderError) {
        if (err.code === 'action_unsupported_by_slot') {
          request.log.error({ err, slot }, '[people] action_unsupported_by_slot — operator misconfiguration');
          setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
          return reply.code(503).send({ error: 'provider_action_unsupported', slot });
        }
      }
      if (err instanceof PeopleError) {
        await writeAuditRow(runtime, {
          appId, userId, action: 'profile_error',
          creditsConsumed: 0, usdCost: 0, usdCharged: 0,
          keyType: 'platform', requestId: null,
          status: err.status, linkedinUrl: normalizedUrl ?? null,
          providerSlot: slot,
        }).catch(() => {});
      }
      setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
      if (sendPeopleError(err, reply)) return;
      throw err;
    }
  });

  // ── POST /v1/:appId/people/profile/email ─────────────────────────────
  app.post('/v1/:appId/people/profile/email', async (request, reply) => {
    if (!config.people.enabled) {
      return reply.code(503).send({ error: 'people_disabled', message: 'People integration is not enabled on this deployment' });
    }
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);

    const slot = resolveSlot('queue_email_lookup');
    const adapter = getPeopleAdapter(slot);
    if (!adapter) {
      setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
      return reply.code(503).send({ error: 'provider_not_registered', slot });
    }
    const providerCfg = config.people.providers[slot];

    if (!providerCfg.webhookHostUrl) {
      setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
      return reply.code(503).send({
        error: 'people_unavailable',
        message: 'People webhook host URL is not configured; async email lookups are disabled',
      });
    }

    const body = request.body as { linkedinProfileUrl: string };

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeLinkedinUrl(body.linkedinProfileUrl);
    } catch {
      return reply.code(400).send({ error: 'invalid_linkedin_url' });
    }

    const runtime = await getRuntimeDbForApp(app.controlDb, appId);

    const ownerCheck = await assertAppOwnership(runtime, appId, userId);
    if (!ownerCheck.ok) return reply.code(ownerCheck.reply.code).send(ownerCheck.reply.body);

    const pricing = getPeoplePricing(slot);

    if (pricing.usdPerCredit > 0) {
      const bal = await getCreditsBalance(app.controlDb, userId);
      if (bal.totalUsd < config.people.minBalanceUsd) {
        setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
        return reply.code(402).send({ error: 'insufficient_credits' });
      }
    }

    let lookupId: string | undefined;
    try {
      const nonce = crypto.randomBytes(32).toString('hex');

      // Insert the pending row BEFORE calling the adapter.
      const organizationId = await resolveOrgFromApp(runtime, appId);
      const lookupRow = await runtime.query<{ id: string }>(
        `INSERT INTO people_email_lookups (app_id, organization_id, user_id, normalized_url, nonce, key_type, provider_slot, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending') RETURNING id`,
        [appId, organizationId, userId, normalizedUrl, nonce, 'platform', slot],
      );
      lookupId = lookupRow.rows[0].id;

      const callbackUrl = `${providerCfg.webhookHostUrl}/v1/webhooks/people/email?nonce=${nonce}`;
      const result = await adapter.queueEmailLookup(
        { linkedinProfileUrl: normalizedUrl, callbackUrl },
        { apiKey: providerCfg.apiKey },
      );

      // Queue-accept typically costs 0 credits; charge only if non-zero
      const usdCost = result.creditsConsumed * pricing.usdPerCredit;
      let usdCharged = 0;
      if (usdCost > 0) {
        usdCharged = await deductCreditsBalance(app.controlDb, userId, usdCost);
        const organizationId = await resolveOrganizationId(app.controlDb, userId);
        await incrementUsage(organizationId, 'people_credits', result.creditsConsumed, appId);
      }

      await writeAuditRow(runtime, {
        appId, userId, action: 'profile_email_queue',
        creditsConsumed: result.creditsConsumed, usdCost, usdCharged,
        keyType: 'platform', requestId: result.requestId,
        status: result.status, linkedinUrl: normalizedUrl,
        providerSlot: slot,
      });

      setPeopleHeaders(reply, { slot, creditsConsumed: result.creditsConsumed, usdCharged });
      return reply.send({ lookupId, status: 'pending', usage: { creditsConsumed: result.creditsConsumed } });
    } catch (err) {
      // Clean up the orphan pending row on adapter failure.
      if (lookupId) {
        await runtime.query(
          'DELETE FROM people_email_lookups WHERE id = $1 AND status = $2',
          [lookupId, 'pending'],
        ).catch(() => {});  // swallow — don't mask original error
      }
      if (err instanceof PeopleProviderError) {
        if (err.code === 'action_unsupported_by_slot') {
          request.log.error({ err, slot }, '[people] action_unsupported_by_slot — operator misconfiguration');
          setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
          return reply.code(503).send({ error: 'provider_action_unsupported', slot });
        }
      }
      if (err instanceof PeopleError) {
        await writeAuditRow(runtime, {
          appId, userId, action: 'profile_email_error',
          creditsConsumed: 0, usdCost: 0, usdCharged: 0,
          keyType: 'platform', requestId: null,
          status: err.status, linkedinUrl: normalizedUrl ?? null,
          providerSlot: slot,
        }).catch(() => {});
      }
      setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
      if (sendPeopleError(err, reply)) return;
      throw err;
    }
  });

  // ── GET /v1/:appId/people/email-lookup/:id ──────────────────────────
  app.get('/v1/:appId/people/email-lookup/:id', async (request, reply) => {
    if (!config.people.enabled) {
      return reply.code(503).send({ error: 'people_disabled', message: 'People integration is not enabled on this deployment' });
    }
    const userId = requireUserId(request);
    const { appId, id } = request.params as { appId: string; id: string };

    const runtime = await getRuntimeDbForApp(app.controlDb, appId);

    const ownerCheck = await assertAppOwnership(runtime, appId, userId);
    if (!ownerCheck.ok) return reply.code(ownerCheck.reply.code).send(ownerCheck.reply.body);

    const r = await runtime.query<{
      status: string;
      email: string | null;
      credits_consumed: number | null;
      provider_slot: string;
    }>(
      `SELECT status, email, credits_consumed, provider_slot FROM people_email_lookups WHERE id = $1 AND app_id = $2`,
      [id, appId],
    );

    if (r.rows.length === 0) {
      return reply.code(404).send({ error: 'lookup_not_found' });
    }

    const row = r.rows[0];
    // Read the slot from the row; set informational headers (no provider call in this route)
    const slot = (row.provider_slot as ProviderSlot) ?? 'primary';
    setPeopleHeaders(reply, { slot, creditsConsumed: 0, usdCharged: 0 });
    return reply.send({
      status: row.status,
      email: row.email,
      credits_consumed: row.credits_consumed,
    });
  });

  // ── BYOK routes disabled per product decision ────────────────────────────
  // Kept here (commented) so the routes can be re-enabled without recreating
  // the handler bodies. `encryptByok` / `decryptByok` / the `apps.people_
  // byok_key_encrypted` column are retained for the same reason. The MCP
  // tool's `set_byok_key` / `clear_byok_key` actions are also disabled in
  // services/mcp-server/src/tools/manage-people.ts.
  //
  // app.put('/v1/:appId/people/byok', async (request, reply) => {
  //   ...
  // });
  //
  // app.delete('/v1/:appId/people/byok', async (request, reply) => {
  //   ...
  // });
}
