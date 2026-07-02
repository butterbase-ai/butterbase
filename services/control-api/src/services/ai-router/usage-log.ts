import type pg from 'pg';
import type { RouterName } from './normalize.js';
import { incrementUsage } from '../usage-metering.js';
import { resolveOrgFromApp } from '../app-org-resolver.js';

export interface AiUsageRow {
  appId: string | null;
  userId: string | null;
  model: string;             // canonical id
  router: RouterName;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  providerCostUsd: number;
  chargedCreditsUsd: number;
  markupPct: number;
  fallbackChain: string[];   // router_name:reason entries from upstream fallbacks
  leaseId: string | null;
  keyType: 'platform' | 'byok';
  chargedToUser: boolean;
  /** Tokens served from the Anthropic prompt cache (read hit). Defaults to 0. */
  cacheReadInputTokens?: number;
  /** Tokens written into the Anthropic prompt cache. Defaults to 0. */
  cacheCreationInputTokens?: number;
  /** Reasoning tokens consumed by thinking/reasoning models (e.g. o1, claude thinking). Null when not applicable. */
  reasoningTokens?: number;
}

/**
 * Writes one row to ai_usage_logs (runtime-plane).
 * Caller passes the runtime pool — typically resolved via getRuntimeDbForApp.
 * Fire-and-forget posture preserved by the caller (catch + log).
 *
 * Legacy `provider` and `cost_usd` columns populated for one release; dropped in 067.
 */
export async function writeAiUsageRow(runtimePool: pg.Pool, row: AiUsageRow): Promise<void> {
  const organizationId = row.appId ? await resolveOrgFromApp(runtimePool, row.appId) : null;
  await runtimePool.query(
    `INSERT INTO ai_usage_logs (
       app_id, user_id, model, provider, prompt_tokens, completion_tokens, total_tokens,
       cost_usd, key_type, charged_to_user, request_metadata,
       router, provider_cost_usd, charged_credits_usd, markup_pct, fallback_chain, lease_id,
       cache_read_input_tokens, cache_creation_input_tokens, reasoning_tokens, organization_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [
      row.appId,
      row.userId,
      row.model,
      row.router,              // provider column = router name (legacy)
      row.promptTokens,
      row.completionTokens,
      row.totalTokens,
      row.chargedCreditsUsd,   // cost_usd = charged_credits_usd for back-compat
      row.keyType,
      row.chargedToUser,
      JSON.stringify({ user_id: row.userId }),
      row.router,
      row.providerCostUsd,
      row.chargedCreditsUsd,
      row.markupPct,
      row.fallbackChain,
      row.leaseId,
      row.cacheReadInputTokens ?? 0,
      row.cacheCreationInputTokens ?? 0,
      row.reasoningTokens ?? null,
      organizationId,
    ]
  );

  // Fan the call into usage_meters via the Redis hot path. Meter against
  // the caller (row.userId), not apps.owner_id — that join misses app-less
  // gateway calls (app_id = NULL) and calls against apps the caller does
  // not own, both of which are still billed via credit_leases.
  if (row.chargedToUser && row.userId) {
    void incrementUsage(row.userId, 'ai_tokens', row.totalTokens, row.appId ?? undefined);
  }
}
