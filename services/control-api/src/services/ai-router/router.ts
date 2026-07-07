import type pg from 'pg';
import type { Redis } from 'ioredis';
import { readCatalogEntry, readEnabledRouters } from './catalog.js';
import { rankRoutersForModel, rankRoutersPresenceMode, estimateWorstCaseUsd, pickStickyRouter } from './select.js';
import {
  createStickyBindingsFromRedis,
  hashCacheablePrefix,
  prefixKey,
  sessionKey,
  ttlSecondsFor,
  type StickyBindings,
} from './sticky-bindings.js';
import { config } from '../../config.js';
import { estimatePromptTokens } from './tokenizer.js';
import { applyMarkup } from './markup.js';
import { acquireForEstimatedCost, settleAfterCall, leaseTtlSeconds, InsufficientCreditsError } from './billing-gate.js';
import { writeAiUsageRow } from './usage-log.js';
import { pickProviderCost } from './adapters/openrouter.js';
import { logAuditEvent } from '../audit/audit-events-service.js';
import { maybeTriggerAutoRefill } from '../auto-refill-service.js';
import { maybeSendCreditsEmail } from '../credits-email.js';
import { sendBillingEmail } from '../auth/email-service.js';
import { AdapterError, type RouterAdapter, type AdapterResult, type AdapterUsage, type ChatCompletionRequest, type EmbeddingRequest, type VideoGenerationRequest, type VideoSubmitResult, type VideoPollResult } from './adapters/types.js';
import type { RouterName } from './normalize.js';

const FALLBACK_KINDS: ReadonlySet<string> = new Set(['transport', 'rate_limit', 'model_not_available', 'unknown']);

/**
 * Non-fatal post-settle hook: reads the user's current credits balance
 * (monthly allowance + topup) and lets credits-email decide whether to
 * fire credits_low / credits_exhausted. Dedup-guarded inside
 * maybeSendCreditsEmail via columns on platform_users.
 */
/**
 * Wraps acquireForEstimatedCost so that an InsufficientCreditsError also
 * emits a billing/denied audit event. The audit_events.app_id column is
 * NOT NULL, so we only record when the router was invoked from an app
 * context (gateway-level user calls without an app are skipped).
 */
export async function acquireWithAudit(
  ctx: RouteContext,
  reservedUsd: number,
  ttlSeconds: number,
): Promise<ReturnType<typeof acquireForEstimatedCost>> {
  try {
    return await acquireForEstimatedCost(
      ctx.platformPool, ctx.userId, ctx.organizationId, ctx.region, reservedUsd, ttlSeconds,
    );
  } catch (err) {
    if (err instanceof InsufficientCreditsError && ctx.appId) {
      try {
        await logAuditEvent(ctx.runtimePool, {
          appId: ctx.appId,
          category: 'billing',
          eventType: 'ai_insufficient_credits',
          action: 'denied',
          resourceType: 'ai_request',
          actorType: 'platform_user',
          actorId: ctx.userId,
          success: false,
          errorMessage: err.message,
          eventData: {
            required_usd: err.requiredUsd,
            available_usd: err.availableUsd,
            region: ctx.region,
            // auto_refill state is not in scope here; omitted to avoid
            // extra SELECTs in the hot reject path.
            auto_refill: { enabled: null, amount_usd: null },
          },
        });
      } catch (auditErr) {
        console.warn('audit: ai_insufficient_credits write failed', auditErr);
      }
    }
    throw err;
  }
}

export async function maybeFireCreditsEmail(pool: pg.Pool, userId: string): Promise<void> {
  try {
    const r = await pool.query<{ monthly_allowance_usd: string; credits_usd: string }>(
      `SELECT o.monthly_allowance_usd::text, o.credits_usd::text
         FROM platform_users pu
         JOIN organizations o ON o.id = pu.personal_organization_id
        WHERE pu.id = $1`,
      [userId],
    );
    if (r.rows.length === 0) return;
    const postBalance = parseFloat(r.rows[0].monthly_allowance_usd ?? '0')
      + parseFloat(r.rows[0].credits_usd ?? '0');
    await maybeSendCreditsEmail({
      db: pool,
      userId,
      postBalance,
      sendBillingEmail: (to, template, data) =>
        sendBillingEmail(to, template as any, data),
      resetDate: null,
    });
  } catch (err) {
    console.warn('[router] credits-email: maybeSendCreditsEmail failed (non-fatal):', err);
  }
}

export interface RouteContext {
  platformPool: pg.Pool;
  runtimePool: pg.Pool;
  redis: Redis;
  adapters: Map<RouterName, RouterAdapter>;
  markupPct: number;
  appId: string | null;
  organizationId: string;
  userId: string;
  region: string;
  /**
   * Optional injection point for tests. When omitted, the router builds a
   * StickyBindings from `redis` lazily inside routeChatCompletion.
   */
  stickyBindings?: StickyBindings;
}

export interface RouteChatResult {
  status: number;
  stream?: ReadableStream<Uint8Array>;
  body?: unknown;
  chosen?: RouterName;
}

export class RouterError extends Error {
  constructor(
    public readonly code: 'MODEL_NOT_FOUND' | 'NO_ROUTERS_AVAILABLE' | 'ROUTER_FALLBACK_EXHAUSTED' | 'WRONG_MODALITY',
    public readonly statusCode: number,
    message: string,
    // Internal-only — router names and failure kinds. Never surface to clients;
    // used for logs/Sentry/metrics. Public responses must scrub this field.
    public readonly attempted?: string[]
  ) {
    super(message);
    this.name = 'RouterError';
  }
}

export async function routeChatCompletion(ctx: RouteContext, req: ChatCompletionRequest): Promise<RouteChatResult> {
  const t0 = Date.now();
  const canonicalId = req.model;
  const entry = await readCatalogEntry(ctx.redis, canonicalId);
  if (!entry) {
    throw new RouterError('MODEL_NOT_FOUND', 404, `Model not found: ${canonicalId}`);
  }
  const enabledStatuses = await readEnabledRouters(ctx.redis);
  const enabled = new Set<string>(enabledStatuses.filter(r => r.enabled).map(r => r.name));
  const ranker = config.aiRouter.presenceModeEnabled ? rankRoutersPresenceMode : rankRoutersForModel;
  const ranked = ranker(entry, enabled);
  if (ranked.length === 0) {
    throw new RouterError('NO_ROUTERS_AVAILABLE', 502, 'Model is temporarily unavailable. Please try again or use a different model.');
  }

  const promptTokens = estimatePromptTokens(req.messages as any, canonicalId);
  const maxTokens = req.max_tokens ?? 4096;
  const worstUsd = estimateWorstCaseUsd(ranked[0], promptTokens, maxTokens);
  const reservedUsd = worstUsd * (1 + ctx.markupPct / 100);

  const lease = await acquireWithAudit(ctx, reservedUsd, leaseTtlSeconds(maxTokens));

  // ---- Sticky binding lookup ------------------------------------------------
  // Conversations pinned to a specific router via session_id (preferred) or a
  // prefix hash (when cache_control is present) stay on that router for the
  // TTL — preserves prompt-cache continuity across turns. On pinned-router
  // failure we delete the binding so the next turn re-picks fresh.
  const stickyBindings: StickyBindings = ctx.stickyBindings
    ?? createStickyBindingsFromRedis(ctx.redis as any);
  let bindingKey: string | null = null;
  let pinned: RouterName | null = null;
  if (req.session_id) {
    bindingKey = sessionKey(req.session_id);
    pinned = await stickyBindings.get(bindingKey);
  } else if (req.cache_control) {
    bindingKey = prefixKey(hashCacheablePrefix(req));
    pinned = await stickyBindings.get(bindingKey);
  }

  const stickyChoice = pickStickyRouter(ranked.map(r => r.name), pinned);
  const orderedCandidates = stickyChoice
    ? [
        ranked.find(r => r.name === stickyChoice)!,
        ...ranked.filter(r => r.name !== stickyChoice),
      ]
    : ranked;

  const fallbackChain: string[] = [];
  let result: AdapterResult | null = null;
  let chosenRouter: RouterName | null = null;
  let lastError: unknown = null;

  for (const candidate of orderedCandidates) {
    const adapter = ctx.adapters.get(candidate.name);
    if (!adapter) {
      fallbackChain.push(`${candidate.name}:no_adapter`);
      continue;
    }
    try {
      const upstreamId = candidate.upstreamId ?? adapter.toUpstreamId(canonicalId);
      result = await adapter.chatCompletion(req, upstreamId);
      chosenRouter = candidate.name;
      // Write/refresh the sticky binding on success so subsequent turns in
      // the same session/prefix-context land back on this router for cache
      // continuity. Best-effort: a KV failure here must not fail the call.
      if (bindingKey && (req.session_id || req.cache_control)) {
        try {
          await stickyBindings.set(bindingKey, candidate.name, ttlSecondsFor(req));
        } catch (e) {
          console.warn('[router] sticky set failed:', e);
        }
      }
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof AdapterError && FALLBACK_KINDS.has(err.kind)) {
        // If the failing candidate was the sticky pin, drop the binding before
        // falling through so the next conversation turn re-picks fresh.
        if (candidate.name === pinned && bindingKey) {
          try { await stickyBindings.delete(bindingKey); } catch (e) { console.warn('[router] sticky delete failed:', e); }
          pinned = null;
        }
        fallbackChain.push(`${candidate.name}:${err.kind}`);
        continue;
      }
      // Non-fallback error (auth, bad_request) — release lease + rethrow.
      // Do NOT touch the sticky binding; the upstream wasn't a routing failure.
      await settleAfterCall(ctx.platformPool, lease, 0);
      throw err;
    }
  }

  if (!result || !chosenRouter) {
    await settleAfterCall(ctx.platformPool, lease, 0);
    const err = new RouterError('ROUTER_FALLBACK_EXHAUSTED', 502, 'Model is temporarily unavailable. Please try again or use a different model.', fallbackChain);
    (err as any).cause = lastError;
    throw err;
  }

  // Streaming: wrap so we can parse usage after [DONE] and settle.
  if (result.stream) {
    const wrapped = wrapStreamForSettlement(result.stream, async (usage, providerCost) => {
      const cost = providerCost ?? estimateWorstCaseUsd(ranked[0], usage.promptTokens, usage.completionTokens, usage.cacheReadInputTokens ?? 0, usage.cacheCreationInputTokens ?? 0);
      const chargedCredits = applyMarkup(cost, ctx.markupPct);
      await settleAfterCall(ctx.platformPool, lease, chargedCredits);
      maybeTriggerAutoRefill(
        { pool: ctx.platformPool, redis: ctx.redis },
        ctx.organizationId,
      ).catch((err) => console.error('[router] auto-refill check failed:', err));
      maybeFireCreditsEmail(ctx.platformPool, ctx.userId).catch((err) => console.error('[router] credits-email failed:', err));
      writeAiUsageRow(ctx.runtimePool, {
        appId: ctx.appId, organizationId: ctx.organizationId, userId: ctx.userId, model: canonicalId, router: chosenRouter!,
        promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
        totalTokens: usage.promptTokens + usage.completionTokens,
        providerCostUsd: cost, chargedCreditsUsd: chargedCredits,
        markupPct: ctx.markupPct, fallbackChain, leaseId: lease.leaseId,
        keyType: 'platform', chargedToUser: true,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
      }).catch(err => console.error('[router] usage-log write failed:', err));
      const t1 = Date.now();
      console.log(JSON.stringify({
        level: 'info',
        type: 'ai_router.call',
        app_id: ctx.appId,
        user_id: ctx.userId,
        canonical_model: canonicalId,
        chosen_router: chosenRouter,
        fallback_chain: fallbackChain,
        provider_cost_usd: cost,
        charged_credits_usd: chargedCredits,
        markup_pct: ctx.markupPct,
        latency_ms: t1 - t0,
        status: result.status,
      }));
    }, result.costFetcher);
    return { status: result.status, stream: wrapped, chosen: chosenRouter };
  }

  // Non-streaming.
  const usage: AdapterUsage = result.usage ?? { promptTokens: 0, completionTokens: 0, totalCost: null };
  const providerCost = result.providerCostUsd
    ?? estimateWorstCaseUsd(ranked[0], usage.promptTokens, usage.completionTokens, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0);
  const chargedCredits = applyMarkup(providerCost, ctx.markupPct);

  await settleAfterCall(ctx.platformPool, lease, chargedCredits);
  maybeTriggerAutoRefill(
    { pool: ctx.platformPool, redis: ctx.redis },
    ctx.organizationId,
  ).catch((err) => console.error('[router] auto-refill check failed:', err));
  maybeFireCreditsEmail(ctx.platformPool, ctx.userId).catch((err) => console.error('[router] credits-email failed:', err));
  writeAiUsageRow(ctx.runtimePool, {
    appId: ctx.appId, organizationId: ctx.organizationId, userId: ctx.userId, model: canonicalId, router: chosenRouter,
    promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
    totalTokens: usage.promptTokens + usage.completionTokens,
    providerCostUsd: providerCost, chargedCreditsUsd: chargedCredits,
    markupPct: ctx.markupPct, fallbackChain, leaseId: lease.leaseId,
    keyType: 'platform', chargedToUser: true,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  }).catch(err => console.error('[router] usage-log write failed:', err));
  const t1 = Date.now();
  console.log(JSON.stringify({
    level: 'info',
    type: 'ai_router.call',
    app_id: ctx.appId,
    user_id: ctx.userId,
    canonical_model: canonicalId,
    chosen_router: chosenRouter,
    fallback_chain: fallbackChain,
    provider_cost_usd: providerCost,
    charged_credits_usd: chargedCredits,
    markup_pct: ctx.markupPct,
    latency_ms: t1 - t0,
    status: result.status,
  }));

  return { status: result.status, body: result.body, chosen: chosenRouter };
}

interface StreamUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export function wrapStreamForSettlement(
  upstream: ReadableStream<Uint8Array>,
  onComplete: (usage: StreamUsage, providerCostUsd: number | null) => Promise<void>,
  costFetcher?: () => Promise<number | null>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let promptTokens = 0, completionTokens = 0, providerCost: number | null = null;
  let cacheReadInputTokens = 0, cacheCreationInputTokens = 0;
  let lineBuffer = '';

  const settle = async () => {
    // Only invoke costFetcher when the in-stream usage events never carried a cost.
    if (providerCost === null && costFetcher) {
      try { providerCost = await costFetcher(); } catch (e) { console.error('[router] costFetcher:', e); }
    }
    try { await onComplete({ promptTokens, completionTokens, cacheReadInputTokens, cacheCreationInputTokens }, providerCost); }
    catch (e) { console.error('[router] stream settle:', e); }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { await settle(); controller.close(); return; }
          lineBuffer += decoder.decode(value, { stream: true });
          const parts = lineBuffer.split('\n');
          lineBuffer = parts.pop() ?? '';
          for (const line of parts) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data) as any;
              if (parsed.usage) {
                const u = parsed.usage;
                const details = u.prompt_tokens_details;
                const cacheRead = details?.cached_tokens ?? 0;
                const hasImaRouterFields =
                  typeof u.claude_cache_creation_5_m_tokens === 'number' ||
                  typeof u.claude_cache_creation_1_h_tokens === 'number';
                const cacheWrite5m = u.claude_cache_creation_5_m_tokens ?? 0;
                const cacheWrite1h = u.claude_cache_creation_1_h_tokens ?? 0;
                const cacheCreate = hasImaRouterFields
                  ? cacheWrite5m + cacheWrite1h
                  : (details?.cache_write_tokens ?? 0);
                const rawPromptTokens = u.prompt_tokens ?? 0;
                if (rawPromptTokens > 0) {
                  promptTokens = hasImaRouterFields ? rawPromptTokens + cacheRead : rawPromptTokens;
                }
                completionTokens = u.completion_tokens ?? completionTokens;
                cacheReadInputTokens = cacheRead;
                cacheCreationInputTokens = cacheCreate;
                const c = pickProviderCost(u);
                if (c !== null) providerCost = c;
              }
            } catch { /* ignore non-JSON */ }
          }
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
        await settle();
      }
    },
  });
}

export async function routeEmbedding(ctx: RouteContext, req: EmbeddingRequest): Promise<{ status: number; body: unknown }> {
  const t0 = Date.now();
  const canonicalId = req.model;
  const entry = await readCatalogEntry(ctx.redis, canonicalId);
  if (!entry) throw new RouterError('MODEL_NOT_FOUND', 404, `Model not found: ${canonicalId}`);

  const enabledStatuses = await readEnabledRouters(ctx.redis);
  const enabled = new Set<string>(enabledStatuses.filter(r => r.enabled).map(r => r.name));
  const ranker = config.aiRouter.presenceModeEnabled ? rankRoutersPresenceMode : rankRoutersForModel;
  const ranked = ranker(entry, enabled);
  if (ranked.length === 0) throw new RouterError('NO_ROUTERS_AVAILABLE', 502, 'Model is temporarily unavailable. Please try again or use a different model.');

  const inputText = Array.isArray(req.input) ? req.input.join(' ') : req.input;
  const promptTokens = estimatePromptTokens([{ role: 'user', content: inputText }], canonicalId);
  const worstUsd = (promptTokens / 1_000_000) * ranked[0].promptPricePerMtok;
  const reservedUsd = worstUsd * (1 + ctx.markupPct / 100);

  const lease = await acquireWithAudit(ctx, reservedUsd, 60);

  const fallbackChain: string[] = [];
  let result: AdapterResult | null = null;
  let chosenRouter: RouterName | null = null;
  let lastError: unknown = null;

  for (const candidate of ranked) {
    const adapter = ctx.adapters.get(candidate.name);
    if (!adapter || !adapter.embedding) {
      fallbackChain.push(`${candidate.name}:no_embedding`);
      continue;
    }
    try {
      result = await adapter.embedding(req, candidate.upstreamId ?? adapter.toUpstreamId(canonicalId));
      chosenRouter = candidate.name;
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof AdapterError && FALLBACK_KINDS.has(err.kind)) {
        fallbackChain.push(`${candidate.name}:${err.kind}`);
        continue;
      }
      await settleAfterCall(ctx.platformPool, lease, 0);
      throw err;
    }
  }

  if (!result || !chosenRouter) {
    await settleAfterCall(ctx.platformPool, lease, 0);
    const err = new RouterError('ROUTER_FALLBACK_EXHAUSTED', 502, 'Model is temporarily unavailable. Please try again or use a different model.', fallbackChain);
    (err as any).cause = lastError;
    throw err;
  }

  const usage: AdapterUsage = result.usage ?? { promptTokens: 0, completionTokens: 0, totalCost: null };
  const providerCost = result.providerCostUsd
    ?? estimateWorstCaseUsd(ranked[0], usage.promptTokens, 0, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0);
  const chargedCredits = applyMarkup(providerCost, ctx.markupPct);

  await settleAfterCall(ctx.platformPool, lease, chargedCredits);
  maybeTriggerAutoRefill(
    { pool: ctx.platformPool, redis: ctx.redis },
    ctx.organizationId,
  ).catch((err) => console.error('[router] auto-refill check failed:', err));
  maybeFireCreditsEmail(ctx.platformPool, ctx.userId).catch((err) => console.error('[router] credits-email failed:', err));
  writeAiUsageRow(ctx.runtimePool, {
    appId: ctx.appId, organizationId: ctx.organizationId, userId: ctx.userId, model: canonicalId, router: chosenRouter,
    promptTokens: usage.promptTokens, completionTokens: 0,
    totalTokens: usage.promptTokens,
    providerCostUsd: providerCost, chargedCreditsUsd: chargedCredits,
    markupPct: ctx.markupPct, fallbackChain, leaseId: lease.leaseId,
    keyType: 'platform', chargedToUser: true,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  }).catch(err => console.error('[router] usage-log write failed:', err));
  const t1 = Date.now();
  console.log(JSON.stringify({
    level: 'info',
    type: 'ai_router.call',
    app_id: ctx.appId,
    user_id: ctx.userId,
    canonical_model: canonicalId,
    chosen_router: chosenRouter,
    fallback_chain: fallbackChain,
    provider_cost_usd: providerCost,
    charged_credits_usd: chargedCredits,
    markup_pct: ctx.markupPct,
    latency_ms: t1 - t0,
    status: result.status,
  }));

  return { status: result.status, body: result.body };
}

/**
 * Safety-net estimate for video generation used when no parseable
 * duration-based SKU exists in the model's raw_pricing (e.g. Seedance which
 * prices per video-token). Most calls instead use a per-model estimate
 * computed from `raw_pricing.pricing_skus` via `estimateVideoCostUsd`. $3.0
 * is intentionally generous to ensure the lease always covers worst-case
 * cost for unknown models; unused credit is refunded on settle.
 */
const VIDEO_DEFAULT_ESTIMATE_USD = 3.0;

/**
 * Video jobs may take several minutes. We hold the lease for 15 minutes;
 * if the customer never polls back, the lease auto-expires per
 * credit_leases.expires_at — credits are returned to the user.
 */
const VIDEO_LEASE_TTL_SECONDS = 15 * 60;

/**
 * Estimate the worst-case credit-cost (in USD, pre-markup) of a video job from
 * the catalog's raw pricing payload. Used to size the credit lease.
 *
 * Strategy: pick the MAXIMUM rate among all SKU keys containing
 * `duration_seconds` and multiply by the requested duration (default 10s if
 * unspecified — most providers cap there). Apply a 20% buffer. Fall back to
 * VIDEO_DEFAULT_ESTIMATE_USD when no parseable duration-based SKU exists
 * (e.g. Seedance which prices per video-token).
 *
 * Clamped to [$0.05, $9] so a bad SKU value can't lock up an absurd reservation.
 */
/**
 * Compute USD/sec for one router's rawPricing payload, given the request's
 * resolution + visual-input mode. Returns null when the router has no
 * usable per-second or duration-keyed pricing — so callers can skip and try
 * the next router.
 */
function ratePerSecondFromRouter(
  rawPricing: unknown,
  req: VideoGenerationRequest,
): number | null {
  const rp = rawPricing as
    | {
        pricing_skus?: Record<string, string>;
        unit?: string;
        variants?: Array<{ spec: string; pricePerSecond: number; visualInput?: boolean }>;
      }
    | null
    | undefined;

  // OpenRouter shape: pricing_skus with `duration_seconds_*` keys.
  // No resolution split is encoded — take max across keys (historical behavior).
  const skus = rp?.pricing_skus;
  if (skus && typeof skus === 'object') {
    const durationRates: number[] = [];
    for (const [key, val] of Object.entries(skus)) {
      if (!key.includes('duration_seconds')) continue;
      const rate = parseFloat(val);
      if (Number.isFinite(rate) && rate > 0) durationRates.push(rate);
    }
    if (durationRates.length > 0) return Math.max(...durationRates);
  }

  // Per-second variant shape: rawPricing.unit === 'second', variants[].
  // Variants may carry a `visualInput` flag for per-mode pricing. Filter
  // by resolution + mode for fair billing; fall back to max-rate when no
  // narrower match exists. Variants without the flag (legacy ImaRouter
  // snapshot) match any mode — they're treated as "rate applies to either".
  if (rp?.unit === 'second' && Array.isArray(rp.variants)) {
    const variants = rp.variants
      .filter(v => Number.isFinite(v.pricePerSecond) && v.pricePerSecond > 0);
    if (variants.length > 0) {
      const requestedRes = (req.resolution ?? '').toLowerCase();
      const isVisual = (req.input_images?.length ?? 0) > 0
                    || (req.input_references?.length ?? 0) > 0;

      // 1) Exact match on resolution AND visualInput (when flag present).
      let candidates = requestedRes
        ? variants.filter(v => v.spec.toLowerCase() === requestedRes
            && (v.visualInput === undefined || v.visualInput === isVisual))
        : [];
      // 2) Resolution-only match.
      if (candidates.length === 0 && requestedRes) {
        candidates = variants.filter(v => v.spec.toLowerCase() === requestedRes);
      }
      // 3) visualInput-only narrowing when no resolution given.
      if (candidates.length === 0 && !requestedRes) {
        candidates = variants.filter(v => v.visualInput === undefined || v.visualInput === isVisual);
      }
      // 4) Max across all.
      if (candidates.length === 0) candidates = variants;

      return Math.max(...candidates.map(v => v.pricePerSecond));
    }
  }

  return null;
}

/**
 * Lease-sizing buffer: pad the catalog estimate by this factor so the
 * reservation covers minor SKU drift between snapshot and upstream actuals.
 * Applied only at submit time; settle uses the un-buffered rate.
 */
const VIDEO_LEASE_BUFFER = 1.2;

function clampVideoCost(ratePerSecond: number, req: VideoGenerationRequest, withBuffer: boolean): number {
  const seconds = req.duration ?? 10;
  const raw = ratePerSecond * seconds * (withBuffer ? VIDEO_LEASE_BUFFER : 1);
  return Math.min(Math.max(raw, 0.05), 9); // clamp [$0.05, $9]
}

/**
 * Pick the rate-per-second to use, scanning all routers' rawPricing.
 * Returns null when no router has a parseable pricing shape.
 *
 * When `preferRouter` is provided, that router's pricing is used directly
 * (settle-time semantics — bill against the actual upstream that served
 * the request). When omitted, the function returns the MAX rate across
 * all routers (submit-time semantics — size the lease for any router the
 * fallback chain might land on).
 */
function resolveRateForRequest(
  entry: import('./catalog.js').CatalogEntry,
  req: VideoGenerationRequest,
  preferRouter: RouterName | undefined,
): number | null {
  if (preferRouter) {
    const r = entry.routers.find(x => x.name === preferRouter);
    const rate = r ? ratePerSecondFromRouter(r.rawPricing, req) : null;
    if (rate !== null) return rate;
    // Preferred router has no pricing — fall through to global scan.
  }
  let best: number | null = null;
  for (const router of entry.routers) {
    const rate = ratePerSecondFromRouter(router.rawPricing, req);
    if (rate !== null && (best === null || rate > best)) best = rate;
  }
  return best;
}

/**
 * Estimate worst-case USD cost for a video request — used at submit time
 * to size the credit lease. Pads the rate by VIDEO_LEASE_BUFFER (1.2×) so
 * the reservation covers minor pricing drift; unused credit refunds on settle.
 *
 * Scans all routers' rawPricing and returns the MAX. Falls back to
 * VIDEO_DEFAULT_ESTIMATE_USD ($3) only when no router has parseable pricing.
 */
export function estimateVideoCostUsd(
  entry: import('./catalog.js').CatalogEntry,
  req: VideoGenerationRequest,
): number {
  const rate = resolveRateForRequest(entry, req, undefined);
  if (rate !== null) return clampVideoCost(rate, req, /*withBuffer*/ true);
  return VIDEO_DEFAULT_ESTIMATE_USD;
}

/**
 * Compute settled billing cost for a completed video job — used at poll
 * time when the upstream's `providerCostUsd` is unavailable. Pins to the
 * chosen router's pricing variants (so a 480p text-to-video request bills
 * at the 480p text rate, not the worst-case 1080p rate) and does NOT apply
 * the lease buffer (this is the exact bill, not a reservation estimate).
 *
 * Returns null when neither the chosen router nor any sibling has parseable
 * pricing — the caller can decide whether to charge $0 (safer for goodwill)
 * or fall back to VIDEO_DEFAULT_ESTIMATE_USD (safer for revenue).
 */
export function billedVideoCostUsd(
  entry: import('./catalog.js').CatalogEntry,
  req: VideoGenerationRequest,
  chosenRouter: RouterName,
): number | null {
  const rate = resolveRateForRequest(entry, req, chosenRouter);
  return rate !== null ? clampVideoCost(rate, req, /*withBuffer*/ false) : null;
}

export interface RouteVideoSubmitResult {
  upstreamJobId: string;
  pollingUrl: string;
  chosenRouter: RouterName;
  leaseId: string;
  estimatedCostUsd: number;
}

export async function routeVideoSubmit(
  ctx: RouteContext,
  req: VideoGenerationRequest,
): Promise<RouteVideoSubmitResult> {
  const canonicalId = req.model;
  const entry = await readCatalogEntry(ctx.redis, canonicalId);
  if (!entry) throw new RouterError('MODEL_NOT_FOUND', 404, `Model not found: ${canonicalId}`);
  if (!entry.routers.some(r => r.modality === 'video')) {
    throw new RouterError('WRONG_MODALITY', 400, `Model ${canonicalId} is not a video model. Use /chat/completions instead.`);
  }

  const enabledStatuses = await readEnabledRouters(ctx.redis);
  const enabled = new Set<string>(enabledStatuses.filter(r => r.enabled).map(r => r.name));
  const ranker = config.aiRouter.presenceModeEnabled ? rankRoutersPresenceMode : rankRoutersForModel;
  const ranked = ranker(entry, enabled);
  if (ranked.length === 0) {
    throw new RouterError('NO_ROUTERS_AVAILABLE', 502, 'Model is temporarily unavailable. Please try again or use a different model.');
  }

  const estimatedUsd = estimateVideoCostUsd(entry, req);
  const reservedUsd = estimatedUsd * (1 + ctx.markupPct / 100);
  const lease = await acquireWithAudit(ctx, reservedUsd, VIDEO_LEASE_TTL_SECONDS);

  const fallbackChain: string[] = [];
  let submitted: { result: VideoSubmitResult; router: RouterName } | null = null;
  let lastError: unknown = null;

  for (const candidate of ranked) {
    const adapter = ctx.adapters.get(candidate.name);
    if (!adapter?.submitVideo) {
      fallbackChain.push(`${candidate.name}:no_video_adapter`);
      continue;
    }
    try {
      const result = await adapter.submitVideo(req, candidate.upstreamId ?? adapter.toUpstreamId(canonicalId));
      submitted = { result, router: candidate.name };
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof AdapterError && FALLBACK_KINDS.has(err.kind)) {
        fallbackChain.push(`${candidate.name}:${err.kind}`);
        continue;
      }
      await settleAfterCall(ctx.platformPool, lease, 0);
      throw err;
    }
  }

  if (!submitted) {
    await settleAfterCall(ctx.platformPool, lease, 0);
    const err = new RouterError('ROUTER_FALLBACK_EXHAUSTED', 502, 'Model is temporarily unavailable. Please try again or use a different model.', fallbackChain);
    (err as any).cause = lastError;
    throw err;
  }

  return {
    upstreamJobId: submitted.result.upstreamJobId,
    pollingUrl: submitted.result.pollingUrl,
    chosenRouter: submitted.router,
    leaseId: lease.leaseId,
    estimatedCostUsd: estimatedUsd,
  };
}

export async function routeVideoPoll(
  ctx: RouteContext,
  router: RouterName,
  pollingUrl: string,
): Promise<VideoPollResult> {
  const adapter = ctx.adapters.get(router);
  if (!adapter?.pollVideo) {
    throw new RouterError('NO_ROUTERS_AVAILABLE', 502, 'Provider for this job is no longer available.');
  }
  return adapter.pollVideo(pollingUrl);
}

/**
 * Called by the route handler when a job first observes a terminal status.
 * Settles the lease against actual provider cost and writes the usage row.
 *
 * NOT idempotent — call exactly once per terminal poll. The caller (the route
 * handler in routes/ai-videos.ts) is responsible for gating this on the
 * atomic terminal-state transition in video-jobs.ts.
 */
export async function settleVideoJob(
  ctx: RouteContext,
  args: {
    leaseId: string;
    chosenRouter: RouterName;
    canonicalModel: string;
    providerCostUsd: number;
    fallbackChain?: string[];
  },
): Promise<{ chargedCreditsUsd: number; providerCostUsd: number }> {
  const chargedCredits = applyMarkup(args.providerCostUsd, ctx.markupPct);
  // settleAfterCall only reads handle.leaseId; the other LeaseHandle fields are
  // not consulted, so a synthetic handle is safe here.
  await settleAfterCall(
    ctx.platformPool,
    { leaseId: args.leaseId, amountGrantedUsd: 0, expiresAt: new Date() },
    chargedCredits,
  );
  maybeTriggerAutoRefill(
    { pool: ctx.platformPool, redis: ctx.redis },
    ctx.organizationId,
  ).catch((err) => console.error('[router] auto-refill check failed:', err));
  maybeFireCreditsEmail(ctx.platformPool, ctx.userId).catch(
    (err) => console.error('[router] credits-email failed:', err),
  );
  writeAiUsageRow(ctx.runtimePool, {
    appId: ctx.appId, organizationId: ctx.organizationId, userId: ctx.userId, model: args.canonicalModel, router: args.chosenRouter,
    promptTokens: 0, completionTokens: 0, totalTokens: 0,
    providerCostUsd: args.providerCostUsd, chargedCreditsUsd: chargedCredits,
    markupPct: ctx.markupPct, fallbackChain: args.fallbackChain ?? [], leaseId: args.leaseId,
    keyType: 'platform', chargedToUser: true,
  }).catch(err => console.error('[router] usage-log write failed:', err));
  console.log(JSON.stringify({
    level: 'info',
    type: 'ai_router.call',
    app_id: ctx.appId,
    user_id: ctx.userId,
    canonical_model: args.canonicalModel,
    chosen_router: args.chosenRouter,
    fallback_chain: args.fallbackChain ?? [],
    provider_cost_usd: args.providerCostUsd,
    charged_credits_usd: chargedCredits,
    markup_pct: ctx.markupPct,
    modality: 'video',
  }));
  return { chargedCreditsUsd: chargedCredits, providerCostUsd: args.providerCostUsd };
}

export { InsufficientCreditsError } from './billing-gate.js';
