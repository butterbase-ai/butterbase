// services/control-api/src/routes/enrichlayer.ts
// EnrichLayer sync routes: search, profile (with cache), email queue, credit-balance, BYOK.
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireUserId } from '../utils/require-auth.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { getEnrichLayerAdapter } from '../services/enrichlayer/registry.js';
import { getEnrichLayerPricing } from '../services/enrichlayer/pricing.js';
import { normalizeLinkedinUrl } from '../services/enrichlayer/url.js';
import { lookupCachedProfile, writeCachedProfile } from '../services/enrichlayer/cache.js';
import { encryptByok, decryptByok } from '../services/enrichlayer/byok-crypto.js';
import {
  getCreditsBalance,
  deductCreditsBalance,
  incrementUsage,
} from '../services/usage-metering.js';
import { config } from '../config.js';
import { EnrichLayerError } from '../services/enrichlayer/types.js';
import type { SearchPersonRequest, SearchCompanyRequest } from '../services/enrichlayer/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type KeyType = 'platform' | 'byok';

/**
 * Resolve the API key to use for a given app.
 * Checks the app's runtime DB for a BYOK key first; falls back to the platform key.
 * Returns null when neither is available (→ 503).
 */
async function resolveKey(
  runtime: pg.Pool,
  appId: string,
): Promise<{ apiKey: string; keyType: KeyType } | null> {
  const r = await runtime.query<{ enrichlayer_byok_key_encrypted: string | null }>(
    'SELECT enrichlayer_byok_key_encrypted FROM apps WHERE id = $1',
    [appId],
  );
  if (r.rows.length > 0 && r.rows[0].enrichlayer_byok_key_encrypted) {
    try {
      const apiKey = decryptByok(r.rows[0].enrichlayer_byok_key_encrypted);
      return { apiKey, keyType: 'byok' };
    } catch {
      // Decryption failure — fall through to platform key
    }
  }
  if (config.enrichlayer.apiKey) {
    return { apiKey: config.enrichlayer.apiKey, keyType: 'platform' };
  }
  return null;
}

interface AuditParams {
  appId: string;
  userId: string;
  action: string;
  creditsConsumed: number;
  usdCost: number;
  usdCharged: number;
  keyType: KeyType;
  requestId: string | null;
  status: number;
  linkedinUrl: string | null;
}

async function writeAuditRow(runtime: pg.Pool, p: AuditParams): Promise<void> {
  await runtime.query(
    `INSERT INTO enrichlayer_usage_logs
       (app_id, user_id, action, credits_consumed, usd_cost, usd_charged, key_type, request_id, status, linkedin_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      p.appId, p.userId, p.action,
      p.creditsConsumed, p.usdCost, p.usdCharged,
      p.keyType, p.requestId, p.status, p.linkedinUrl,
    ],
  );
}

/**
 * Map EnrichLayerError to an HTTP response. 5xx upstream → 502.
 * All other errors re-throw to the global handler.
 */
function sendEnrichLayerError(err: unknown, reply: any): boolean {
  if (err instanceof EnrichLayerError) {
    const code = err.status >= 500 ? 502 : err.status;
    reply.code(code).send({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Route module
// ---------------------------------------------------------------------------

export async function enrichLayerRoutes(app: FastifyInstance) {
  // ── POST /v1/:appId/enrichlayer/search/person ─────────────────────────────
  app.post('/v1/:appId/enrichlayer/search/person', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);

    const adapter = getEnrichLayerAdapter();
    if (!adapter) return reply.code(503).send({ error: 'enrichlayer_unavailable' });

    const runtime = await getRuntimeDbForApp(app.controlDb, appId);
    const resolved = await resolveKey(runtime, appId);
    if (!resolved) return reply.code(503).send({ error: 'enrichlayer_unavailable' });

    if (resolved.keyType === 'platform') {
      const bal = await getCreditsBalance(app.controlDb, userId);
      if (bal.totalUsd < config.enrichlayer.minBalanceUsd) {
        return reply.code(402).send({ error: 'insufficient_credits' });
      }
    }

    try {
      const body = request.body as SearchPersonRequest;
      const result = await adapter.searchPerson(body, { apiKey: resolved.apiKey });

      const pricing = getEnrichLayerPricing();
      const usdCost = result.creditsConsumed * pricing.usdPerCredit;
      let usdCharged = 0;
      if (resolved.keyType === 'platform' && usdCost > 0) {
        usdCharged = await deductCreditsBalance(app.controlDb, userId, usdCost);
        await incrementUsage(userId, 'enrichlayer_credits', result.creditsConsumed, appId);
      }

      await writeAuditRow(runtime, {
        appId, userId, action: 'search_person',
        creditsConsumed: result.creditsConsumed, usdCost, usdCharged,
        keyType: resolved.keyType, requestId: result.requestId,
        status: result.status, linkedinUrl: null,
      });

      return reply.send({ data: result.data, usage: { creditsConsumed: result.creditsConsumed, usdCost, usdCharged } });
    } catch (err) {
      if (sendEnrichLayerError(err, reply)) return;
      throw err;
    }
  });

  // ── POST /v1/:appId/enrichlayer/search/company ────────────────────────────
  app.post('/v1/:appId/enrichlayer/search/company', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);

    const adapter = getEnrichLayerAdapter();
    if (!adapter) return reply.code(503).send({ error: 'enrichlayer_unavailable' });

    const runtime = await getRuntimeDbForApp(app.controlDb, appId);
    const resolved = await resolveKey(runtime, appId);
    if (!resolved) return reply.code(503).send({ error: 'enrichlayer_unavailable' });

    if (resolved.keyType === 'platform') {
      const bal = await getCreditsBalance(app.controlDb, userId);
      if (bal.totalUsd < config.enrichlayer.minBalanceUsd) {
        return reply.code(402).send({ error: 'insufficient_credits' });
      }
    }

    try {
      const body = request.body as SearchCompanyRequest;
      const result = await adapter.searchCompany(body, { apiKey: resolved.apiKey });

      const pricing = getEnrichLayerPricing();
      const usdCost = result.creditsConsumed * pricing.usdPerCredit;
      let usdCharged = 0;
      if (resolved.keyType === 'platform' && usdCost > 0) {
        usdCharged = await deductCreditsBalance(app.controlDb, userId, usdCost);
        await incrementUsage(userId, 'enrichlayer_credits', result.creditsConsumed, appId);
      }

      await writeAuditRow(runtime, {
        appId, userId, action: 'search_company',
        creditsConsumed: result.creditsConsumed, usdCost, usdCharged,
        keyType: resolved.keyType, requestId: result.requestId,
        status: result.status, linkedinUrl: null,
      });

      return reply.send({ data: result.data, usage: { creditsConsumed: result.creditsConsumed, usdCost, usdCharged } });
    } catch (err) {
      if (sendEnrichLayerError(err, reply)) return;
      throw err;
    }
  });

  // ── POST /v1/:appId/enrichlayer/profile ───────────────────────────────────
  app.post('/v1/:appId/enrichlayer/profile', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);

    const adapter = getEnrichLayerAdapter();
    if (!adapter) return reply.code(503).send({ error: 'enrichlayer_unavailable' });

    const body = request.body as { linkedinProfileUrl: string; liveFetch?: 'force' };

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeLinkedinUrl(body.linkedinProfileUrl);
    } catch {
      return reply.code(400).send({ error: 'invalid_linkedin_url' });
    }

    const runtime = await getRuntimeDbForApp(app.controlDb, appId);

    // Cache-first (unless force-live)
    if (body.liveFetch !== 'force') {
      const cached = await lookupCachedProfile(runtime, appId, normalizedUrl);
      if (cached) {
        await writeAuditRow(runtime, {
          appId, userId, action: 'profile_cache_hit',
          creditsConsumed: 0, usdCost: 0, usdCharged: 0,
          keyType: 'platform', requestId: null, status: 200,
          linkedinUrl: normalizedUrl,
        });
        return reply.send({
          data: cached.payload,
          status: cached.status,
          usage: { creditsConsumed: 0, usdCost: 0, usdCharged: 0, cached: true },
        });
      }
    }

    // Cache miss — resolve key + balance gate
    const resolved = await resolveKey(runtime, appId);
    if (!resolved) return reply.code(503).send({ error: 'enrichlayer_unavailable' });

    if (resolved.keyType === 'platform') {
      const bal = await getCreditsBalance(app.controlDb, userId);
      if (bal.totalUsd < config.enrichlayer.minBalanceUsd) {
        return reply.code(402).send({ error: 'insufficient_credits' });
      }
    }

    try {
      const result = await adapter.getProfile(
        { linkedinProfileUrl: normalizedUrl, liveFetch: body.liveFetch },
        { apiKey: resolved.apiKey },
      );

      await writeCachedProfile(
        runtime, appId, normalizedUrl,
        result.notFound ? 'not_found' : 'ok',
        result.data,
      );

      const pricing = getEnrichLayerPricing();
      const usdCost = result.creditsConsumed * pricing.usdPerCredit;
      let usdCharged = 0;
      if (resolved.keyType === 'platform' && usdCost > 0) {
        usdCharged = await deductCreditsBalance(app.controlDb, userId, usdCost);
        await incrementUsage(userId, 'enrichlayer_credits', result.creditsConsumed, appId);
      }

      await writeAuditRow(runtime, {
        appId, userId, action: 'profile',
        creditsConsumed: result.creditsConsumed, usdCost, usdCharged,
        keyType: resolved.keyType, requestId: result.requestId,
        status: result.status, linkedinUrl: normalizedUrl,
      });

      return reply.send({
        data: result.data,
        status: result.notFound ? 'not_found' : 'ok',
        usage: { creditsConsumed: result.creditsConsumed, usdCost, usdCharged, cached: false },
      });
    } catch (err) {
      if (sendEnrichLayerError(err, reply)) return;
      throw err;
    }
  });

  // ── POST /v1/:appId/enrichlayer/profile/email ─────────────────────────────
  app.post('/v1/:appId/enrichlayer/profile/email', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);

    const adapter = getEnrichLayerAdapter();
    if (!adapter) return reply.code(503).send({ error: 'enrichlayer_unavailable' });

    const body = request.body as { linkedinProfileUrl: string };

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeLinkedinUrl(body.linkedinProfileUrl);
    } catch {
      return reply.code(400).send({ error: 'invalid_linkedin_url' });
    }

    const runtime = await getRuntimeDbForApp(app.controlDb, appId);
    const resolved = await resolveKey(runtime, appId);
    if (!resolved) return reply.code(503).send({ error: 'enrichlayer_unavailable' });

    if (resolved.keyType === 'platform') {
      const bal = await getCreditsBalance(app.controlDb, userId);
      if (bal.totalUsd < config.enrichlayer.minBalanceUsd) {
        return reply.code(402).send({ error: 'insufficient_credits' });
      }
    }

    try {
      const nonce = crypto.randomBytes(32).toString('hex');

      // Insert the pending row BEFORE calling the adapter
      const lookupRow = await runtime.query<{ id: string }>(
        `INSERT INTO enrichlayer_email_lookups (app_id, user_id, normalized_url, nonce, status)
         VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
        [appId, userId, normalizedUrl, nonce],
      );
      const lookupId = lookupRow.rows[0].id;

      const callbackUrl = `${config.enrichlayer.webhookHostUrl}/v1/webhooks/enrichlayer/email?nonce=${nonce}`;
      const result = await adapter.queueEmailLookup(
        { linkedinProfileUrl: normalizedUrl, callbackUrl },
        { apiKey: resolved.apiKey },
      );

      // Queue-accept typically costs 0 credits; charge only if non-zero
      const pricing = getEnrichLayerPricing();
      const usdCost = result.creditsConsumed * pricing.usdPerCredit;
      let usdCharged = 0;
      if (resolved.keyType === 'platform' && usdCost > 0) {
        usdCharged = await deductCreditsBalance(app.controlDb, userId, usdCost);
        await incrementUsage(userId, 'enrichlayer_credits', result.creditsConsumed, appId);
      }

      await writeAuditRow(runtime, {
        appId, userId, action: 'profile_email_queue',
        creditsConsumed: result.creditsConsumed, usdCost, usdCharged,
        keyType: resolved.keyType, requestId: result.requestId,
        status: result.status, linkedinUrl: normalizedUrl,
      });

      return reply.send({ lookupId, status: 'pending', usage: { creditsConsumed: result.creditsConsumed } });
    } catch (err) {
      if (sendEnrichLayerError(err, reply)) return;
      throw err;
    }
  });

  // ── GET /v1/:appId/enrichlayer/email-lookup/:id ──────────────────────────
  app.get('/v1/:appId/enrichlayer/email-lookup/:id', async (request, reply) => {
    requireUserId(request);
    const { appId, id } = request.params as { appId: string; id: string };

    const runtime = await getRuntimeDbForApp(app.controlDb, appId);

    const r = await runtime.query<{
      status: string;
      email: string | null;
      credits_consumed: number | null;
    }>(
      `SELECT status, email, credits_consumed FROM enrichlayer_email_lookups WHERE id = $1 AND app_id = $2`,
      [id, appId],
    );

    if (r.rows.length === 0) {
      return reply.code(404).send({ error: 'lookup_not_found' });
    }

    const row = r.rows[0];
    return reply.send({
      status: row.status,
      email: row.email,
      credits_consumed: row.credits_consumed,
    });
  });

  // ── GET /v1/:appId/enrichlayer/credit-balance ─────────────────────────────
  app.get('/v1/:appId/enrichlayer/credit-balance', async (request, reply) => {
    requireUserId(request);

    const adapter = getEnrichLayerAdapter();
    if (!adapter) return reply.code(503).send({ error: 'enrichlayer_unavailable' });

    if (!config.enrichlayer.apiKey) {
      return reply.code(503).send({ error: 'enrichlayer_unavailable', message: 'platform key not configured' });
    }

    try {
      const r = await adapter.getCreditBalance({ apiKey: config.enrichlayer.apiKey });
      return reply.send({ balance: r.data.balance });
    } catch (err) {
      if (sendEnrichLayerError(err, reply)) return;
      throw err;
    }
  });

  // ── PUT /v1/:appId/enrichlayer/byok ───────────────────────────────────────
  app.put('/v1/:appId/enrichlayer/byok', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    requireUserId(request);

    const body = request.body as { apiKey: string };
    if (!body?.apiKey || typeof body.apiKey !== 'string') {
      return reply.code(400).send({ error: 'apiKey is required' });
    }

    const encrypted = encryptByok(body.apiKey);
    const runtime = await getRuntimeDbForApp(app.controlDb, appId);
    await runtime.query(
      'UPDATE apps SET enrichlayer_byok_key_encrypted = $1 WHERE id = $2',
      [encrypted, appId],
    );

    return reply.send({ ok: true });
  });

  // ── DELETE /v1/:appId/enrichlayer/byok ────────────────────────────────────
  app.delete('/v1/:appId/enrichlayer/byok', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    requireUserId(request);

    const runtime = await getRuntimeDbForApp(app.controlDb, appId);
    await runtime.query(
      'UPDATE apps SET enrichlayer_byok_key_encrypted = NULL WHERE id = $1',
      [appId],
    );

    return reply.send({ ok: true });
  });
}
